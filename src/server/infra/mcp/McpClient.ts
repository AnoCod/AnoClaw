/**
 * MCPClient — one connection to one MCP server, transport-agnostic
 * (stdio / SSE / streamable HTTP). Ported from the retired anoclaw-mcp
 * plugin and now part of the AnoClaw kernel.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { McpJsonRpc } from './McpJsonRpc.js';
import type {
  McpPromptDef, McpResourceDef, McpServerConfig, McpServerState, McpToolDef,
} from './McpTypes.js';

const MCP_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'anoclaw-mcp', version: '2.1.0' };
const RPC_TIMEOUT_MS = 25_000;
const RECONNECT_BASE = 1_000;
const RECONNECT_CAP = 30_000;
const HEALTH_INTERVAL = 30_000;

export interface McpClientEvents {
  onState: (name: string, status: string, detail?: string) => void;
  onLog: (level: 'info' | 'warn' | 'error', server: string, message: string) => void;
}

function globToRegex(pattern: string): RegExp {
  return new RegExp(
    '^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/§§/g, '.*') + '$',
  );
}

export class McpClient {
  private _cfg: McpServerConfig;
  private _events: McpClientEvents;
  private _rpc = new McpJsonRpc();
  private _connected = false;
  private _connecting = false;
  private _proc: ChildProcess | null = null;
  private _sseEndpoint: string | null = null;
  private _httpEndpoint: string | null = null;
  private _tools: McpToolDef[] = [];
  private _resources: McpResourceDef[] = [];
  private _prompts: McpPromptDef[] = [];
  private _serverInfo: { name?: string; version?: string } | null = null;
  private _capabilities: Record<string, unknown> | null = null;
  private _reconnectAttempts = 0;
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _healthTimer: NodeJS.Timeout | null = null;
  private _sseAbort: AbortController | null = null;

  constructor(config: McpServerConfig, events: McpClientEvents) {
    this._cfg = config;
    this._events = events;
  }

  get name(): string { return this._cfg.name; }
  get id(): string { return this._cfg.id || this._cfg.name; }
  get connected(): boolean { return this._connected; }
  get tools(): McpToolDef[] { return [...this._tools]; }
  get resources(): McpResourceDef[] { return [...this._resources]; }
  get prompts(): McpPromptDef[] { return [...this._prompts]; }
  get serverInfo(): { name?: string; version?: string } | null { return this._serverInfo; }
  get capabilities(): Record<string, unknown> | null { return this._capabilities; }
  get transportType(): string { return this._cfg.transport || 'stdio'; }
  get config(): McpServerConfig { return { ...this._cfg }; }

  state(): McpServerState {
    return {
      id: this.id,
      name: this.name,
      transport: this.transportType,
      command: this._cfg.command,
      url: this._cfg.url,
      connected: this._connected,
      connecting: this._connecting,
      toolCount: this._tools.length,
      resourceCount: this._resources.length,
      promptCount: this._prompts.length,
      serverInfo: this._serverInfo,
      capabilities: this._capabilities,
    };
  }

  async connect(): Promise<void> {
    if (this._connecting || this._connected) return;
    this._connecting = true;
    this._events.onState(this.name, 'connecting');
    try {
      const transport = this._cfg.transport || 'stdio';
      if (transport === 'stdio') await this._connectStdio();
      else if (transport === 'sse') await this._connectSSE();
      else if (transport === 'http') await this._connectHTTP();
      else throw new Error(`Unknown transport: ${transport}`);

      await this._initialize();
      await this._discover();

      this._connected = true;
      this._connecting = false;
      this._reconnectAttempts = 0;
      this._events.onState(this.name, 'connected');
      this._events.onLog('info', this.name, `Connected - ${this._tools.length} tools, ${this._resources.length} resources, ${this._prompts.length} prompts`);
      this._startHealthCheck();
    } catch (err) {
      this._connecting = false;
      this._events.onState(this.name, 'error', (err as Error).message);
      this._events.onLog('error', this.name, `Connection failed: ${(err as Error).message}`);
      this._scheduleReconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this._stopHealthCheck();
    this._cancelReconnect();
    this._rpc.drain(new Error('Disconnected'));
    this._sseAbort?.abort();
    this._sseAbort = null;
    const proc = this._proc;
    this._proc = null;
    this._connected = false;
    this._sseEndpoint = null;
    this._httpEndpoint = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 3000);
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this._connected) throw new Error(`MCP server "${this.name}" is not connected`);
    const sendFn = this._getSendFn();
    return this._rpc.request(sendFn, 'tools/call', { name: toolName, arguments: args || {} });
  }

  async readResource(uri: string): Promise<string> {
    if (!this._connected) throw new Error(`MCP server "${this.name}" is not connected`);
    const sendFn = this._getSendFn();
    const result = (await this._rpc.request(sendFn, 'resources/read', { uri })) as { contents?: Array<{ text?: string }> };
    return (result?.contents ?? []).map((c) => c.text || JSON.stringify(c)).join('\n');
  }

  async getPrompt(prompt: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this._connected) throw new Error(`MCP server "${this.name}" is not connected`);
    const sendFn = this._getSendFn();
    return this._rpc.request(sendFn, 'prompts/get', { name: prompt, arguments: args || {} });
  }

  // ── Transports ─────────────────────────────────────────────

  private _connectStdio(): Promise<void> {
    const command = this._cfg.command;
    if (!command) throw new Error('No command configured');
    const [cmd, ...args] = command.split(/\s+/);
    const extraArgs = this._cfg.args ?? [];
    this._proc = spawn(cmd, [...args, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this._cfg.env || {}) },
      cwd: this._cfg.cwd,
    });
    let buf = '';
    this._proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this._rpc.feed(trimmed);
      }
    });
    this._proc.stderr?.on('data', (chunk: Buffer) => {
      this._events.onLog('warn', this.name, `stderr: ${chunk.toString().slice(0, 200)}`);
    });
    this._proc.on('exit', (code) => {
      this._events.onLog('info', this.name, `process exited (code ${code})`);
      this._onDisconnected();
    });
    this._proc.on('error', (err) => {
      this._events.onLog('error', this.name, `process error: ${err.message}`);
      this._onDisconnected();
    });
    return Promise.resolve();
  }

  private async _connectSSE(): Promise<void> {
    const url = this._cfg.url;
    if (!url) throw new Error('No URL configured');
    const baseUrl = url.endsWith('/sse') ? url : `${url}/sse`;
    const headers = this._cfg.headers ?? {};
    const resp = await fetch(baseUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`SSE connect failed: HTTP ${resp.status}`);
    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No SSE stream body');
    const decoder = new TextDecoder();
    let buf = '';
    let endpoint: string | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const match = buf.replace(/\r\n/g, '\n').match(/event:\s*endpoint\n?data:\s?(.+)/);
      if (match) { endpoint = match[1].trim(); break; }
    }
    reader.cancel();
    if (!endpoint) throw new Error('No SSE endpoint event received');
    this._sseEndpoint = endpoint.startsWith('/') ? new URL(url).origin + endpoint : endpoint;
    this._startSSEListener(baseUrl);
  }

  private _startSSEListener(sseUrl: string): void {
    this._sseAbort = new AbortController();
    void (async () => {
      try {
        const resp = await fetch(sseUrl, { headers: this._cfg.headers ?? {}, signal: this._sseAbort?.signal });
        const reader = resp.body?.getReader();
        if (!reader) { this._onDisconnected(); return; }
        const decoder = new TextDecoder();
        let buf = '';
        while (this._connected || this._connecting) {
          const { value, done } = await reader.read();
          if (done) { this._onDisconnected(); break; }
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              try { this._rpc.feed(trimmed.slice(6)); } catch { /* non-JSON notification */ }
            }
          }
        }
        reader?.cancel().catch(() => {});
      } catch {
        if (this._connected) this._onDisconnected();
      }
    })();
  }

  private _connectHTTP(): Promise<void> {
    const url = this._cfg.url;
    if (!url) throw new Error('No URL configured');
    this._httpEndpoint = url;
    return Promise.resolve();
  }

  private _getSendFn(): (msg: string) => void {
    if (this._proc?.stdin?.writable) {
      return (msg) => { this._proc!.stdin!.write(msg + '\n'); };
    }
    if (this._sseEndpoint) {
      return (msg) => {
        void fetch(this._sseEndpoint!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this._cfg.headers ?? {}) },
          body: msg,
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        }).then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          this._rpc.feed(JSON.stringify(json));
        }).catch((err: Error) => {
          this._rpc.drain(new Error(`SSE RPC failed: ${err.message}`));
        });
      };
    }
    if (this._httpEndpoint) {
      return (msg) => {
        void fetch(this._httpEndpoint!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this._cfg.headers ?? {}) },
          body: msg,
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        }).then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          this._rpc.feed(JSON.stringify(json));
        }).catch((err: Error) => {
          this._rpc.drain(new Error(`HTTP RPC failed: ${err.message}`));
        });
      };
    }
    throw new Error('No active transport');
  }

  private async _initialize(): Promise<void> {
    const sendFn = this._getSendFn();
    const result = (await this._rpc.request(sendFn, 'initialize', {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
    this._serverInfo = result?.serverInfo || null;
    this._capabilities = result?.capabilities || null;
    this._rpc.notify(sendFn, 'notifications/initialized', {});
  }

  private async _discover(): Promise<void> {
    const sendFn = this._getSendFn();
    try {
      const result = (await this._rpc.request(sendFn, 'tools/list', {})) as { tools?: McpToolDef[] };
      this._tools = (result?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || {},
      })).filter((t) => this._toolAllowed(t.name));
    } catch (err) {
      this._events.onLog('warn', this.name, `tools/list failed: ${(err as Error).message}`);
    }
    if (this._filterAllows('resources')) {
      try {
        const result = (await this._rpc.request(sendFn, 'resources/list', {})) as { resources?: McpResourceDef[] };
        this._resources = (result?.resources ?? []).map((r) => ({
          uri: r.uri, name: r.name || r.uri, description: r.description || '', mimeType: r.mimeType,
        }));
      } catch { /* optional */ }
    }
    if (this._filterAllows('prompts')) {
      try {
        const result = (await this._rpc.request(sendFn, 'prompts/list', {})) as { prompts?: McpPromptDef[] };
        this._prompts = (result?.prompts ?? []).map((p) => ({
          name: p.name, description: p.description || '', arguments: p.arguments || [],
        }));
      } catch { /* optional */ }
    }
  }

  private _toolAllowed(name: string): boolean {
    const filter = this._cfg.toolFilter;
    if (!filter) return true;
    const include = filter.include?.length ? filter.include : null;
    const exclude = filter.exclude?.length ? filter.exclude : null;
    if (!include && !exclude) return true;
    if (include && !include.some((p) => globToRegex(p).test(name))) return false;
    if (exclude && exclude.some((p) => globToRegex(p).test(name))) return false;
    return true;
  }

  private _filterAllows(kind: 'resources' | 'prompts'): boolean {
    const filter = this._cfg.toolFilter;
    if (!filter) return true;
    if (kind === 'resources') return filter.resources !== false;
    if (kind === 'prompts') return filter.prompts !== false;
    return true;
  }

  // ── Health & reconnect ─────────────────────────────────────

  private _startHealthCheck(): void {
    this._healthTimer = setInterval(() => {
      if (!this._connected) return;
      const sendFn = this._getSendFn();
      void this._rpc.request(sendFn, 'ping', {}, 5_000).catch(() => {
        this._events.onLog('warn', this.name, 'health check failed, disconnecting');
        this._onDisconnected();
      });
    }, HEALTH_INTERVAL);
  }

  private _stopHealthCheck(): void {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
  }

  private _onDisconnected(): void {
    const wasConnected = this._connected;
    this._connected = false;
    this._connecting = false;
    const proc = this._proc;
    this._proc = null;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 3000);
    }
    this._sseEndpoint = null;
    this._httpEndpoint = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._stopHealthCheck();
    this._rpc.drain(new Error('Disconnected'));
    if (wasConnected) {
      this._events.onLog('warn', this.name, 'Disconnected');
      this._events.onState(this.name, 'disconnected');
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    this._cancelReconnect();
    this._reconnectAttempts++;
    const delay = Math.min(RECONNECT_CAP, RECONNECT_BASE * Math.pow(2, this._reconnectAttempts - 1));
    this._events.onLog('info', this.name, `Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._events.onState(this.name, 'reconnecting', `attempt ${this._reconnectAttempts} in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this.connect().catch(() => { /* _scheduleReconnect called again from connect() */ });
    }, delay);
  }

  private _cancelReconnect(): void {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }
}
