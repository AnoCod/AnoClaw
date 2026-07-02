// AnoClaw MCP Plugin — World-class MCP (Model Context Protocol) integration.
// Feature-parity with Claude Code's MCP: dynamic tool proxy, auto-reconnect,
// health monitoring, full specification support, zero-config recovery.
//
// Architecture:
//   MCPPlugin (PluginBase)
//   ├── MCPClient per server — transport agnostic (stdio / sse / http)
//   │   ├── JSON-RPC 2.0 protocol engine
//   │   ├── Tool discovery + execution proxy
//   │   ├── Resource + prompt enumeration
//   │   └── Health heartbeat + auto-reconnect with backoff
//   ├── Agent tools: MCPListTools, MCPExecute, MCPListResources, MCPReadResource
//   ├── HTTP API: CRUD servers, reconnect, health status
//   └── Frontend: live server list, tool browser, connection logs

const { PluginBase } = globalThis;
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const MCP_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'anoclaw-mcp', version: '2.1.0' };
const RPC_TIMEOUT_MS = 25_000;
const RECONNECT_BASE = 1_000;
const RECONNECT_CAP = 30_000;
const HEALTH_INTERVAL = 30_000;

// ═══════════════════════════════════════════════════════════════
// JSON-RPC 2.0 engine — shared by all transports
// ═══════════════════════════════════════════════════════════════

class JsonRpcEngine {
  constructor() {
    this._reqId = 0;
    this._pending = new Map();
  }

  _nextId() { return ++this._reqId; }

