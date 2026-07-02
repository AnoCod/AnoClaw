// PluginToolProxy.ts — Tool subclass that proxies execution to a plugin's tool.
// Registered in ToolRegistry on main thread. execute() sends RPC to worker.
// Analogous to MCPToolProxy for MCP server tools.

import { Tool, RiskLevel, InterruptBehavior } from '../tools/Tool.js';
import type { ToolResult } from '../tools/Tool.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import type { PluginHostManager } from './PluginHostManager.js';

export class PluginToolProxy extends Tool {

  private _pluginName: string;
  private _toolName: string;
  private _toolDescription: string;
  private _schema: Record<string, unknown>;
  private _hostManager: PluginHostManager;

  static category = 'Plugin';

  constructor(
    pluginName: string,
    toolDef: { name: string; description: string; parametersSchema: Record<string, unknown>; category?: string },
    hostManager: PluginHostManager,
  ) {
    super();
    this._pluginName = pluginName;
    this._toolName = toolDef.name;
    this._toolDescription = toolDef.description;
    this._schema = toolDef.parametersSchema;
    this._hostManager = hostManager;
  }

  name(): string { return this._toolName; }

  description(): string { return `[Plugin: ${this._pluginName}] ${this._toolDescription}`; }

  parametersSchema(): Record<string, unknown> { return this._schema; }

  riskLevel(): RiskLevel { return RiskLevel.High; }

  isReadOnly(): boolean { return false; }

  isConcurrencySafe(): boolean { return true; }

  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }

  defaultTimeoutMs(): number { return 30000; }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    try {
      // 30s timeout for plugin tool execution
      const content = await Promise.race([
        this._hostManager.executePluginTool(this._pluginName, this._toolName, params, ctx),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Plugin tool execution timed out (30s)')), 30000)
        ),
      ]);
      return this.makeResult(content);
    } catch (err) {
      return this.makeError(`[Plugin:${this._pluginName}] ${(err as Error).message}`);
    }
  }

  userFacingName(_input?: Record<string, unknown>): string {
    return this._toolName;
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    return `[${this._pluginName}] ${this._toolName}`;
  }
}
