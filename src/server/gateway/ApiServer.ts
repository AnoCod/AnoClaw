/**
 * ApiServer — HTTP REST API server
 *
 * Serves the AnoClaw v2 REST API on port 15730 (localhost only).
 * Handlers have been extracted to `src/server/gateway/handlers/` to keep this file lean.
 *
 * @public
 */
import { EventEmitter } from 'events';
import * as http from 'http';
import { API_PORT, DEFAULT_HOST } from '../../shared/constants.js';
import { validateToken, hasPermission } from './ApiAuth.js';
import type { ApiToken } from './ApiAuth.js';
import { ApiPermission } from '../../shared/types/gateway.js';
import { LogManager } from '../infra/logging/LogManager.js';

// Route handler interface
import type { RouteHandler, RouteMatch } from './RouteHandler.js';
import { matchRoute } from './RouteHandler.js';

// Route groups
import { MemoryRoutes } from './routes/MemoryRoutes.js';

// Extracted handler functions
import {
  handleListSessions, handleCreateSession, handleGetSession, handleArchiveSession,
  handleClearAllSessions, handleRenameSession, handleAutoTitle, handleSessionMessages,
  handleSendMessage, handleSessionToolStats, handleGlobalToolStats, handleSearchSessions,
  handleGetOverview,
} from './handlers/SessionHandlers.js';
import {
  handleListAgents, handleGetAgent, handleCreateAgent, handleUpdateAgent, handleDeleteAgent,
  handleAgentStatus,
} from './handlers/AgentHandlers.js';
import { handleInlineSuggest } from './handlers/InlineSuggestHandler.js';
import {
  handleHealth, handleStats, handleGetLogEntries, handleOpenFile,
} from './handlers/SystemHandlers.js';
import {
  handleListTools, handleListCommands,
} from './handlers/ToolHandlers.js';

// ── Types ──

interface EndpointEntry {
  method: string;
  path: string;
  description: string;
  category?: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/** Internal token used by ApiCallTool — has all permissions, bypasses rate limiting */
const INTERNAL_TOKEN: ApiToken = {
  token: '__internal__',
  name: 'Internal Agent Call',
  permissions: Object.values(ApiPermission),
  createdAt: '',
  lastUsedAt: null,
};

// ── ApiServer ──

export class ApiServer extends EventEmitter {
  private static _instance: ApiServer;

  private server: http.Server | null = null;
  private port: number = API_PORT;
  private host: string = DEFAULT_HOST;

  // Rate limiting
  private rateLimit: Map<string, RateLimitEntry> = new Map();
  private globalRateCount: number = 0;
  private globalRateReset: number = 0;
  private requestsPerMinute: number = 60;
  private globalRequestsPerMinute: number = 300;

  // Route handler modules
  private _memoryRoutes?: MemoryRoutes;
  private _routeTable: RouteHandler[] = [];
  private _endpointRegistry: EndpointEntry[] = [];

  // Plugin HTTP routes
  private _pluginRoutes: Array<{ pluginName: string; method: string; path: string; handler: string }> = [];

  private constructor() {
    super();
    this._initEndpointRegistry();
  }

  static getInstance(): ApiServer {
    if (!ApiServer._instance) {
      ApiServer._instance = new ApiServer();
    }
    return ApiServer._instance;
  }

  // ── Route Registration ──

  registerRoute(handler: RouteHandler): void {
    this._routeTable.push(handler);
    if (handler.description) {
      this._endpointRegistry.push({
        method: handler.method, path: handler.path,
        description: handler.description, category: handler.category,
      });
    }
  }

  registerEndpoint(method: string, path: string, description: string, category?: string): void {
    this._endpointRegistry.push({ method, path, description, category });
  }

