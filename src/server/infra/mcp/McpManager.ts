/**
 * McpManager — native MCP kernel service (replaces the retired anoclaw-mcp
 * plugin). Owns server configs (data/mcp-servers.json), client connections,
 * agent-facing MCP tools, CRUD routes, and import merging from the ecosystem
 * bridge.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { writablePath } from '../WritablePath.js';
import { Tool } from '../../core/tools/Tool.js';
import { makeError, makeResult } from '../../core/tools/ToolResult.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';
import { TypedEventBus } from '../../core/events/TypedEventBus.js';
import type { ExecutionContext } from '../../../shared/types/session.js';
import type { ToolResult } from '../../../shared/types/tool.js';
import { McpClient } from './McpClient.js';
import type {
  McpLogEntry, McpServerConfig, McpServerState, McpServersFile,
} from './McpTypes.js';

const MAX_LOGS = 200;

type McpToolHandler = (params: Record<string, unknown>, manager: McpManager) => Promise<string>;

class McpAgentTool extends Tool {
  private _name: string;
  private _description: string;
  private _schema: Record<string, unknown>;
  private _handler: McpToolHandler;

  constructor(name: string, description: string, schema: Record<string, unknown>, handler: McpToolHandler) {
    super();
    this._name = name;
    this._description = description;
    this._schema = schema;
    this._handler = handler;
  }

  name(): string { return this._name; }
  description(): string { return this._description; }
  parametersSchema(): Record<string, unknown> { return this._schema; }

  async execute(params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    try {
      return makeResult(await this._handler(params, McpManager.getInstance()));
    } catch (err) {
      return makeError((err as Error).message);
    }
  }
}

export class McpManager extends EventEmitter {
  private static _instance: McpManager | null = null;

  static getInstance(options: { configPath?: string; migrationCandidates?: string[] } = {}): McpManager {
    if (!McpManager._instance) McpManager._instance = new McpManager(options);
    return McpManager._instance;
  }

  static resetInstance(): void {
    McpManager._instance = null;
  }

  private _configPath: string;
  private _migrationCandidates: string[];
  private _clients = new Map<string, McpClient>();
  private _logs: McpLogEntry[] = [];
  private _initialized = false;
  private _toolsRegistered: string[] = [];

  private constructor(options: { configPath?: string; migrationCandidates?: string[] } = {}) {
    super();
    this._configPath = options.configPath ?? writablePath('data', 'mcp-servers.json');
    this._migrationCandidates = options.migrationCandidates ?? [
      writablePath('plugins', 'anoclaw-mcp', 'data', 'data.json'),
      writablePath('plugins', 'anoclaw-mcp.disabled', 'data', 'data.json'),
    ];
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async init(): Promise<void> {
    if (this._initialized) return;
    this._initialized = true;
    this._migrateLegacyPluginData();
    this._registerAgentTools();
    const configs = this.loadConfig();
    for (const entry of configs) {
      this._ensureClient(entry);
    }
    void this.connectAll();
  }

  async stop(): Promise<void> {
    for (const client of this._clients.values()) {
      await client.disconnect().catch(() => {});
    }
    this._clients.clear();
    for (const name of this._toolsRegistered) {
      try { ToolRegistry.getInstance().deregisterTool(name); } catch { /* best-effort */ }
    }
    this._toolsRegistered = [];
  }

  // ── Config persistence ────────────────────────────────────

  loadConfig(): McpServerConfig[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this._configPath, 'utf8')) as McpServersFile;
      if (Array.isArray(raw.servers)) return raw.servers;
    } catch { /* first run */ }
    return [];
  }

  saveConfig(configs: McpServerConfig[]): void {
    const file: McpServersFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      servers: configs,
    };
    fs.mkdirSync(path.dirname(this._configPath), { recursive: true });
    const tmp = this._configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.renameSync(tmp, this._configPath);
  }

  /** One-time migration from the retired plugin storage (data.json servers). */
  private _migrateLegacyPluginData(): void {
    if (this.loadConfig().length > 0) return;
    for (const file of this._migrationCandidates) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { servers?: McpServerConfig[] };
        if (Array.isArray(raw.servers) && raw.servers.length > 0) {
          const normalized = raw.servers.map((s) => ({
            id: s.id ?? `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            name: s.name,
            transport: s.transport || 'stdio',
            ...(s.command ? { command: s.command } : {}),
            ...(s.args ? { args: s.args } : {}),
            ...(s.env ? { env: s.env } : {}),
            ...(s.url ? { url: s.url } : {}),
            ...(s.headers ? { headers: s.headers } : {}),
            ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
          }));
          this.saveConfig(normalized);
          this._log('info', 'system', `Migrated ${normalized.length} MCP server(s) from the retired plugin`);
          return;
        }
      } catch { /* candidate not present */ }
    }
  }

  // ── Agent tools ────────────────────────────────────────────

  private _registerAgentTools(): void {
    const registry = ToolRegistry.getInstance();
    const tools: Array<[string, string, Record<string, unknown>, McpToolHandler]> = [
      [
        'MCPListTools',
        'List all connected MCP servers and their available tools. Use this to discover what external tools you can call via MCPExecute.',
        {
          type: 'object',
          properties: { server: { type: 'string', description: 'Optional: filter to a specific server name.' } },
          required: [],
        },
        async (params) => this._listTools(String(params.server ?? '')),
      ],
      [
        'MCPExecute',
        'Execute a tool on a connected MCP server. Use MCPListTools first to discover available servers and tools. The tool name must exactly match one returned by MCPListTools.',
        {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server name (from MCPListTools).' },
            tool: { type: 'string', description: 'Tool name to call (from MCPListTools).' },
            arguments: { type: 'object', description: 'Tool arguments as a JSON object matching the tool input schema.' },
          },
          required: ['server', 'tool'],
        },
        async (params) => {
          const client = this._clients.get(String(params.server ?? ''));
          if (!client) return `MCP server "${params.server}" not found. Use MCPListTools to see available servers.`;
          if (!client.connected) return `MCP server "${params.server}" is not connected. It may be reconnecting - try again shortly.`;
          const output = await client.callTool(String(params.tool ?? ''), (params.arguments as Record<string, unknown>) ?? {});
          return this._stringifyOutput(output);
        },
      ],
      [
        'MCPListResources',
        'List resources (files, data, etc.) available on connected MCP servers.',
        {
          type: 'object',
          properties: { server: { type: 'string', description: 'Optional: filter to a specific server name.' } },
          required: [],
        },
        async (params) => this._listResources(String(params.server ?? '')),
      ],
      [
        'MCPReadResource',
        'Read a specific resource from a connected MCP server by its URI. Use MCPListResources first to discover available resource URIs.',
        {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server name.' },
            uri: { type: 'string', description: 'Resource URI (from MCPListResources).' },
          },
          required: ['server', 'uri'],
        },
        async (params) => {
          const client = this._clients.get(String(params.server ?? ''));
          if (!client) return `MCP server "${params.server}" not found.`;
          if (!client.connected) return `MCP server "${params.server}" is not connected.`;
          return client.readResource(String(params.uri ?? ''));
        },
      ],
      [
        'MCPListPrompts',
        'List all prompts exposed by connected MCP servers. Use MCPGetPrompt to invoke a specific prompt with arguments.',
        {
          type: 'object',
          properties: { server: { type: 'string', description: 'Optional: filter to a specific server name.' } },
          required: [],
        },
        async (params) => this._listPrompts(String(params.server ?? '')),
      ],
      [
        'MCPGetPrompt',
        'Execute a prompt on a connected MCP server by name, passing required arguments. Use MCPListPrompts first to discover available prompts and their arguments.',
        {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP server name (from MCPListPrompts).' },
            prompt: { type: 'string', description: 'Prompt name to execute (from MCPListPrompts).' },
            arguments: { type: 'object', description: "Prompt arguments as a JSON object matching the prompt's argument schema." },
          },
          required: ['server', 'prompt'],
        },
        async (params) => {
          const client = this._clients.get(String(params.server ?? ''));
          if (!client) return `MCP server "${params.server}" not found. Use MCPListPrompts to see available servers.`;
          if (!client.connected) return `MCP server "${params.server}" is not connected. It may be reconnecting - try again shortly.`;
          const output = await client.getPrompt(String(params.prompt ?? ''), (params.arguments as Record<string, unknown>) ?? {});
          return this._stringifyOutput(output);
        },
      ],
    ];

    for (const [name, description, schema, handler] of tools) {
      if (registry.hasTool(name)) continue;
      registry.registerTool(new McpAgentTool(name, description, schema, handler), 'Integration', { source: 'builtin' });
      this._toolsRegistered.push(name);
    }
  }

  // ── Client management ─────────────────────────────────────

  private _ensureClient(config: McpServerConfig): McpClient {
    const existing = this._clients.get(config.name);
    if (existing) return existing;
    const client = new McpClient(config, {
      onState: (name, status, detail) => {
        this._emitState(name, status, detail);
      },
      onLog: (level, server, message) => {
        this._log(level, server, message);
      },
    });
    this._clients.set(config.name, client);
    return client;
  }

  async connectAll(): Promise<void> {
    for (const config of this.loadConfig()) {
      const client = this._ensureClient(config);
      if (config.enabled === false) continue;
      void client.connect().catch(() => { /* reconnect scheduler handles it */ });
    }
  }

  listServers(): McpServerState[] {
    const configs = this.loadConfig();
    const byName = new Map(this._clients.entries());
    const states: McpServerState[] = [];
    for (const config of configs) {
      const client = byName.get(config.name);
      if (client) states.push(client.state());
      else {
        states.push({
          id: config.id ?? config.name,
          name: config.name,
          transport: config.transport || 'stdio',
          command: config.command,
          url: config.url,
          connected: false,
          connecting: false,
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
        });
      }
    }
    return states;
  }

  getServer(idOrName: string): McpClient | undefined {
    for (const client of this._clients.values()) {
      if (client.id === idOrName || client.name === idOrName) return client;
    }
    return undefined;
  }

  async addServer(input: Partial<McpServerConfig>): Promise<McpServerConfig> {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('name is required');
    const configs = this.loadConfig();
    const entry: McpServerConfig = {
      id: input.id ?? `mcp_${Date.now().toString(36)}`,
      name,
      transport: (input.transport ?? 'stdio') as McpServerConfig['transport'],
      ...(input.command ? { command: input.command } : {}),
      ...(input.args ? { args: input.args } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.toolFilter ? { toolFilter: input.toolFilter } : {}),
    };
    const idx = configs.findIndex((c) => c.name === name);
    if (idx >= 0) configs[idx] = entry;
    else configs.push(entry);
    this.saveConfig(configs);
    const client = this._ensureClient(entry);
    void client.connect().catch(() => {});
    return entry;
  }

  async updateServer(idOrName: string, patch: Partial<McpServerConfig>): Promise<McpServerConfig> {
    const configs = this.loadConfig();
    const idx = configs.findIndex((c) => c.id === idOrName || c.name === idOrName);
    if (idx < 0) throw new Error('Server not found');
    const old = configs[idx];
    const updated: McpServerConfig = {
      ...old,
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.transport ? { transport: patch.transport } : {}),
      ...(patch.command !== undefined ? { command: patch.command } : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.env !== undefined ? { env: patch.env } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.toolFilter !== undefined ? { toolFilter: patch.toolFilter } : {}),
    };
    configs[idx] = updated;
    this.saveConfig(configs);

    const oldClient = this._clients.get(old.name);
    if (oldClient) {
      await oldClient.disconnect().catch(() => {});
      this._clients.delete(old.name);
    }
    const client = this._ensureClient(updated);
    void client.connect().catch(() => {});
    return updated;
  }

  async deleteServer(idOrName: string): Promise<boolean> {
    const configs = this.loadConfig();
    const idx = configs.findIndex((c) => c.id === idOrName || c.name === idOrName);
    if (idx < 0) return false;
    const entry = configs[idx];
    const client = this._clients.get(entry.name);
    if (client) {
      await client.disconnect().catch(() => {});
      this._clients.delete(entry.name);
    }
    configs.splice(idx, 1);
    this.saveConfig(configs);
    this._emitState(entry.name, 'deleted');
    return true;
  }

  async reconnect(idOrName: string): Promise<McpServerState> {
    const client = this.getServer(idOrName);
    if (!client) throw new Error('Server not found');
    await client.disconnect().catch(() => {});
    await client.connect();
    return client.state();
  }

  /**
   * Merge ecosystem-imported servers into native storage. Servers carrying an
   * `origin.entryId` that belongs to the current import set are replaced;
   * manually added servers are never touched.
   */
  async replaceImportedServers(imported: McpServerConfig[]): Promise<void> {
    const configs = this.loadConfig();
    const currentIds = new Set(imported.map((s) => s.origin?.entryId).filter(Boolean) as string[]);
    const kept = configs.filter((c) => !c.origin?.entryId || !currentIds.has(c.origin.entryId));
    const merged = [...kept, ...imported];
    this.saveConfig(merged);

    // Sync client map: disconnect removed imports, add new ones.
    const importedNames = new Set(imported.map((s) => s.name));
    const keptNames = new Set(merged.map((s) => s.name));
    for (const [name, client] of [...this._clients.entries()]) {
      if (!keptNames.has(name)) {
        await client.disconnect().catch(() => {});
        this._clients.delete(name);
      }
    }
    for (const config of imported) {
      if (config.enabled === false) continue;
      const client = this._ensureClient(config);
      void client.connect().catch(() => {});
    }
    void importedNames;
  }

  // ── Logs ───────────────────────────────────────────────────

  getLogs(): McpLogEntry[] {
    return [...this._logs];
  }

  private _log(level: 'info' | 'warn' | 'error', server: string, message: string): void {
    const entry: McpLogEntry = { level, server, message, timestamp: Date.now() };
    this._logs.push(entry);
    if (this._logs.length > MAX_LOGS) this._logs.shift();
    TypedEventBus.emit('mcp:log', entry);
    this.emit('log', entry);
  }

  private _emitState(name: string, status: string, detail = ''): void {
    TypedEventBus.emit('mcp:state-change', { server: name, status, detail, timestamp: Date.now() });
    this.emit('state-change', { server: name, status, detail });
  }

  // ── Tool output helpers ────────────────────────────────────

  private _stringifyOutput(output: unknown): string {
    if (typeof output === 'string') return output;
    const content = (output as { content?: Array<{ type?: string; text?: string }> })?.content;
    if (Array.isArray(content)) {
      return content.map((c) => (c.type === 'text' ? c.text || '' : `[${c.type || 'unknown'}]`)).filter(Boolean).join('\n');
    }
    return JSON.stringify(output ?? '', null, 2);
  }

  private _listTools(serverFilter: string): string {
    if (this._clients.size === 0) return 'No MCP servers configured. Add servers in the Skills & Tools page.';
    const lines: string[] = [];
    for (const [name, client] of this._clients) {
      if (serverFilter && name !== serverFilter) continue;
      const status = client.connected ? 'connected' : 'disconnected';
      const info = client.serverInfo ? ` (${client.serverInfo.name || ''} v${client.serverInfo.version || ''})` : '';
      lines.push(`## ${name} [${status}]${info}`);
      if (client.connected) {
        for (const t of client.tools) {
          const schema = t.inputSchema?.properties
            ? ` - params: ${Object.keys(t.inputSchema.properties).join(', ')}`
            : '';
          lines.push(`  - \`${t.name}\`: ${(t.description || '').slice(0, 150)}${schema}`);
        }
        if (client.tools.length === 0) lines.push('  (no tools exposed)');
      } else {
        lines.push('  (server not connected)');
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private _listResources(serverFilter: string): string {
    if (this._clients.size === 0) return 'No MCP servers configured.';
    const lines: string[] = [];
    for (const [name, client] of this._clients) {
      if (serverFilter && name !== serverFilter) continue;
      lines.push(`## ${name} - ${client.resources.length} resources`);
      for (const r of client.resources) {
        lines.push(`  - \`${r.uri}\`: ${r.description || r.name || ''} ${r.mimeType ? `[${r.mimeType}]` : ''}`);
      }
      lines.push('');
    }
    return lines.join('\n') || 'No resources found.';
  }

  private _listPrompts(serverFilter: string): string {
    if (this._clients.size === 0) return 'No MCP servers configured.';
    const lines: string[] = [];
    for (const [name, client] of this._clients) {
      if (serverFilter && name !== serverFilter) continue;
      const status = client.connected ? 'connected' : 'disconnected';
      lines.push(`## ${name} [${status}] - ${client.prompts.length} prompts`);
      if (client.connected) {
        for (const p of client.prompts) {
          const argsStr = (p.arguments || []).map((a) => `${a.name}${a.required ? '*' : ''}`).join(', ');
          lines.push(`  - \`${p.name}\`: ${(p.description || '').slice(0, 150)}${argsStr ? ` - args: ${argsStr}` : ''}`);
        }
        if (client.prompts.length === 0) lines.push('  (no prompts exposed)');
      } else {
        lines.push('  (server not connected)');
      }
      lines.push('');
    }
    return lines.join('\n') || 'No prompts found.';
  }
}
