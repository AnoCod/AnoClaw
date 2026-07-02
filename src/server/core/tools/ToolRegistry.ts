// ToolRegistry — singleton registry for all tools
// Provides register, lookup, list, and filter operations.
// Converts tool definitions to OpenAI and Anthropic LLM formats.
// Extends EventEmitter for lifecycle events.

import { EventEmitter } from 'events';
import { Tool, canUseTool } from './Tool.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import { createLogger } from '../logger.js';
import type { ILogger } from '../interfaces/ILogger.js';
import { extensionPoints } from '../plugin-host/ExtensionPoints.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { ToolPipeline } from './ToolPipeline.js';

/** Profiler interface — ToolProfiler satisfies this. */
export interface ToolProfilerLike {
  record(toolName: string, ctx: ExecutionContext, result: ToolResult): void;
}

/** Metadata stored alongside each registered tool. */
interface ToolEntry {
  tool: Tool;
  group: string;
}

export class ToolRegistry extends EventEmitter {
  private static _instance: ToolRegistry;
  private _logger: ILogger | null = null;
  private _profiler: ToolProfilerLike | null = null;

  /** Inject a logger — DI path for removing infra dependency. */
  setLogger(logger: ILogger): void { this._logger = logger; }
  private get log(): ILogger { return this._logger || createLogger('anochat.tools'); }

  /** Inject a tool profiler — decouples ToolRegistry from ToolProfiler.
   *  Wire via main.ts after initialization. */
  setProfiler(profiler: ToolProfilerLike): void { this._profiler = profiler; }

  private _tools: Map<string, ToolEntry> = new Map();
  private _groups: Map<string, Set<string>> = new Map();

  /** Get the global singleton instance. */
  static getInstance(): ToolRegistry {
    if (!ToolRegistry._instance) {
      ToolRegistry._instance = new ToolRegistry();
    }
    return ToolRegistry._instance;
  }

  /** Reset the singleton (useful for tests). */
  static resetInstance(): void {
    if (ToolRegistry._instance) {
      ToolRegistry._instance.removeAllListeners();
      ToolRegistry._instance.clear();
      ToolRegistry._instance = undefined as unknown as ToolRegistry;
    }
  }

  // ── Registration ──

  /**
   * Register a tool in the registry.
   * Emits 'toolRegistered' event.
   *
   * @param tool - The tool instance to register
   * @param group - Optional group name for categorization (default: 'uncategorized')
   */
  registerTool(tool: Tool, group: string = 'uncategorized'): void {
    const name = tool.name();
    if (this._tools.has(name)) {
      // Duplicate registration — log as warning
      this.log.warn('Duplicate tool registration', { toolName: name });
    }
    this._tools.set(name, { tool, group });

    if (!this._groups.has(group)) {
      this._groups.set(group, new Set());
    }
    this._groups.get(group)!.add(name);

    this.emit('toolRegistered', name);
  }

  // ── Lookup ──

  /** Get a tool by name, or undefined if not registered. */
  tool(name: string): Tool | undefined {
    const entry = this._tools.get(name);
    return entry?.tool;
  }

  /** Check if a tool is registered. */
  hasTool(name: string): boolean {
    return this._tools.has(name);
  }

  // ── Listing ──

  /** Get all registered tools. */
  allTools(): Tool[] {
    return Array.from(this._tools.values()).map((e) => e.tool);
  }

  /** Get all registered tool names. */
  allToolNames(): string[] {
    return Array.from(this._tools.keys());
  }

  /** Get tools filtered by the agent's allowed list. Empty list = no tools. */
  toolsForAgent(allowedTools: string[]): Tool[] {
    if (!allowedTools || allowedTools.length === 0) {
      return [];
    }
    const allowed = new Set(allowedTools);
    const result: Tool[] = [];
    for (const [name, entry] of this._tools) {
      if (allowed.has(name)) {
        result.push(entry.tool);
      }
    }
    return result;
  }

  /** Get tools for a specific group. */
  toolsByGroup(group: string): Tool[] {
    const names = this._groups.get(group);
    if (!names) return [];
    const result: Tool[] = [];
    for (const name of names) {
      const entry = this._tools.get(name);
      if (entry) result.push(entry.tool);
    }
    return result;
  }

  /** Get all group names. */
  groups(): string[] {
    return Array.from(this._groups.keys());
  }

  /** Get all tools with their group metadata (for API listing). */
  allToolsWithMeta(): { name: string; description: string; group: string; displayName: string }[] {
    return Array.from(this._tools.entries()).map(([name, entry]) => ({
      name,
      description: entry.tool.description(),
      group: entry.group,
      displayName: entry.tool.displayName?.() ?? toDisplayName(name),
    }));
  }

  // ── Queries ──

  /** Check if a tool is read-only. */
  isReadOnly(name: string): boolean {
    const tool = this.tool(name);
    return tool ? tool.isReadOnly() : false;
  }