  private _initEndpointRegistry(): void {
    const R = (m: string, p: string, d: string, c?: string) => this.registerEndpoint(m, p, d, c);

    // System
    R('GET', '/api/v1/health', 'Server health + version + uptime', 'System');
    R('GET', '/api/v1/system/info', 'Process info: uptime, memory, agent/session counts', 'System');
    R('GET', '/api/v1/stats', 'Global agent/session/memory stats', 'System');
    R('GET', '/api/v1/logs/entries?count=200', 'Read recent log entries by category', 'System');
    R('GET', '/api/v1/logs/search?q=...&limit=50', 'Search log entries by keyword', 'System');
    R('PUT', '/api/v1/logs/level', 'Set minimum log level (body: { level })', 'System');
    R('GET', '/api/v1/settings', 'Read full settings (hides apiKey)', 'System');
    R('PUT', '/api/v1/settings/:key', 'Update a setting value (body: { value })', 'System');
    R('GET', '/api/v1/settings/ui', 'Read UI settings', 'System');
    R('PUT', '/api/v1/settings/ui', 'Update UI settings', 'System');
    R('GET', '/api/v1/endpoints', 'Discover all API endpoints (this list)', 'System');
    R('GET', '/api/v1/prompt/cache-stats', 'Prompt cache hit/miss statistics', 'System');
    R('POST', '/api/v1/prompt/clear-cache', 'Clear all prompt caches', 'System');
    R('GET', '/api/v1/prompt/sections', 'List registered prompt sections', 'System');
    R('PUT', '/api/v1/prompt/custom-cli', 'Set runtime CustomCLI instructions (body: { instructions })', 'System');
    R('GET', '/api/v1/ws/connections', 'List active WebSocket connections', 'System');
    R('POST', '/api/v1/ws/broadcast', 'Broadcast message to all WS clients', 'System');

    // Sessions
    R('GET', '/api/v1/sessions', 'List all sessions', 'Sessions');
    R('POST', '/api/v1/sessions', 'Create a new session', 'Sessions');
    R('GET', '/api/v1/sessions/tree', 'Full session hierarchy tree', 'Sessions');
    R('GET', '/api/v1/sessions/:id', 'Get session details', 'Sessions');
    R('GET', '/api/v1/sessions/:id/tree', 'Session subtree', 'Sessions');
    R('PATCH', '/api/v1/sessions/:id', 'Rename a session', 'Sessions');
    R('DELETE', '/api/v1/sessions/:id', 'Archive a session', 'Sessions');
    R('DELETE', '/api/v1/sessions/:id/permanent', 'Hard-delete session from disk', 'Sessions');
    R('POST', '/api/v1/sessions/clear', 'Clear all sessions', 'Sessions');
    R('POST', '/api/v1/sessions/gc', 'Garbage collect idle >90 day sessions', 'Sessions');
    R('GET', '/api/v1/sessions/:id/messages', 'Read session message history', 'Sessions');
    R('POST', '/api/v1/sessions/:id/messages', 'Send message (triggers Agent execution)', 'Sessions');
    R('GET', '/api/v1/sessions/:id/overview', 'Session overview', 'Sessions');
    R('POST', '/api/v1/sessions/:id/auto-title', 'Auto-generate session title via LLM', 'Sessions');
    R('GET', '/api/v1/sessions/:id/tool-stats', 'Per-session tool usage stats', 'Sessions');
    R('POST', '/api/v1/sessions/:id/interrupt', 'Interrupt a running session', 'Sessions');
    R('GET', '/api/v1/sessions/:id/interrupt-status', 'Check interrupt status', 'Sessions');
    R('GET', '/api/v1/sessions/:id/parent', 'Get parent session', 'Sessions');
    R('GET', '/api/v1/sessions/:id/root', 'Get root (top-level) session', 'Sessions');
    R('GET', '/api/v1/sessions/:id/background-tasks', 'Active background delegation tasks', 'Sessions');
    R('PATCH', '/api/v1/sessions/:id/metadata', 'Set session metadata (body: { key, value })', 'Sessions');

    // Search
    R('GET', '/api/v1/search?q=...', 'Unified search: session messages + cross-session memories', 'Search');

    // Agents
    R('GET', '/api/v1/agents', 'List all agents', 'Agents');
    R('GET', '/api/v1/agents/org-tree', 'Agent organization tree', 'Agents');
    R('GET', '/api/v1/agents/:id', 'Get agent config', 'Agents');
    R('GET', '/api/v1/agents/:id/status', 'Agent runtime status', 'Agents');
    R('GET', '/api/v1/agents/:id/report-chain', 'Report chain up to CEO', 'Agents');
    R('GET', '/api/v1/agents/:id/prompt?sessionId=...', 'Preview effective system prompt', 'Agents');
    R('PATCH', '/api/v1/agents/:id', 'Update agent config', 'Agents');
    R('PATCH', '/api/v1/agents/:id/state', 'Activate/destroy agent (body: { state })', 'Agents');
    R('PATCH', '/api/v1/agents/:id/parent', 'Move agent in org tree (body: { parentAgentId, level })', 'Agents');
    R('POST', '/api/v1/agents/reload', 'Reload all agent configs from disk', 'Agents');
    R('GET', '/api/v1/agents-find?q=...', 'Fuzzy-find agent by ID or name', 'Agents');
    R('GET', '/api/v1/agents-filtered?role=&parent=', 'List agents by role or parent filter', 'Agents');

    // Tools
    R('GET', '/api/v1/tools', 'List all registered tools', 'Tools');
    R('GET', '/api/v1/tools/groups', 'List tools organized by group', 'Tools');
    R('GET', '/api/v1/tools/:name', 'Get tool detail (params, risk, timeout)', 'Tools');
    R('GET', '/api/v1/tools-for-agent/:agentId', 'Tools available to an agent (respects allowlist)', 'Tools');
    R('POST', '/api/v1/tools/execute', 'Execute a tool directly', 'Tools');
    R('GET', '/api/v1/commands', 'List slash commands', 'Tools');
    R('GET', '/api/v1/tools/stats', 'Global tool call statistics', 'Tools');

    // Skills
    R('GET', '/api/v1/skills', 'List all loaded skills', 'Skills');
    R('GET', '/api/v1/skills/:name', 'Get skill detail with full body', 'Skills');
    R('GET', '/api/v1/skills/for-agent/:agentId', 'Skills available to an agent', 'Skills');
    R('POST', '/api/v1/skills/reload', 'Reload all skills from disk', 'Skills');
    R('POST', '/api/v1/skills/auto-generate', 'Auto-generate SKILL.md from transcript', 'Skills');

    // Memory
    R('GET', '/api/v1/memory', 'List all memory entries', 'Memory');
    R('GET', '/api/v1/memory/search?q=...&scope=all&type=&agent=&limit=50', 'Fuzzy search memories with filters', 'Memory');
    R('POST', '/api/v1/memory', 'Create a new memory entry', 'Memory');
    R('PATCH', '/api/v1/memory/:id', 'Update a memory entry', 'Memory');
    R('DELETE', '/api/v1/memory/:id', 'Delete a memory entry', 'Memory');
    R('POST', '/api/v1/memory/extract', 'Auto-extract facts from text (body: { text, agentId })', 'Memory');

    // Meetings, Workflows, MCP, Gateway — served by plugins via _dispatchPluginRoute()

    // System utilities
    R('POST', '/api/v1/system/open-file', 'Open file in OS file manager', 'System');

    // Plugin management
    R('GET', '/api/v1/plugins', 'List all plugins', 'Plugins');
    R('GET', '/api/v1/plugins/:name', 'Plugin detail with tools', 'Plugins');
    R('GET', '/api/v1/plugins/status', 'Plugin host worker health check', 'Plugins');
    R('GET', '/api/v1/plugins/extensions', 'Extension point overrides', 'Plugins');
    R('GET', '/api/v1/plugins/:name/storage', 'List storage keys', 'Plugins');
    R('GET', '/api/v1/plugins/:name/storage/:key', 'Read storage value', 'Plugins');
    R('PUT', '/api/v1/plugins/:name/storage/:key', 'Write storage value', 'Plugins');
    R('GET', '/api/v1/plugins/:name/config', 'Read plugin config', 'Plugins');
    R('PUT', '/api/v1/plugins/:name/config', 'Write plugin config', 'Plugins');
    R('POST', '/api/v1/plugins/reload', 'Reload a plugin', 'Plugins');
    R('POST', '/api/v1/plugins/install', 'Install plugin from URL', 'Plugins');
    R('GET', '/api/v1/plugins/market', 'Plugin marketplace', 'Plugins');
    R('DELETE', '/api/v1/plugins/:name', 'Uninstall plugin', 'Plugins');
  }