  /** Send a request and wait for response. Returns result or rejects. */
  request(sendFn, method, params, timeoutMs = RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      sendFn(msg);
    });
  }

  /** Send a notification (no response expected). */
  notify(sendFn, method, params) {
    sendFn(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Feed a received JSON string. Returns true if it was a pending response. */
  feed(jsonStr) {
    let msg;
    try { msg = JSON.parse(jsonStr); } catch { return false; }
    if (msg.id == null || !this._pending.has(msg.id)) return false;
    const { resolve, reject, timer } = this._pending.get(msg.id);
    this._pending.delete(msg.id);
    clearTimeout(timer);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
    return true;
  }

  /** Reject all pending requests (called on disconnect). */
  drain(error) {
    for (const [, { reject, timer }] of this._pending) {
      clearTimeout(timer);
      reject(error);
    }
    this._pending.clear();
  }
}

// ═══════════════════════════════════════════════════════════════
// MCPClient — one per connected MCP server
// ═══════════════════════════════════════════════════════════════

class MCPClient {
  constructor(config, plugin) {
    this._cfg = config;
    this._plugin = plugin;
    this._rpc = new JsonRpcEngine();
    this._connected = false;
    this._connecting = false;
    this._proc = null;
    this._sseEndpoint = null;
    this._httpEndpoint = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._serverInfo = null;
    this._capabilities = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._healthTimer = null;
  }

  get name() { return this._cfg.name; }
  get id() { return this._cfg.id || this._cfg.name; }
  get connected() { return this._connected; }
  get tools() { return this._tools; }
  get resources() { return this._resources; }
  get prompts() { return this._prompts; }
  get serverInfo() { return this._serverInfo; }
  get transportType() { return this._cfg.transport || 'stdio'; }

  async connect() {
    if (this._connecting || this._connected) return;
    this._connecting = true;
    this._plugin._emitState(this.name, 'connecting');
    try {
      const transport = this._cfg.transport || 'stdio';
      if (transport === 'stdio') await this._connectStdio();
      else if (transport === 'sse') await this._connectSSE();
      else if (transport === 'http') await this._connectHTTP();
      else throw new Error(`Unknown transport: ${transport}`);

      // Handshake + discovery
      await this._initialize();
      await this._discover();

      this._connected = true;
      this._connecting = false;
      this._reconnectAttempts = 0;
      this._plugin._emitState(this.name, 'connected');
      this._plugin._addLog('info', this.name, `Connected — ${this._tools.length} tools, ${this._resources.length} resources, ${this._prompts.length} prompts`);
      this._startHealthCheck();
      this._plugin.log(`MCP server "${this.name}" connected — ${this._tools.length} tools, ${this._resources.length} resources`);
    } catch (err) {
      this._connecting = false;
      this._plugin._emitState(this.name, 'error', err.message);
      this._plugin._addLog('error', this.name, `Connection failed: ${err.message}`);
      this._plugin.log(`MCP server "${this.name}" connection failed: ${err.message}`);
      this._scheduleReconnect();
      throw err;
    }
  }

  async disconnect() {
    this._stopHealthCheck();
    this._cancelReconnect();
    this._rpc.drain(new Error('Disconnected'));
    const proc = this._proc;
    this._proc = null;
    this._connected = false;
    this._sseEndpoint = null;
    this._httpEndpoint = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];

    if (proc) {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }
  }

  /** Execute an MCP tool and return its content. */
  async callTool(toolName, args) {
    if (!this._connected) throw new Error(`MCP server "${this.name}" is not connected`);
    const sendFn = this._getSendFn();
    const result = await this._rpc.request(sendFn, 'tools/call', { name: toolName, arguments: args || {} });
    // MCP returns content as array of { type: 'text'|'image'|'resource', text/data/... }
    if (!result) return '[MCP: empty result]';
    if (result.isError) return `[MCP Error] ${(result.content || []).map(c => c.text || '').join('\n')}`;
    const content = result.content || [];
    if (content.length === 0) return '[MCP: no content]';
    // Handle content array
    return content.map(c => {
      if (c.type === 'text') return c.text || '';
      if (c.type === 'image') return `[Image: ${c.mimeType || 'unknown'}, data omitted]`;
      if (c.type === 'resource') return `[Resource: ${c.resource?.uri || 'unknown'}]`;
      return JSON.stringify(c);
    }).filter(Boolean).join('\n');
  }

  /** Get a prompt from the MCP server by name with arguments. */
  async getPrompt(promptName, args) {
    if (!this._connected) throw new Error(`MCP server "${this.name}" is not connected`);
    const sendFn = this._getSendFn();
    const result = await this._rpc.request(sendFn, 'prompts/get', {
      name: promptName,
      arguments: args || {},
    });
    if (!result) return '[MCP: empty prompt result]';
    const messages = result.messages || [];
    if (messages.length === 0) return '[MCP: prompt returned no messages]';
    return messages.map(m => {
      const role = m.role || 'unknown';
      const content = m.content;
      if (!content) return `[${role}] (empty)`;
      if (typeof content === 'string') return `[${role}] ${content}`;
      if (Array.isArray(content)) {
        return content.map(c => {
          if (c.type === 'text') return c.text || '';
          return `[${c.type || 'unknown'}]`;
        }).filter(Boolean).join('\n');
      }
      return `[${role}] ${JSON.stringify(content)}`;
    }).filter(Boolean).join('\n\n');
  }

  async readResource(uri) {
    if (!this._connected) throw new Error(`MCP server "${this.name}" is not connected`);
    const sendFn = this._getSendFn();
    const result = await this._rpc.request(sendFn, 'resources/read', { uri });
    const contents = result?.contents || [];
    return contents.map(c => c.text || JSON.stringify(c)).join('\n');
  }

  // ── Internal ──

  _getSendFn() {
    if (this._proc?.stdin?.writable) {
      return (msg) => { this._proc.stdin.write(msg + '\n'); };
    }
    if (this._sseEndpoint) {
      return (msg) => {
        fetch(this._sseEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: msg,
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        }).then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          this._rpc.feed(JSON.stringify(json));
        }).catch((err) => {
          this._rpc.drain(new Error(`SSE RPC failed: ${err.message}`));
        });
      };
    }
    if (this._httpEndpoint) {
      return (msg) => {
        fetch(this._httpEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: msg,
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        }).then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          this._rpc.feed(JSON.stringify(json));
        }).catch((err) => {
          this._rpc.drain(new Error(`HTTP RPC failed: ${err.message}`));
        });
      };
    }
    throw new Error('No active transport');
  }

  async _initialize() {
    const sendFn = this._getSendFn();
    const result = await this._rpc.request(sendFn, 'initialize', {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this._serverInfo = result?.serverInfo || null;
    this._capabilities = result?.capabilities || null;
    this._rpc.notify(sendFn, 'notifications/initialized', {});
  }

  async _discover() {
    const sendFn = this._getSendFn();
    // Tools
    if (this._capabilities?.tools !== undefined || true) {
      try {
        const result = await this._rpc.request(sendFn, 'tools/list', {});
        this._tools = (result?.tools || []).map(t => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || {},
        }));
      } catch (err) {
        this._plugin.log(`tools/list failed for "${this.name}": ${err.message}`);
      }
    }
    // Resources
    if (this._capabilities?.resources !== undefined || true) {
      try {
        const result = await this._rpc.request(sendFn, 'resources/list', {});
        this._resources = (result?.resources || []).map(r => ({
          uri: r.uri, name: r.name || r.uri, description: r.description || '',
          mimeType: r.mimeType,
        }));
      } catch (err) {
        // resources/list is optional, not all servers support it
      }
    }
    // Prompts
    if (this._capabilities?.prompts !== undefined || true) {
      try {
        const result = await this._rpc.request(sendFn, 'prompts/list', {});
        this._prompts = (result?.prompts || []).map(p => ({
          name: p.name, description: p.description || '',
          arguments: p.arguments || [],
        }));
      } catch (err) {
        // prompts/list is optional
      }
    }
  }

  // ── Transport: stdio ──

  async _connectStdio() {
    const command = this._cfg.command;
    if (!command) throw new Error('No command configured');
    const [cmd, ...args] = command.split(/\s+/);
    this._proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Per-server env injection (Fix #2): merge custom env over process.env
      env: { ...process.env, ...(this._cfg.env || {}) },
    });
    // Read JSON-RPC responses line by line
    let buf = '';
    this._proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop() || ''; // keep incomplete line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this._rpc.feed(trimmed);
      }
    });
    this._proc.stderr.on('data', (chunk) => {
      this._plugin.log(`[${this.name}] stderr: ${chunk.toString().slice(0, 200)}`);
    });
    this._proc.on('exit', (code) => {
      this._plugin.log(`[${this.name}] process exited (code ${code})`);
      this._onDisconnected();
    });
    this._proc.on('error', (err) => {
      this._plugin.log(`[${this.name}] process error: ${err.message}`);
      this._onDisconnected();
    });
  }

  // ── Transport: SSE ──

  async _connectSSE() {
    const url = this._cfg.url;
    if (!url) throw new Error('No URL configured');
    const baseUrl = url.endsWith('/sse') ? url : `${url}/sse`;
    const resp = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`SSE connect failed: HTTP ${resp.status}`);

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No SSE stream body');

    const decoder = new TextDecoder();
    let buf = '';
    let endpoint = null;
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
    this._sseEndpoint = endpoint.startsWith('/')
      ? new URL(url).origin + endpoint
      : endpoint;

    // Start background SSE listener for server→client messages
    this._startSSEListener(baseUrl);
  }

  async _startSSEListener(sseUrl) {
    // Keep SSE connection alive for server→client notifications
    try {
      const resp = await fetch(sseUrl, { signal: AbortSignal.timeout(0) }); // no timeout
      const reader = resp.body?.getReader();
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
            try { this._rpc.feed(trimmed.slice(6)); } catch { /* non-JSON SSE data */ }
          }
        }
      }
      reader.cancel();
    } catch {
      if (this._connected) this._onDisconnected();
    }
  }

  // ── Transport: HTTP ──

  async _connectHTTP() {
    const url = this._cfg.url;
    if (!url) throw new Error('No URL configured');
    this._httpEndpoint = url;
  }

  // ── Health & Reconnect ──

  _startHealthCheck() {
    this._healthTimer = setInterval(async () => {
      if (!this._connected) return;
      try {
        const sendFn = this._getSendFn();
        await this._rpc.request(sendFn, 'ping', {}, 5_000);
      } catch {
        this._plugin.log(`[${this.name}] health check failed, disconnecting`);
        this._onDisconnected();
      }
    }, HEALTH_INTERVAL);
  }

  _stopHealthCheck() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
  }

  _onDisconnected() {
    const wasConnected = this._connected;
    this._connected = false;
    this._connecting = false;
    // Kill the process BEFORE nulling reference to prevent process leak (Fix #6)
    const proc = this._proc;
    this._proc = null;
    if (proc) {
      try { proc.kill('SIGTERM'); } catch {}
      // Force kill after 3s if still alive
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    }
    this._sseEndpoint = null;
    this._httpEndpoint = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._stopHealthCheck();
    this._rpc.drain(new Error('Disconnected'));
    if (wasConnected) {
      this._plugin._addLog('warn', this.name, 'Disconnected');
      this._plugin._emitState(this.name, 'disconnected');
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this._cancelReconnect();
    this._reconnectAttempts++;
    const delay = Math.min(RECONNECT_CAP, RECONNECT_BASE * Math.pow(2, this._reconnectAttempts - 1));
    this._plugin._addLog('info', this.name, `Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._plugin.log(`[${this.name}] reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._plugin._emitState(this.name, 'reconnecting', `attempt ${this._reconnectAttempts} in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => { /* scheduleReconnect will be called again from connect() */ });
    }, delay);
  }

  _cancelReconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }
}

// ═══════════════════════════════════════════════════════════════
// MCP Plugin — PluginBase class
// ═══════════════════════════════════════════════════════════════

export default class MCPPlugin extends PluginBase {
  constructor(api) { super(api); this._clients = new Map(); this._connectionLogs = []; this._maxLogs = 200; }

  // ── PluginBase lifecycle ──

  async onload() {
    this.log('MCP plugin activating');

    // Load config from memory (first run → seed from filesystem if exists)
    const config = await this._loadConfig();

    // Register agent tools — always available
    await this.registerTool({
      name: 'MCPListTools',
      description: 'List all connected MCP servers and their available tools. Use this to discover what external tools you can call via MCPExecute.',
      parametersSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Optional: filter to a specific server name.' },
        },
        required: [],
      },
      category: 'Integration',
    });

    await this.registerTool({
      name: 'MCPExecute',
      description: 'Execute a tool on a connected MCP server. Use MCPListTools first to discover available servers and tools. The tool name must exactly match one returned by MCPListTools.',
      parametersSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name (from MCPListTools).' },
          tool: { type: 'string', description: 'Tool name to call (from MCPListTools output).' },
          arguments: { type: 'object', description: 'Tool arguments as a JSON object matching the tool\'s input schema.' },
        },
        required: ['server', 'tool'],
      },
      category: 'Integration',
    });

    await this.registerTool({
      name: 'MCPListResources',
      description: 'List resources (files, data, etc.) available on connected MCP servers.',
      parametersSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Optional: filter to a specific server name.' },
        },
        required: [],
      },
      category: 'Integration',
    });

    // Fix #1: MCPListPrompts — discover prompts across servers
    await this.registerTool({
      name: 'MCPListPrompts',
      description: 'List all prompts exposed by connected MCP servers. Use MCPGetPrompt to invoke a specific prompt with arguments.',
      parametersSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Optional: filter to a specific server name.' },
        },
        required: [],
      },
      category: 'Integration',
    });

    // Fix #1: MCPGetPrompt — execute a prompt on an MCP server
    await this.registerTool({
      name: 'MCPGetPrompt',
      description: 'Execute a prompt on a connected MCP server by name, passing required arguments. Use MCPListPrompts first to discover available prompts and their arguments.',
      parametersSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name (from MCPListPrompts).' },
          prompt: { type: 'string', description: 'Prompt name to execute (from MCPListPrompts).' },
          arguments: { type: 'object', description: "Prompt arguments as a JSON object matching the prompt's argument schema." },
        },
        required: ['server', 'prompt'],
      },
      category: 'Integration',
    });

    await this.registerTool({
      name: 'MCPReadResource',
      description: 'Read a specific resource from a connected MCP server by its URI. Use MCPListResources first to discover available resource URIs.',
      parametersSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name.' },
          uri: { type: 'string', description: 'Resource URI (from MCPListResources).' },
        },
        required: ['server', 'uri'],
      },
      category: 'Integration',
    });

    // Register HTTP routes for frontend
    await this.registerRoute('GET', '/api/mcp/servers', 'handleListServers');
    await this.registerRoute('POST', '/api/mcp/servers', 'handleCreateServer');
    await this.registerRoute('DELETE', '/api/mcp/servers/:id', 'handleDeleteServer');
    await this.registerRoute('POST', '/api/mcp/servers/:id/reconnect', 'handleReconnectServer');
    await this.registerRoute('GET', '/api/mcp/servers/:id', 'handleGetServer');
    // Fix #3: PUT route — edit server config without delete+recreate
    await this.registerRoute('PUT', '/api/mcp/servers/:id', 'handleEditServer');
    // Connection logs endpoint
    await this.registerRoute('GET', '/api/mcp/logs', 'handleGetLogs');

    // Connect to configured servers
    for (const entry of config) {
      try {
        const client = new MCPClient(entry, this);
        await client.connect();
        this._clients.set(entry.name, client);
      } catch {
        // connect() already logs + schedules reconnect
        const client = new MCPClient(entry, this);
        this._clients.set(entry.name, client); // keep client registered even if first connect fails
      }
    }

    this.log(`MCP: ${this._clients.size} server(s) configured`);
  }

  async onunload() {
    this.log('MCP plugin deactivating');
    for (const [name, client] of this._clients) {
      try { await client.disconnect(); } catch {}
    }
    this._clients.clear();
  }

  // ── Agent tool execution ──

  async onToolExecute(toolName, params, ctx) {
    switch (toolName) {
      case 'MCPListTools': {
        if (this._clients.size === 0) {
          return 'No MCP servers configured. Go to the MCP page to add servers.';
        }
        const lines = [];
        for (const [name, client] of this._clients) {
          if (params.server && name !== params.server) continue;
          const status = client.connected ? 'connected' : 'disconnected';
          const info = client.serverInfo ? ` (${client.serverInfo.name || ''} v${client.serverInfo.version || ''})` : '';
          lines.push(`## ${name} [${status}]${info}`);
          if (client.connected) {
            for (const t of client.tools) {
              const schema = t.inputSchema?.properties
                ? ` — params: ${Object.keys(t.inputSchema.properties).join(', ')}`
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

      case 'MCPExecute': {
        const client = this._clients.get(params.server);
        if (!client) return `MCP server "${params.server}" not found. Use MCPListTools to see available servers.`;
        if (!client.connected) return `MCP server "${params.server}" is not connected. It may be reconnecting — try again shortly.`;
        return client.callTool(params.tool, params.arguments || {});
      }

      case 'MCPListResources': {
        if (this._clients.size === 0) return 'No MCP servers configured.';
        const lines = [];
        for (const [name, client] of this._clients) {
          if (params.server && name !== params.server) continue;
          lines.push(`## ${name} — ${client.resources.length} resources`);
          for (const r of client.resources) {
            lines.push(`  - \`${r.uri}\`: ${r.description || r.name || ''} ${r.mimeType ? `[${r.mimeType}]` : ''}`);
          }
          lines.push('');
        }
        return lines.join('\n') || 'No resources found.';
      }

      case 'MCPReadResource': {
        const client = this._clients.get(params.server);
        if (!client) return `MCP server "${params.server}" not found.`;
        if (!client.connected) return `MCP server "${params.server}" is not connected.`;
        return client.readResource(params.uri);
      }

      case 'MCPListPrompts': {
        if (this._clients.size === 0) return 'No MCP servers configured.';
        const lines = [];
        for (const [name, client] of this._clients) {
          if (params.server && name !== params.server) continue;
          const status = client.connected ? 'connected' : 'disconnected';
          lines.push(`## ${name} [${status}] — ${client.prompts.length} prompts`);
          if (client.connected) {
            for (const p of client.prompts) {
              const argsStr = (p.arguments || []).map(a => `${a.name}${a.required ? '*' : ''}`).join(', ');
              lines.push(`  - \`${p.name}\`: ${(p.description || '').slice(0, 150)}${argsStr ? ` — args: ${argsStr}` : ''}`);
            }
            if (client.prompts.length === 0) lines.push('  (no prompts exposed)');
          } else {
            lines.push('  (server not connected)');
          }
          lines.push('');
        }
        return lines.join('\n') || 'No prompts found.';
      }

      case 'MCPGetPrompt': {
        const client = this._clients.get(params.server);
        if (!client) return `MCP server "${params.server}" not found. Use MCPListPrompts to see available servers.`;
        if (!client.connected) return `MCP server "${params.server}" is not connected. It may be reconnecting — try again shortly.`;
        return client.getPrompt(params.prompt, params.arguments || {});
      }

      default:
        throw new Error(`Unknown MCP tool: ${toolName}`);
    }
  }

  // ── HTTP route handlers ──

  async handleListServers(_req) {
    const servers = [];
    for (const [name, client] of this._clients) {
      servers.push({
        id: client.id,
        name,
        transport: client.transportType,
        command: client._cfg.command,
        url: client._cfg.url,
        connected: client.connected,
        toolCount: client.tools.length,
        resourceCount: client.resources.length,
        serverInfo: client.serverInfo,
      });
    }
    return { status: 200, body: { servers } };
  }

  async handleGetServer(req) {
    const id = req.params?.id || '';
    for (const [name, client] of this._clients) {
      if (client.id === id || name === id) {
        return {
          status: 200,
          body: {
            id: client.id,
            name,
            transport: client.transportType,
            command: client._cfg.command,
            url: client._cfg.url,
            connected: client.connected,
            tools: client.tools,
            resources: client.resources,
            prompts: client.prompts,
            serverInfo: client.serverInfo,
            capabilities: client._capabilities,
          },
        };
      }
    }
    return { status: 404, body: { error: 'Server not found' } };
  }

  async handleCreateServer(req) {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body.name) return { status: 400, body: { error: 'name is required' } };
    if (!body.transport) body.transport = 'stdio';

    const config = await this._loadConfig();
    // Prevent duplicates
    const existing = config.findIndex(c => c.name === body.name);
    const entry = {
      id: body.id || `mcp_${Date.now().toString(36)}`,
      name: body.name,
      transport: body.transport,
      command: body.command || undefined,
      url: body.url || undefined,
    };
    if (existing >= 0) {
      config[existing] = entry; // replace
    } else {
      config.push(entry);
    }
    await this._saveConfig(config);

    // Connect immediately if not already
    if (!this._clients.has(body.name)) {
      const client = new MCPClient(entry, this);
      this._clients.set(body.name, client);
      client.connect().catch(() => {}); // fire-and-forget, reconnect handles it
    }

    return { status: 201, body: entry };
  }

  async handleDeleteServer(req) {
    const id = req.params?.id || '';
    const config = await this._loadConfig();
    const idx = config.findIndex(c => c.id === id || c.name === id);
    if (idx < 0) return { status: 404, body: { error: 'Not found' } };
    const entry = config[idx];
    // Disconnect + remove
    const client = this._clients.get(entry.name);
    if (client) {
      await client.disconnect();
      this._clients.delete(entry.name);
    }
    config.splice(idx, 1);
    await this._saveConfig(config);
    await this.api.ws.broadcast({ type: 'mcp:server-deleted', server: entry.name });
    return { status: 200, body: { deleted: true } };
  }

  async handleReconnectServer(req) {
    const id = req.params?.id || '';
    let client = null;
    for (const [name, c] of this._clients) {
      if (c.id === id || name === id) { client = c; break; }
    }
    if (!client) return { status: 404, body: { error: 'Server not found' } };
    try {
      await client.disconnect();
      await client.connect();
      return { status: 200, body: { name: client.name, connected: client.connected, toolCount: client.tools.length } };
    } catch (err) {
      return { status: 500, body: { error: err.message } };
    }
  }

  // Fix #3: Edit server — update config and reconnect
  async handleEditServer(req) {
    const id = req.params?.id || '';
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Invalid request body' } };

    const config = await this._loadConfig();
    const idx = config.findIndex(c => c.id === id || c.name === id);
    if (idx < 0) return { status: 404, body: { error: 'Server not found' } };

    const oldEntry = config[idx];
    // Merge updates — only overwrite provided fields
    const updated = {
      ...oldEntry,
      name: body.name || oldEntry.name,
      transport: body.transport || oldEntry.transport,
      command: body.command !== undefined ? body.command : oldEntry.command,
      url: body.url !== undefined ? body.url : oldEntry.url,
      env: body.env !== undefined ? body.env : oldEntry.env,
    };
    config[idx] = updated;
    await this._saveConfig(config);

    // Disconnect old client and reconnect with new config
    const oldClient = this._clients.get(oldEntry.name);
    if (oldClient) {
      await oldClient.disconnect();
      this._clients.delete(oldEntry.name);
    }

    // If name changed, remove old key
    if (oldEntry.name !== updated.name && this._clients.has(oldEntry.name)) {
      this._clients.delete(oldEntry.name);
    }

    const client = new MCPClient(updated, this);
    this._clients.set(updated.name, client);
    client.connect().catch(() => {});

    await this.api.ws.broadcast({ type: 'mcp:server-edited', server: updated.name, timestamp: Date.now() });
    return { status: 200, body: updated };
  }

  async handleGetLogs(req) {
    return { status: 200, body: { logs: this._connectionLogs } };
  }

  // ── State broadcast to frontend ──

  _emitState(name, status, detail) {
    this.api.ws.broadcast({
      type: 'mcp:state-change',
      server: name,
      status,
      detail: detail || '',
      timestamp: Date.now(),
    }).catch(() => {});
  }

  // Connection log ring buffer — last 200 entries for frontend

  _addLog(level, server, message) {
    const entry = { level, server, message, timestamp: Date.now() };
    this._connectionLogs.push(entry);
    if (this._connectionLogs.length > this._maxLogs) this._connectionLogs.shift();
    // Also broadcast to frontend via WS
    this.api.ws.broadcast({ type: 'mcp:log', log: entry }).catch(() => {});
  }

  // ── Config persistence ──

  async _loadConfig() {
    try {
      const data = await this.loadData();
      return (data?.servers) || [];
    } catch {
      return [];
    }
  }

  async _saveConfig(config) {
    const data = await this.loadData();
    data.servers = config;
    await this.saveData(data);
  }

  // ── Logging ──

  log(msg) {
    this.api.log.info(msg);
  }
}
