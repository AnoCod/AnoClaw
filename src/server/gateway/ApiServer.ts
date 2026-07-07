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

// Extracted handler functions (only those still used by legacy route() branches)
import {
  handleSessionMessages,
  handleSendMessage,
} from './handlers/SessionHandlers.js';

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

/** Same-host browser UI calls are trusted, but cross-origin localhost requests are not. */
const LOCAL_UI_TOKEN: ApiToken = {
  token: '__local_ui__',
  name: 'Local UI Call',
  permissions: Object.values(ApiPermission),
  createdAt: '',
  lastUsedAt: null,
};

function isLoopbackAddress(addr: string): boolean {
  return addr.startsWith('127.') || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAllowedLocalOrigin(origin: string | undefined, host: string, port: number): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const originPort = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', host.toLowerCase()]);
    const allowedPorts = new Set([port, 3456]);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && allowedHosts.has(hostname)
      && allowedPorts.has(originPort);
  } catch {
    return false;
  }
}

function parsePositiveLimit(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function titleCaseSegment(segment: string): string {
  return segment
    .replace(/^:/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'System';
}

function inferEndpointCategory(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  const resource = parts[2] || parts[1] || 'system';
  return titleCaseSegment(resource);
}

function fallbackEndpointDescription(method: string, pathname: string): string {
  const parts = pathname.split('/').filter(Boolean).slice(2);
  const resource = parts.filter((part) => !part.startsWith(':')).map(titleCaseSegment).join(' ');
  return `${method.toUpperCase()} ${resource || pathname}`;
}

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
  private _routeTable: RouteHandler[] = [];
  private _endpointRegistry: EndpointEntry[] = [];

  // Plugin HTTP routes
  private _pluginRoutes: Array<{ pluginName: string; method: string; path: string; handler: string; permission?: string }> = [];

  private constructor() {
    super();
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
    this._upsertEndpoint({
      method: handler.method,
      path: handler.path,
      description: handler.description || fallbackEndpointDescription(handler.method, handler.path),
      category: handler.category || inferEndpointCategory(handler.path),
    });
  }

  /** Register non-declarative endpoints (not backed by RouteHandler) for discovery. */
  registerNonDeclarativeEndpoint(method: string, path: string, description: string, category?: string): void {
    this._upsertEndpoint({
      method,
      path,
      description,
      category: category || inferEndpointCategory(path),
    });
  }

  private _upsertEndpoint(entry: EndpointEntry): void {
    const method = entry.method.toUpperCase();
    const existing = this._endpointRegistry.find((candidate) =>
      candidate.method.toUpperCase() === method && candidate.path === entry.path
    );
    if (existing) {
      existing.description = entry.description || existing.description;
      existing.category = entry.category || existing.category;
      return;
    }
    this._endpointRegistry.push({ ...entry, method });
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

    if (!isAllowedLocalOrigin(req.headers.origin, this.host, this.port)) {
      this.sendCorsHeaders(req, res);
      this.sendJson(res, 403, { error: 'Forbidden', message: 'Cross-origin localhost API requests are not allowed' });
      return;
    }

    if (method === 'OPTIONS') { this.sendCorsHeaders(req, res); res.writeHead(204); res.end(); return; }
    this.sendCorsHeaders(req, res);

    let token: ApiToken | null = null;
    if (pathname !== '/api/v1/health') {
      const remoteAddress = req.socket.remoteAddress || '';
      const isLocalhost = isLoopbackAddress(remoteAddress);
      token = this._authenticate(req);
      if (!token) {
        if (isLocalhost) token = LOCAL_UI_TOKEN;
        else { this.sendJson(res, 401, { error: 'Unauthorized', message: 'Invalid or missing Bearer token' }); return; }
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

    // Declarative route table (first priority)
    if (this._dispatchRouteTable(method, pathname, req, res, token)) return;

    // Endpoint discovery
    if (pathname === '/api/v1/endpoints' && method === 'GET') {
      send(res, 200, this._discoverEndpoints(req) as unknown as Record<string, unknown>);
      return;
    }

    // Session messages (legacy — /api/v1/sessions/:id/messages)
    const sessionMsgMatch = pathname.match(/^\/api\/v1\/sessions\/([a-zA-Z0-9_\-\.]+)\/messages$/);
    if (sessionMsgMatch && method === 'GET') { this.requirePermission(token, ApiPermission.MessagesRead); handleSessionMessages(sessionMsgMatch[1], res, send); return; }
    if (sessionMsgMatch && method === 'POST') { this.requirePermission(token, ApiPermission.MessagesSend); handleSendMessage(sessionMsgMatch[1], req, res, send, this.readBody.bind(this)); return; }

    // Plugin routes
    if (this._dispatchPluginRoute(method, pathname, req, res, token)) return;

    // 404
    send(res, 404, { error: 'Not Found', message: `No route for ${method} ${pathname}` });
  }

  // ── Declarative route table dispatch ──

  private _dispatchRouteTable(method: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse, token: ApiToken | null): boolean {
    for (const handler of this._routeTable) {
      if (handler.method !== method) continue;
      const match = matchRoute(handler.path, pathname);
      if (!match) continue;
      match.query = new URL(req.url || '/', `http://${this.host}:${this.port}`).searchParams;
      if (handler.permission && (!token || !hasPermission(token, handler.permission as ApiPermission))) {
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

  registerPluginRoutes(pluginName: string, routes: Array<{ method: string; path: string; handler: string; permission?: string }>): void {
    for (const r of routes) this._pluginRoutes.push({ pluginName, ...r });
    LogManager.getInstance().logger('anochat.api').info(`Plugin ${pluginName} registered ${routes.length} route(s)`);
  }

  private _discoverEndpoints(req: http.IncomingMessage): {
    endpoints: EndpointEntry[];
    total: number;
    availableTotal: number;
    filters: Record<string, string | number>;
  } {
    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    const search = (url.searchParams.get('q') || url.searchParams.get('search') || '').trim().toLowerCase();
    const method = (url.searchParams.get('method') || '').trim().toUpperCase();
    const category = (url.searchParams.get('category') || '').trim().toLowerCase();
    const limit = parsePositiveLimit(url.searchParams.get('limit'), 100, 200);

    let endpoints = [...this._endpointRegistry];
    if (method) endpoints = endpoints.filter((endpoint) => endpoint.method.toUpperCase() === method);
    if (category) endpoints = endpoints.filter((endpoint) => (endpoint.category || '').toLowerCase().includes(category));
    if (search) {
      const terms = search.split(/\s+/).filter(Boolean);
      endpoints = endpoints.filter((endpoint) => {
        const haystack = [
          endpoint.method,
          endpoint.path,
          endpoint.description,
          endpoint.category || '',
        ].join(' ').toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    const filters: Record<string, string | number> = {};
    if (search) filters.search = search;
    if (method) filters.method = method;
    if (category) filters.category = category;
    filters.limit = limit;

    return {
      endpoints: endpoints.slice(0, limit),
      total: endpoints.length,
      availableTotal: this._endpointRegistry.length,
      filters,
    };
  }

  private _dispatchPluginRoute(method: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse, token: ApiToken | null): boolean {
    for (const route of this._pluginRoutes) {
      if (method !== route.method) continue;
      const params = this._matchPluginPath(route.path, pathname);
      if (params === null) continue;
      if (route.permission && (!token || !hasPermission(token, route.permission as ApiPermission))) {
        this.sendJson(res, 403, { error: 'Forbidden', message: `Missing permission: ${route.permission}` });
        return true;
      }
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
    if (!token) {
      throw Object.assign(new Error(`Missing permission: ${permission}`), { statusCode: 403 });
    }
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

  public sendCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (isAllowedLocalOrigin(origin, this.host, this.port) && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
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
