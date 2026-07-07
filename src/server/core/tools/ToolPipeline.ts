/**
 * ToolPipeline — 5-stage execution pipeline for all tool calls.
 *
 * Every tool call flows through: schema validation → security → execute+hooks
 * → retry → output normalization. Audit events are emitted via TypedEventBus.
 *
 * This replaces ad-hoc per-tool validation/truncation/retry with a single
 * standardized path. Tools need only implement execute() — the pipeline
 * handles the rest.
 *
 * @module ToolPipeline
 */

import type { Tool } from './Tool.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import { InterruptBehavior, RiskLevel } from '../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import { createLogger } from '../logger.js';
import { makeError } from './ToolResult.js';
import * as path from 'path';

// ══════════════════════════════════════════════════════════════
// Configuration constants
// ══════════════════════════════════════════════════════════════

/** Default max output chars for tools that don't specify their own limit */
const DEFAULT_OUTPUT_CHARS = 10000;

/** Head/tail split for truncated output */
const TRUNCATE_HEAD_TAIL = 500;

/** Error patterns that are retryable (transient failures) */
const RETRYABLE_PATTERNS = [
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE/,
  /network|connection|timeout|fetch.*failed|abort|socket/i,
  /rate.?limit|too many requests|busy|overloaded|throttled/i,
  /5\d\d|server.*error|internal.*error|bad gateway|service.*unavailable/i,
];

/** Error patterns that should be shown to the LLM (not retried) */
const USER_VISIBLE_PATTERNS = [
  /ENOENT|no such file|not found/i,
  /EACCES|permission denied|access denied/i,
  /invalid|bad request|malformed/i,
];

// ══════════════════════════════════════════════════════════════

/** Five-stage execution pipeline interfaces. Each stage can short-circuit with a ToolResult. */
export interface PipelineStages {
  /** Stage 0: Zod schema validation. Returns ToolResult if invalid (short-circuits). */
  validateParams(tool: Tool, params: Record<string, unknown>): ToolResult | null;
  /** Stage 1: Security check (role, confirmation). Returns ToolResult if blocked. */
  securityCheck(tool: Tool, params: Record<string, unknown>, ctx: ExecutionContext): ToolResult | null;
  /** Stage 2: Execute — the actual tool call with pre/post hooks */
  execute(tool: Tool, params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult>;
  /** Stage 3: Classify error and retry if appropriate */
  retry(tool: Tool, params: Record<string, unknown>, ctx: ExecutionContext, originalResult: ToolResult): Promise<ToolResult>;
  /** Stage 4: Normalize output size (truncate if oversized).
   * Tools that self-truncate (Bash, Read, Grep) do so before pipeline sees
   * the result, so their outputLimit() values are upper bounds, not additive. */
  normalizeOutput(result: ToolResult, tool: Tool): ToolResult;
}

// ══════════════════════════════════════════════════════════════

/**
 * Static pipeline runner for tool execution.
 * Use ToolPipeline.run() to execute a tool through all five stages.
 */
export class ToolPipeline {
  /** Plan mode state — when active, only read-only tools are allowed. */
  private static _planModeSessions: Set<string> = new Set();
  /** Allowed prompts per session (set by ExitPlanMode, cleared by EnterPlanMode). */
  private static _allowedPrompts: Map<string, Array<{ tool: string; prompt: string }>> = new Map();

  static enterPlanMode(sessionId: string = '__global__'): void { ToolPipeline._planModeSessions.add(sessionId); ToolPipeline._allowedPrompts.delete(sessionId); }
  static exitPlanMode(sessionId: string = '__global__'): void { ToolPipeline._planModeSessions.delete(sessionId); }
  static isPlanMode(sessionId: string = '__global__'): boolean { return ToolPipeline._planModeSessions.has(sessionId); }
  static setAllowedPrompts(sessionId: string, prompts: Array<{ tool: string; prompt: string }>): void { ToolPipeline._allowedPrompts.set(sessionId, prompts); }
  static getAllowedPrompts(sessionId: string): Array<{ tool: string; prompt: string }> { return ToolPipeline._allowedPrompts.get(sessionId) || []; }