  // ── Lifecycle ──

  start(port?: number, host?: string): void {
    if (this.server) throw new Error('ApiServer is already running');
    if (port !== undefined) this.port = port;
    if (host !== undefined) this.host = host;

    this.server = http.createServer((req, res) => { this.handleApiRequest(req, res); });

    this.server.listen(this.port, this.host, () => {
      LogManager.getInstance().logger('anochat.api').info('API server started', { host: this.host, port: this.port });
      this.emit('started', this.port);
    });

    this.server.on('error', (err: Error) => {
      LogManager.getInstance().logger('anochat.api').error('API server error', { error: err.message });
      this.emit('error', err);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) { resolve(); return; }
      this.server.close((err?: Error) => {
        if (err) reject(err);
        else { this.server = null; this.emit('stopped'); resolve(); }
      });
    });
  }

  isRunning(): boolean { return this.server !== null && this.server.listening; }

  setRateLimit(requestsPerMinute: number): void { this.requestsPerMinute = requestsPerMinute; }

  // ── Request handler ──

  async handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const pathname = url.pathname;
    this.emit('requestReceived', method, pathname);

    if (method === 'OPTIONS') { this.sendCorsHeaders(res); res.writeHead(204); res.end(); return; }
    this.sendCorsHeaders(res);

