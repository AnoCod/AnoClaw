// Tool — abstract base class for all tools
// Every tool extends this class. Tools are registered with ToolRegistry
// and invoked via the AgentLoop during ReAct execution.

import { RiskLevel, InterruptBehavior } from '../../../shared/types/tool.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { makeResult, makeError, type MakeResultOptions } from './ToolResult.js';

export { RiskLevel, InterruptBehavior };
export type { ToolResult, ExecutionContext };

/** Agent role hierarchy levels: MainAgent=0, Manager=1, Member=2, SubAgent=3 */
const ROLE_LEVEL: Record<string, number> = {
  MainAgent: 0,
  Manager: 1,
  Member: 2,
  SubAgent: 3,
};

/** Check whether the caller's role has permission to use a tool requiring a minimum role */
export function canUseTool(callerRole: string | undefined, minRequiredRole: string): boolean {
  if (!callerRole) return true; // backward-compatible — if role not passed, don't restrict
  const callerLevel = ROLE_LEVEL[callerRole] ?? 99;
  const requiredLevel = ROLE_LEVEL[minRequiredRole] ?? 99;
  return callerLevel <= requiredLevel;
}

// ---------------------------------------------------------------------------
// Tool — abstract base
// ---------------------------------------------------------------------------

export abstract class Tool {
  // ── Static metadata (used for auto-discovery and categorization) ──

  /** Category for UI grouping and system prompt organization. */
  static category: string = 'Uncategorized';

  /** One-line description for tool listings. */
  static toolDescription: string = '';

  // ── Metadata (used for LLM function calling / tool_use) ──

  /** Tool name as sent to the LLM. Must be unique across the registry. */
  abstract name(): string;

  /** Human-readable description shown in LLM system prompt / tool list. */
  abstract description(): string;

  /**
   * Usage guidance injected into the system prompt (separate from the API tool schema).
   * Override to add tool-specific routing hints, best practices, and when-to-use guidance.
   * Default empty — tools without guidance are unaffected.
   */
  prompt(): string { return ''; }

  /**
   * Optional user-facing display name. Falls back to algorithmic conversion
   * of name() (PascalCase → "Title Case") when not overridden.
   */
  displayName?(): string;

  /** JSON Schema of the tool's parameters (OpenAI/Anthropic function-calling format). */
  abstract parametersSchema(): Record<string, unknown>;

  // ── Execution ──

  /**
   * Execute the tool with the given parameters and execution context.
   * Returns a ToolResult (success or error).
   */
  abstract execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult>;

  // ── Safety ──

  /** Risk level for UI permission gating. Default: Safe. */
  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  /** Whether this tool requires user confirmation before execution. */
  requiresConfirmation(_ctx: ExecutionContext): boolean {
    if (this.riskLevel() === RiskLevel.Critical) return true;
    if (this.riskLevel() === RiskLevel.High && !_ctx.userConfirmed) return true;
    return false;
  }

  /** Message shown to the user when confirmation is required. */
  confirmationMessage(_params: Record<string, unknown>): string {
    return `Allow ${this.name()} to execute?`;
  }

  // ── Interrupt behavior ──

  /**
   * What happens when an InterruptController aborts this tool mid-execution.
   * - Cancel: the tool result is discarded; safe to retry
   * - Block: the tool MUST NOT be re-run (destructive side-effects may be partial)
   */
  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  // ── Scheduling ──

  /**
   * If true, this tool does NOT consume a model turn — the LLM call
   * continues processing subsequent tool_use blocks after this tool
   * returns its result inline.
   *
   * Applicable tools: TodoWrite, EnterPlanMode, ExitPlanMode, AskUserQuestion.
   */
  shouldDefer(): boolean {
    return false;
  }

  /**
   * If true, the AgentLoop should pause after this tool returns and wait
   * for the user to respond before continuing. Used by AskUserQuestion.
   */
  requiresUserInteraction(): boolean {
    return false;
  }

  // ── Lifecycle ──

  /** Whether this tool is async (long-running). */
  isAsync(): boolean {
    return false;
  }

  /** Default timeout in ms before the tool is considered stalled. */
  defaultTimeoutMs(): number {
    return 30000;
  }