  /** Check if a tool is concurrency-safe. */
  isConcurrencySafe(name: string): boolean {
    const tool = this.tool(name);
    return tool ? tool.isConcurrencySafe() : false;
  }

  // ── LLM Format Conversion ──

  /**
   * Convert all registered tools to OpenAI function-calling format.
   * Optionally filter by agent's allowed tool list.
   */
  toOpenAIFunctions(allowedTools?: string[]): unknown[] {
    const tools = allowedTools ? this.toolsForAgent(allowedTools) : this.allTools();
    return tools.map((t) => t.toOpenAIFunction());
  }

  /**
   * Convert all registered tools to Anthropic tool_use format.
   * Optionally filter by agent's allowed tool list.
   */
  toAnthropicTools(allowedTools?: string[]): unknown[] {
    const tools = allowedTools ? this.toolsForAgent(allowedTools) : this.allTools();
    return tools.map((t) => t.toAnthropicTool());
  }

  // ── Execution ──

  /**
   * Execute a tool by name with the given parameters and context.
   * Delegates to Tool._executeWithEvents for lifecycle event emission and timing.
   * Returns a synthetic error result when the tool is not found.
   *
   * @returns ToolResult with success/failure and timing info
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    // ExtensionPoints: toolExecutor override — plugin intercepts all tool execution
    const toolOverride = extensionPoints.get('toolExecutor');
    if (toolOverride) {
      try {
        const result = await toolOverride({ toolName, params, ctx, registry: this });
        if (result && typeof (result as ToolResult).success === 'boolean') {
          return result as ToolResult;
        }
      } catch (err) {
        this.log.warn('Plugin toolExecutor override failed', { toolName, error: (err as Error).message });
      }
    }

    const tool = this.tool(toolName);

    if (!tool) {
      const now = Date.now();
      this.log.warn('Tool not found', { toolName, sid: ctx.sessionId, aid: ctx.agentId });
      return {
        toolCallId: (params._toolCallId as string) ?? `${toolName}-${now}`,
        success: false,
        content: `Error: Unknown tool: ${toolName}`,
        errorMessage: `Tool "${toolName}" is not registered`,
        tokensUsed: 0,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        wasTruncated: false,
      };
    }

    // Role permission check — verify caller is authorized to use this tool
    if (!canUseTool(ctx.callerRole, tool.minRole())) {
      const now = Date.now();
      this.log.warn('Tool permission denied by role', {
        toolName,
        callerRole: ctx.callerRole,
        minRole: tool.minRole(),
        sid: ctx.sessionId,
        aid: ctx.agentId,
      });
      return {
        toolCallId: (params._toolCallId as string) ?? `${toolName}-${now}`,
        success: false,
        content: '',
        errorMessage: `Permission denied: role "${ctx.callerRole || 'unknown'}" cannot use "${toolName}" (requires "${tool.minRole()}")`,
        tokensUsed: 0,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        wasTruncated: false,
      };
    }

    // Delegate to the tool through the pipeline — validation → security → execute → retry → normalize
    const toolCallId = (params._toolCallId as string) ?? `${toolName}-${Date.now()}`;
    this.log.debug('Tool execution starting (pipeline)', {
      toolName,
      sid: ctx.sessionId,
      aid: ctx.agentId,
    });

    // Emit to TypedEventBus (pipeline audit stage)
    TypedEventBus.emit('tool:execution_started', {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolName,
    });

    const result = await ToolPipeline.run(tool, params, ctx, toolCallId);

    // Post-execution logging + profiling
    if (result.success) {
      this.log.debug('Tool execution completed', {
        toolName, success: true, durationMs: result.durationMs, sid: ctx.sessionId, aid: ctx.agentId,
      });
    } else {
      this.log.warn('Tool execution completed', {
        toolName, success: false, durationMs: result.durationMs, sid: ctx.sessionId, aid: ctx.agentId,
      });
    }
    this._profiler?.record(toolName, ctx, result);

    TypedEventBus.emit('tool:execution_completed', {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      toolName,
      success: result.success,
      durationMs: result.durationMs,
      tokensUsed: result.tokensUsed,
    });
    return result;
  }

  // ── Management ──

  /** Remove a tool from the registry. */
  deregisterTool(name: string): void {
    const entry = this._tools.get(name);
    if (!entry) return;

    this._tools.delete(name);
    const groupNames = this._groups.get(entry.group);
    if (groupNames) {
      groupNames.delete(name);
      if (groupNames.size === 0) {
        this._groups.delete(entry.group);
      }
    }
  }

  /** Remove all tools from the registry. */
  clear(): void {
    this._tools.clear();
    this._groups.clear();
  }
}

/** Convert PascalCase/camelCase tool name to human-readable display name. */
function toDisplayName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}