    let token: ApiToken | null = null;
    if (pathname !== '/api/v1/health') {
      const isLocalhost = (req.socket.remoteAddress || '').startsWith('127.') || (req.socket.remoteAddress || '') === '::1';
      if (!isLocalhost) {
        token = this._authenticate(req);
        if (!token) { this.sendJson(res, 401, { error: 'Unauthorized', message: 'Invalid or missing Bearer token' }); return; }
      }
    }

    if (token && !this.checkRateLimit(token.token)) {
      res.setHeader('Retry-After', '60');
      this.sendJson(res, 429, { error: 'Too Many Requests', message: 'Rate limit exceeded' });
      return;
    }

    try { this.route(method, pathname, req, res, token); }
    catch (err) { this.sendJson(res, 500, { error: 'Internal Server Error', message: (err as Error).message }); }
  }

  // ── Router ──

  private route(method: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse, token: ApiToken | null): void {
    const send = this.sendJson.bind(this);
    const read = this.readBody.bind(this);

    // Declarative route table (first priority)
    if (this._dispatchRouteTable(method, pathname, req, res, token)) return;

    // Health
    if (pathname === '/api/v1/health' && method === 'GET') { handleHealth(res, send); return; }

    // Endpoint discovery
    if (pathname === '/api/v1/endpoints' && method === 'GET') {
      send(res, 200, { endpoints: this._endpointRegistry, total: this._endpointRegistry.length } as unknown as Record<string, unknown>);
      return;
    }

    // Stats
    if (pathname === '/api/v1/stats' && method === 'GET') { this.requirePermission(token, ApiPermission.Admin); handleStats(res, send); return; }

    // Logs
    if (pathname === '/api/v1/logs/entries' && method === 'GET') { handleGetLogEntries(req, res, send, this.host, this.port); return; }

    // Memory
    if (!this._memoryRoutes) this._memoryRoutes = new MemoryRoutes(this);
    if (this._memoryRoutes.handle(method, pathname, req, res, token)) return;

    // Sessions collection
    if (pathname === '/api/v1/sessions' && method === 'GET') { this.requirePermission(token, ApiPermission.SessionsRead); handleListSessions(req, res, send, this.host); return; }
    if (pathname === '/api/v1/search' && method === 'GET') { this.requirePermission(token, ApiPermission.SessionsRead); handleSearchSessions(req, res, send); return; }
    if (pathname === '/api/v1/sessions' && method === 'POST') { this.requirePermission(token, ApiPermission.SessionsWrite); handleCreateSession(req, res, send, read); return; }

    // Session by ID — messages
    const sessionMsgMatch = pathname.match(/^\/api\/v1\/sessions\/([a-zA-Z0-9_\-\.]+)\/messages$/);
    if (sessionMsgMatch && method === 'GET') { this.requirePermission(token, ApiPermission.MessagesRead); handleSessionMessages(sessionMsgMatch[1], res, send); return; }
    if (sessionMsgMatch && method === 'POST') { this.requirePermission(token, ApiPermission.MessagesSend); handleSendMessage(sessionMsgMatch[1], req, res, send, read); return; }

    // Session overview
    const overviewMatch = pathname.match(/^\/api\/v1\/sessions\/([a-zA-Z0-9_\-\.]+)\/overview$/);
    if (overviewMatch && method === 'GET') { this.requirePermission(token, ApiPermission.SessionsRead); handleGetOverview(overviewMatch[1], res, send); return; }

    // Session tool stats
    const toolStatsMatch = pathname.match(/^\/api\/v1\/sessions\/([a-zA-Z0-9_\-\.]+)\/tool-stats$/);
    if (toolStatsMatch && method === 'GET') { this.requirePermission(token, ApiPermission.SessionsRead); handleSessionToolStats(toolStatsMatch[1], res, send); return; }

    // Global tool stats
    if (pathname === '/api/v1/tools/stats' && method === 'GET') { this.requirePermission(token, ApiPermission.SessionsRead); handleGlobalToolStats(res, send); return; }

    // Session auto-title
    const autoTitleMatch = pathname.match(/^\/api\/v1\/sessions\/([a-zA-Z0-9_\-\.]+)\/auto-title$/);
    if (autoTitleMatch && method === 'POST') { this.requirePermission(token, ApiPermission.SessionsWrite); handleAutoTitle(autoTitleMatch[1], req, res, send, read); return; }

    // Session by ID
    const sessionByIdMatch = pathname.match(/^\/api\/v1\/sessions\/([a-zA-Z0-9_\-\.]+)$/);
    if (sessionByIdMatch && method === 'GET') { this.requirePermission(token, ApiPermission.SessionsRead); handleGetSession(sessionByIdMatch[1], res, send); return; }
    if (sessionByIdMatch && method === 'DELETE') { this.requirePermission(token, ApiPermission.SessionsWrite); handleArchiveSession(sessionByIdMatch[1], res, send); return; }
    if (pathname === '/api/v1/sessions/clear' && method === 'POST') { this.requirePermission(token, ApiPermission.SessionsWrite); handleClearAllSessions(res, send); return; }
    if (sessionByIdMatch && method === 'PATCH') { this.requirePermission(token, ApiPermission.SessionsWrite); handleRenameSession(sessionByIdMatch[1], req, res, send, read); return; }

    // Tools
    if (pathname === '/api/v1/tools' && method === 'GET') { handleListTools(res, send); return; }
    if (pathname === '/api/v1/commands' && method === 'GET') { handleListCommands(res, send); return; }

    // Agents
    if (pathname === '/api/v1/agents' && method === 'GET') { this.requirePermission(token, ApiPermission.AgentsRead); handleListAgents(res, send); return; }
    if (pathname === '/api/v1/agents' && method === 'POST') { this.requirePermission(token, ApiPermission.AgentsWrite); handleCreateAgent(req, res, send, read); return; }

    const agentStatusMatch = pathname.match(/^\/api\/v1\/agents\/([a-zA-Z0-9_\-]+)\/status$/);
    if (agentStatusMatch && method === 'GET') { this.requirePermission(token, ApiPermission.AgentsRead); handleAgentStatus(agentStatusMatch[1], res, send); return; }

    const agentByIdMatch = pathname.match(/^\/api\/v1\/agents\/([a-zA-Z0-9_\-]+)$/);
    if (agentByIdMatch && method === 'GET') { this.requirePermission(token, ApiPermission.AgentsRead); handleGetAgent(agentByIdMatch[1], res, send); return; }
    if (agentByIdMatch && method === 'PATCH') { this.requirePermission(token, ApiPermission.AgentsWrite); handleUpdateAgent(agentByIdMatch[1], req, res, send, read); return; }
    if (agentByIdMatch && method === 'DELETE') { this.requirePermission(token, ApiPermission.AgentsWrite); handleDeleteAgent(agentByIdMatch[1], req, res, send, this.host); return; }

    // Plugin routes
    if (this._dispatchPluginRoute(method, pathname, req, res)) return;

    // System utilities
    if (pathname === '/api/v1/system/open-file' && method === 'POST') { handleOpenFile(req, res, send, read); return; }

    // Inline code completion
    if (pathname === '/api/v1/inline-suggest' && method === 'POST') { handleInlineSuggest(req, res, send, read); return; }

    // 404
    send(res, 404, { error: 'Not Found', message: `No route for ${method} ${pathname}` });
  }

  // ── Declarative route table dispatch ──

  private _dispatchRouteTable(method: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse, token: ApiToken | null): boolean {
    for (const handler of this._routeTable) {
      if (handler.method !== method) continue;
      const match = matchRoute(handler.path, pathname);
      if (!match) continue;
      if (handler.permission && token && !hasPermission(token, handler.permission as ApiPermission)) {
        this.sendJson(res, 403, { error: 'Forbidden', message: `Missing permission: ${handler.permission}` });
        return true;
      }
      try {
        const handled = handler.handle(match, req, res, token);
        if (handled instanceof Promise) {
          handled.catch((err: unknown) => {
            if (!res.headersSent) {
              this.sendJson(res, 500, { error: 'Handler Error', message: (err as Error).message || 'Unknown error' });
            }
          });
          return true;
        }
        if (handled) return true;
      } catch (err) {
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: 'Handler Error', message: (err as Error).message });
        }
        return true;
      }
    }
    return false;
  }

  // ── Plugin HTTP route dispatch ──

  registerPluginRoutes(pluginName: string, routes: Array<{ method: string; path: string; handler: string }>): void {
    for (const r of routes) this._pluginRoutes.push({ pluginName, ...r });
    LogManager.getInstance().logger('anochat.api').info(`Plugin ${pluginName} registered ${routes.length} route(s)`);
  }

  private _dispatchPluginRoute(method: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
    for (const route of this._pluginRoutes) {
      if (method !== route.method) continue;
      const params = this._matchPluginPath(route.path, pathname);
      if (params === null) continue;
      this._executePluginHandler(route.pluginName, route.handler, req, params).then(result => {
        const r = result as { status: number; body: Record<string, unknown> } | null;
        if (r && typeof r === 'object' && 'status' in r) this.sendJson(res, r.status, r.body || {});
        else this.sendJson(res, 500, { error: 'Plugin handler returned invalid result' });
      }).catch(err => {
        this.sendJson(res, 500, { error: 'Plugin handler error', message: (err as Error).message });
      });
      return true;
    }
    return false;
  }

  private _matchPluginPath(pattern: string, pathname: string): Record<string, string> | null {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = pathParts[i];
      else if (patternParts[i] !== pathParts[i]) return null;
    }
    return params;
  }

  private async _executePluginHandler(pluginName: string, handler: string, req: http.IncomingMessage, params: Record<string, string>): Promise<unknown> {
    const body = await this.readBody(req).catch(() => ({}));
    const { PluginHostManager } = await import('../core/plugin-host/PluginHostManager.js');
    return PluginHostManager.getInstance().executeHandler(pluginName, handler, { body, params, query: req.url?.split('?')[1] || '' });
  }

  // ── Internal API dispatch ──

  async callInternal(method: string, path: string, body?: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const req = new InternalRequest(method, path, body);
      const res = new CollectingResponse();
      const origEnd = res.end.bind(res) as (data?: string) => void;
      res.end = (data?: string) => { res._captured = true; origEnd(data); resolve({ statusCode: res.statusCode, body: res._body }); };
      // Always emit 'end' — even for empty body. readBody() waits for it.
      setImmediate(() => {
        if (req._bodyChunks.length > 0) {
          for (const c of req._bodyChunks) req.emit('data', c);
        }
        req.emit('end');
      });
      this.route(method, new URL(path, `http://127.0.0.1:${this.port}`).pathname, req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, INTERNAL_TOKEN);
    });
  }

  // ── Auth ──

  private _authenticate(req: http.IncomingMessage): ApiToken | null {
    const header = req.headers['authorization'];
    if (!header) return null;
    const parts = header.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
    return validateToken(parts[1]);
  }

  public requirePermission(token: ApiToken | null, permission: ApiPermission): asserts token is ApiToken {
    if (!token) return; // Localhost without token — allow all
    if (!hasPermission(token, permission)) {
      throw Object.assign(new Error(`Missing permission: ${permission}`), { statusCode: 403 });
    }
  }

  // ── Rate limiting ──

  private checkRateLimit(tokenStr: string): boolean {
    if (tokenStr === '__internal__') return true;
    const now = Date.now();

    if (now > this.globalRateReset) { this.globalRateCount = 0; this.globalRateReset = now + 60_000; }
    if (this.globalRateCount >= this.globalRequestsPerMinute) return false;
    this.globalRateCount++;

    let entry = this.rateLimit.get(tokenStr);
    if (!entry || now > entry.resetAt) { entry = { count: 0, resetAt: now + 60_000 }; this.rateLimit.set(tokenStr, entry); }
    if (entry.count >= this.requestsPerMinute) return false;
    entry.count++;

    if (this.rateLimit.size > 1000) {
      const toDel: string[] = [];
      for (const [k, v] of this.rateLimit) { if (now > v.resetAt) toDel.push(k); }
      for (const k of toDel) this.rateLimit.delete(k);
    }

    return true;
  }

  // ── CORS ──

  public sendCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  // ── Utilities ──

  public sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  public readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const MAX_BODY = 5 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      let bodySize = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY) { req.destroy(); reject(Object.assign(new Error('Request body too large'), { statusCode: 413 })); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) { resolve({}); return; }
        try { resolve(JSON.parse(raw)); }
        catch (err) { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
      });
      req.on('error', reject);
    });
  }
}

