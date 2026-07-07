// ApiCallTool - internal API dispatcher for agents
// Agents call this instead of SSH'ing into their own server.
// Routes through ApiServer.callInternal() - no HTTP overhead, no auth.
// Write endpoints (POST/PATCH/PUT/DELETE) require active WebSocket connection - returns 503 without one.

import { Tool, RiskLevel, InterruptBehavior } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { ApiServer } from '../../../gateway/ApiServer.js';

type ApiCallAction = 'call' | 'discover' | 'tools';
type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type QueryValue = string | number | boolean | Array<string | number | boolean> | null | undefined;

const ALLOWED_METHODS = new Set<ApiMethod>(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMethod(value: unknown): ApiMethod {
  const method = String(value || 'GET').toUpperCase() as ApiMethod;
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Unsupported method "${String(value)}". Use GET, POST, PATCH, PUT, or DELETE.`);
  }
  return method;
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: QueryValue): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(searchParams, key, item);
    return;
  }
  searchParams.append(key, String(value));
}

function buildApiPath(rawPath: string, pathParams?: Record<string, unknown>, query?: Record<string, unknown>): string {
  const [pathPart, queryPart = ''] = rawPath.split('?');
  const missing = new Set<string>();
  const substituted = pathPart.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_full, key: string) => {
    const value = pathParams?.[key];
    if (value === undefined || value === null || value === '') {
      missing.add(key);
      return `:${key}`;
    }
    return encodeURIComponent(String(value));
  });

  if (missing.size > 0) {
    throw new Error(`Missing path params: ${Array.from(missing).join(', ')}`);
  }

  const url = new URL(substituted + (queryPart ? `?${queryPart}` : ''), 'http://127.0.0.1');
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      appendQueryValue(url.searchParams, key, value as QueryValue);
    }
  }

  return `${url.pathname}${url.search}`;
}

function buildDiscoverPath(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  const search = typeof params.search === 'string' ? params.search.trim() : '';
  const category = typeof params.category === 'string' ? params.category.trim() : '';
  const method = typeof params.method === 'string' ? params.method.trim().toUpperCase() : '';
  const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(params.limit))) : undefined;

  if (search) query.set('q', search);
  if (category) query.set('category', category);
  if (method && ALLOWED_METHODS.has(method as ApiMethod)) query.set('method', method);
  if (limit) query.set('limit', String(limit));

  const qs = query.toString();
  return qs ? `/api/v1/endpoints?${qs}` : '/api/v1/endpoints';
}

function appendStringParam(query: URLSearchParams, key: string, value: unknown, outputKey: string = key): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed) query.set(outputKey, trimmed);
}

function appendBooleanParam(query: URLSearchParams, key: string, value: unknown, outputKey: string = key): void {
  if (typeof value === 'boolean') {
    query.set(outputKey, String(value));
    return;
  }
  if (typeof value !== 'string') return;
  const normalized = value.trim().toLowerCase();
  if (['true', 'false', '1', '0', 'yes', 'no'].includes(normalized)) {
    query.set(outputKey, normalized);
  }
}

function buildToolsPath(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  const limit = typeof params.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(params.limit))) : undefined;

  appendStringParam(query, 'search', params.search, 'q');
  appendStringParam(query, 'group', params.group);
  appendStringParam(query, 'source', params.source);
  appendStringParam(query, 'risk', params.risk);
  appendBooleanParam(query, 'readOnly', params.readOnly);
  appendBooleanParam(query, 'detail', params.detail);
  if (limit) query.set('limit', String(limit));

  const qs = query.toString();
  return qs ? `/api/v1/tools?${qs}` : '/api/v1/tools';
}

export class ApiCallTool extends Tool {

  static category = 'System';
  static toolDescription = 'Calls AnoClaw REST API endpoints directly - discover endpoints, search sessions, read agents, inspect memory.';

  name(): string { return 'ApiCall'; }

  description(): string {
    return 'Call AnoClaw REST API internally. No auth, no HTTP overhead. Use GET /api/v1/endpoints to discover available endpoints.';
  }

  prompt(): string {
    return '## ApiCall Usage\n' +
      'Call AnoClaw\'s internal REST API directly. No authentication needed - runs within the server process.\n\n' +
      '**Discover endpoints cheaply:** use `{ "action": "discover", "search": "agents" }` to find relevant endpoints without dumping the whole API list.\n\n' +
      '**Discover tools cheaply:** use `{ "action": "tools", "search": "memory search", "readOnly": true, "detail": true }` when choosing the right tool or checking exact parameters.\n\n' +
      '**Build paths safely:** for parameterized routes, pass `path` with placeholders plus `params`, e.g. `{ "path": "/api/v1/agents/:id", "params": { "id": "main-agent" } }`. Use `query` for query strings instead of hand-encoding URLs.\n\n' +
      '**Common use cases:** List sessions. Read agent configurations. Search memory entries. Get tool statistics. Inspect plugin status.\n\n' +
      'Write endpoints (POST/PATCH/PUT/DELETE) require an active WebSocket connection. Read endpoints work anytime.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['call', 'discover', 'tools'], description: 'Use "discover" to search API endpoints, "tools" to search available tools; default is "call".' },
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method. Default: GET.' },
        path:   { type: 'string', description: 'API path or path template, e.g. "/api/v1/agents/:id" or "/api/v1/search".' },
        params: { type: 'object', description: 'Named path params used to replace :placeholders in path.' },
        query:  { type: 'object', description: 'Query string object. Values are URL-encoded; arrays append repeated keys.' },
        body:   { type: 'object', description: 'JSON body for POST/PATCH/PUT/DELETE requests. Omit for GET.' },
        search: { type: 'string', description: 'Search text when action="discover" or action="tools".' },
        category: { type: 'string', description: 'Endpoint category filter when action="discover".' },
        group: { type: 'string', description: 'Tool group/category filter when action="tools".' },
        source: { type: 'string', enum: ['builtin', 'plugin', 'external'], description: 'Tool source filter when action="tools".' },
        risk: { type: 'string', enum: ['Safe', 'Low', 'Medium', 'High', 'Critical'], description: 'Tool risk filter when action="tools".' },
        readOnly: { type: 'boolean', description: 'Only return read-only tools when action="tools".' },
        detail: { type: 'boolean', description: 'Include full tool parameter schemas when action="tools".' },
        limit: { type: 'number', description: 'Maximum endpoints/tools to return. Endpoint discover caps at 200; tool discover caps at 500.' },
      },
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.High; }

  isReadOnly(): boolean { return false; }

  isConcurrencySafe(): boolean { return true; }

  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }

  defaultTimeoutMs(): number { return 15000; }

  outputLimit(): number { return 16000; }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const action: ApiCallAction = params.action === 'tools'
      ? 'tools'
      : params.action === 'discover' || (!params.path && typeof params.search === 'string')
        ? 'discover'
        : 'call';
    let method: ApiMethod;
    let path: string;
    const body = isRecord(params.body) ? params.body : undefined;

    try {
      method = action === 'call' ? normalizeMethod(params.method) : 'GET';
      if (action === 'discover') {
        path = buildDiscoverPath(params);
      } else if (action === 'tools') {
        path = buildToolsPath(params);
      } else {
        const rawPath = params.path as string;
        if (!rawPath || typeof rawPath !== 'string') {
          return this.makeError('path is required for action="call" (e.g. "/api/v1/search" with query: { "q": "test" })');
        }
        path = buildApiPath(rawPath, isRecord(params.params) ? params.params : undefined, isRecord(params.query) ? params.query : undefined);
      }
    } catch (err) {
      return this.makeError((err as Error).message);
    }

    // Only allow API paths
    if (!path.startsWith('/api/')) {
      return this.makeError('Only /api/ paths are allowed');
    }

    try {
      const api = ApiServer.getInstance();
      const { statusCode, body: resultBody } = await api.callInternal(method, path, body);

      const content = JSON.stringify(resultBody, null, 2);

      if (statusCode >= 400) {
        return this.makeError(`API ${statusCode}: ${content}`);
      }

      return this.makeResult(content, {
        structured: {
          action,
          statusCode,
          path,
          method,
          resultCount: Array.isArray(resultBody)
            ? resultBody.length
            : Array.isArray(resultBody.endpoints)
              ? resultBody.endpoints.length
              : Array.isArray(resultBody.tools)
                ? resultBody.tools.length
              : undefined,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.makeError(`ApiCall failed: ${msg}`);
    }
  }

  // ── UI helpers ──

  userFacingName(_input?: Record<string, unknown>): string {
    if (_input?.action === 'tools') return 'Tools';
    if (_input?.action === 'discover' || (!_input?.path && _input?.search)) return 'API endpoints';
    const path = (_input?.path as string) || '';
    const short = path.split('?')[0];
    return `API ${short}`;
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (input?.action === 'tools') {
      const search = (input?.search as string) || '';
      return search ? `tools: ${search}` : 'discover tools';
    }
    if (input?.action === 'discover' || (!input?.path && input?.search)) {
      const search = (input?.search as string) || '';
      return search ? `discover: ${search}` : 'discover endpoints';
    }
    const path = (input?.path as string) || '';
    const short = path.split('?')[0];
    return short.length > 60 ? short.slice(0, 57) + '...' : short;
  }
}