  /** Run the complete pipeline and return the final ToolResult. */
  static async run(
    tool: Tool,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
    toolCallId: string,
  ): Promise<ToolResult> {

    // ── Stage 0: Schema Validation ──
    const validationError = ToolPipeline.validateParams(tool, params);
    if (validationError) return validationError;

    // ── Stage 1: Security Check ──
    const securityBlock = ToolPipeline.securityCheck(tool, params, ctx);
    if (securityBlock) return securityBlock;

    // ── Stage 2: Execute ──
    let result = await ToolPipeline.execute(tool, params, ctx, toolCallId);

    // ── Stage 3: Retry (only on transient errors) ──
    if (!result.success) {
      result = await ToolPipeline.retry(tool, params, ctx, result);
    }

    // ── Stage 4: Output Normalization ──
    if (result.success) {
      result = ToolPipeline.normalizeOutput(result, tool);
    }

    return result;
  }

  // ══════════════════════════════════════════════════════════
  // Stage implementations
  // ══════════════════════════════════════════════════════════

  static validateParams(
    tool: Tool,
    params: Record<string, unknown>,
  ): ToolResult | null {
    const schema = tool.parametersSchema() as Record<string, unknown> | undefined;
    if (!schema || !schema.required || !schema.properties) return null;

    const required = schema.required as string[];
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    // Check required fields
    for (const field of required) {
      if (!(field in params) || params[field] === undefined || params[field] === null) {
        return makeError(`Missing required parameter: "${field}"`, { toolCallId: '' });
      }
    }

    // Validate types and constraints
    for (const [key, prop] of Object.entries(properties)) {
      const value = params[key];
      if (value === undefined || value === null) continue; // Skip optional missing fields

      const expectedType = prop.type as string | undefined;
      if (expectedType) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== expectedType) {
          return makeError(
            `Invalid type for parameter "${key}": expected ${expectedType}, got ${actualType}`,
            { toolCallId: '' },
          );
        }
      }

      // Check enum constraints
      if (prop.enum && Array.isArray(prop.enum) && !prop.enum.includes(value)) {
        return makeError(
          `Invalid value for parameter "${key}": "${String(value)}" not in [${prop.enum.join(', ')}]`,
          { toolCallId: '' },
        );
      }
    }