// ── Internal dispatch helpers ──

class InternalRequest extends EventEmitter {
  public method: string;
  public url: string;
  public headers: Record<string, string | string[] | undefined>;
  public socket: Record<string, unknown>;
  _bodyChunks: Buffer[];

  constructor(method: string, path: string, body?: Record<string, unknown>) {
    super();
    this.method = method;
    this.url = path;
    this.headers = { 'content-type': 'application/json' };
    this.socket = { remoteAddress: '127.0.0.1' };
    this._bodyChunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  }
}

class CollectingResponse extends EventEmitter {
  statusCode = 200;
  _headers: Record<string, string> = {};
  _body: Record<string, unknown> = {};
  _captured = false;
  _writeBuffer = '';

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    if (headers) Object.assign(this._headers, headers);
    return this;
  }

  setHeader(_name: string, _value: string): void { this._headers[_name.toLowerCase()] = _value; }
  getHeader(name: string): string | undefined { return this._headers[name.toLowerCase()]; }
  write(chunk: string): boolean { this._writeBuffer += chunk; return true; }

  end(data?: string): void {
    if (data !== undefined) this._writeBuffer += data;
    try { this._body = JSON.parse(this._writeBuffer); }
    catch { this._body = { _raw: this._writeBuffer }; }
    this.emit('finish');
  }
}