  // ── Registry helpers ──

  isReadOnly(): boolean { return false; }
  isConcurrencySafe(): boolean { return false; }

  /** Whether this tool has destructive side effects (file writes, deletes, etc).
   *  Default false. Override in WriteTool, EditTool, BashTool, etc. */
  isDestructive(): boolean { return false; }

  /** Minimum agent role required to use this tool. Default is SubAgent = available to everyone. */
  minRole(): string { return 'SubAgent'; }

  /** Maximum number of retries for transient failures. Default: 3. Override to disable (return 0). */
  maxRetries(): number { return 3; }

  /** Maximum output characters before pipeline truncation kicks in. Default: 10000.
   *  Override for tools that need larger or smaller limits (e.g. Read needs 80K). */
  outputLimit(): number { return 10000; }

  /**
   * Parameter names that contain filesystem paths which must be validated
   * against the execution workspace. The pipeline rejects any resolved path
   * outside ctx.workspace. Return [] (default) for tools without file access.
   */
  workspacePathParams(): string[] { return []; }

  // ── UI helpers (Claude Code patterns) ──

  /** Human-readable name shown in UI. Default: this.name() */
  userFacingName(_input?: Record<string, unknown>): string { return this.name(); }

  /** Short summary for compact views (max 50 chars). Default: null */
  getToolUseSummary(input?: Record<string, unknown>): string | null { return null; }

  /** Present-tense activity description like "Reading file", "Searching...". Default: null */
  getActivityDescription(input?: Record<string, unknown>): string | null { return null; }

  /** Classify command for UI collapse: is it a search, read, or neither? */
  isSearchOrRead(): { isSearch: boolean; isRead: boolean } { return { isSearch: false, isRead: false }; }

  /** Truncate a string to max chars, appending '…' if truncated. */
  protected truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
  }

  toOpenAIFunction(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: this.name(),
        description: this.description(),
        parameters: this.parametersSchema(),
      },
    };
  }

  toAnthropicTool(): Record<string, unknown> {
    return {
      name: this.name(),
      description: this.description(),
      input_schema: this.parametersSchema(),
    };
  }

  // ── Utility helpers for subclasses ──

  /** Create a successful ToolResult. */
  protected makeResult(content: string, opts?: MakeResultOptions): ToolResult {
    return makeResult(content, opts);
  }

  /** Create a failure ToolResult. */
  protected makeError(errorMessage: string, opts?: MakeResultOptions): ToolResult {
    return makeError(errorMessage, opts);
  }

  /** Wrap execute() with event emission and timing. Called by ToolRegistry. */
  async _executeWithEvents(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
    toolCallId?: string,
  ): Promise<ToolResult> {
    const startedAt = Date.now();

    // Set a default toolCallId if not provided
    const effectiveToolCallId = toolCallId ?? `${this.name()}-${startedAt}`;

    // Track file state before destructive edits (for withdrawal/rewind)
    if (this.isDestructive()) {
      const pathParams = this.workspacePathParams();
      for (const key of pathParams) {
        const fp = params[key] as string | undefined;
        if (fp) {
          // Lazy-import to avoid circular dependency
          const { getFileHistoryTracker } = await import('../session/FileHistoryTracker.js');
          getFileHistoryTracker(ctx.sessionId).trackEdit(ctx.sessionId, fp).catch(() => {});
        }
      }
    }

    TypedEventBus.emit('tool:executed', {
      toolName: this.name(),
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      params,
    });

    try {
      const result = await this.execute(params, ctx);
      result.toolCallId = result.toolCallId || effectiveToolCallId;
      result.startedAt = result.startedAt || startedAt;
      result.finishedAt = result.finishedAt || Date.now();
      result.durationMs = result.durationMs || (result.finishedAt - result.startedAt);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorResult = this.makeError(errorMessage, {
        startedAt,
        finishedAt: Date.now(),
      });
      errorResult.toolCallId = effectiveToolCallId;

      TypedEventBus.emit('tool:error', {
        toolName: this.name(),
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        error: errorMessage,
      });

      return errorResult;
    }
  }
}