    return null;
  }

  static securityCheck(
    tool: Tool,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): ToolResult | null {
    // Allowed prompts (from ExitPlanMode) bypass all security checks —
    // the user explicitly approved these tool actions during plan review.
    const allowed = ToolPipeline._allowedPrompts.get(ctx.sessionId);
    if (allowed && allowed.some(e => e.tool === tool.name())) {
      return null;
    }

    // Delegate to the tool's own requiresConfirmation() — single source of truth
    if (tool.requiresConfirmation(ctx)) {
      return makeError(
        `Tool "${tool.name()}" requires user confirmation (risk: ${tool.riskLevel()}).`,
        { toolCallId: '' },
      );
    }

    const mode = ctx.mode;

    // Block non-read-only tools in read-only mode
    if (!tool.isReadOnly()) {
      if (mode === 'read_only' || mode === 'readOnly') {
        return makeError(
          `Tool "${tool.name()}" is not read-only; blocked in ${mode} mode.`,
          { toolCallId: '' },
        );
      }
    }

    // Block non-read-only tools in plan mode (except EnterPlanMode/ExitPlanMode gatekeepers)
    if ((ToolPipeline.isPlanMode(ctx.sessionId) || ToolPipeline.isPlanMode()) && !tool.isReadOnly()) {
      const name = tool.name();
      if (name !== 'EnterPlanMode' && name !== 'ExitPlanMode') {
        return makeError(
          `Tool "${name}" is not available in plan mode. Only read-only tools (Read, Glob, Grep) are allowed. Use ExitPlanMode to return to normal execution.`,
          { toolCallId: '' },
        );
      }
    }

    // ── Workspace boundary check ──
    // If the tool accesses the filesystem, every resolved path must stay
    // within ctx.workspace.  Skipped when ctx.workspace is absent (old
    // sessions without a workspace binding) to preserve compatibility.
    const ws = ctx.workspace;
    if (ws) {
      const pathParams = tool.workspacePathParams();
      if (pathParams.length > 0) {
        // Resolve workspace to a fully-qualified absolute path (adds drive
        // letter on Windows so we compare apples-to-apples).
        const workspaceAbs = path.resolve(ws);

        for (const paramName of pathParams) {
          const raw = params[paramName];
          if (typeof raw !== 'string' || raw.length === 0) continue;

          // Resolve the same way tools do: absolute paths kept as-is,
          // relative paths resolved against the workspace.
          const resolved = path.isAbsolute(raw)
            ? path.resolve(raw)
            : path.resolve(workspaceAbs, raw);

          const resolvedNorm = path.normalize(resolved);
          const wsNorm = path.normalize(workspaceAbs);
          const inside = process.platform === 'win32'
            ? resolvedNorm.toLowerCase() === wsNorm.toLowerCase() ||
              resolvedNorm.toLowerCase().startsWith(wsNorm.toLowerCase() + '\\')
            : resolvedNorm === wsNorm ||
              resolvedNorm.startsWith(wsNorm + path.sep);

          if (!inside) {
            return makeError(
              `Path boundary violation: "${raw}" resolves outside the workspace.`,
              { toolCallId: '' },
            );
          }
        }
      }
    }

    return null;
  }

  static async execute(
    tool: Tool,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
    toolCallId: string,
  ): Promise<ToolResult> {
    // Delegate to tool's existing event-emitting wrapper
    return tool._executeWithEvents(params, ctx, toolCallId);
  }

  static async retry(
    tool: Tool,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
    originalResult: ToolResult,
  ): Promise<ToolResult> {
    const errorMsg = originalResult.errorMessage || '';
    if (!errorMsg) return originalResult;

    // Never retry Block-interrupt tools — repeated execution may compound destructive side-effects
    if (tool.interruptBehavior() === InterruptBehavior.Block) return originalResult;

    // Classify error
    const isRetryable = RETRYABLE_PATTERNS.some(r => r.test(errorMsg));
    const isUserVisible = USER_VISIBLE_PATTERNS.some(r => r.test(errorMsg));

    if (!isRetryable || isUserVisible) return originalResult;

    // Get max retries from tool or default
    const maxRetries = tool.maxRetries?.() ?? 3;
    if (maxRetries <= 0) return originalResult;

    const logger = createLogger('anochat.tools');
    const startedAt = originalResult.startedAt;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const delay = Math.min(2 ** attempt * 500, 5000);
      logger.debug('Tool retry', {
        toolName: tool.name(),
        sid: ctx.sessionId,
        attempt,
        maxRetries,
        delayMs: delay,
        error: errorMsg.slice(0, 100),
      });

      await new Promise(r => setTimeout(r, delay));

      const retryResult = await tool._executeWithEvents(params, ctx,
        `${tool.name()}-retry-${attempt}-${Date.now()}`);

      if (retryResult.success) {
        logger.debug('Tool retry succeeded', {
          toolName: tool.name(),
          sid: ctx.sessionId,
          attempt,
        });
        return retryResult;
      }

      // Classify new error
      const newError = retryResult.errorMessage || '';
      const newRetryable = RETRYABLE_PATTERNS.some(r => r.test(newError));
      if (!newRetryable) return retryResult;
    }

    // All retries exhausted — return the last error
    return {
      ...originalResult,
      errorMessage: `${errorMsg} (retried ${maxRetries}×, all failed)`,
    };
  }

  static normalizeOutput(result: ToolResult, tool: Tool): ToolResult {
    const content = result.content || '';
    if (!content) return result;

    const limit = tool.outputLimit?.() ?? DEFAULT_OUTPUT_CHARS;
    if (content.length <= limit) return result;

    const head = content.slice(0, TRUNCATE_HEAD_TAIL);
    const tail = content.slice(-TRUNCATE_HEAD_TAIL);
    const omitted = content.length - TRUNCATE_HEAD_TAIL * 2;

    return {
      ...result,
      content: `${head}\n\n... [${omitted} chars truncated] ...\n\n${tail}`,
      wasTruncated: true,
    };
  }
}
