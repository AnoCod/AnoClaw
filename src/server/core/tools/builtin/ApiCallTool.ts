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

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RESPONSE_CHARS = 16000;
const MAX_RESPONSE_CHARS = 100000;
const MAX_API_PATH_CHARS = 4096;

const ALLOWED_METHODS = new Set<ApiMethod>(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const ALLOWED_ACTIONS = new Set<ApiCallAction>(['call', 'discover', 'tools']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAction(params: Record<string, unknown>): ApiCallAction {
  const raw = params.action;
  if (raw === undefined || raw === null || raw === '') {
    return !params.path && typeof params.search === 'string' ? 'discover' : 'call';
  }
  if (typeof raw !== 'string') throw new Error('action must be a string');
  const action = raw.trim() as ApiCallAction;
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Unsupported action "${raw}". Use call, discover, or tools.`);
  }
  return action;
}

function normalizeMethod(value: unknown): ApiMethod {
  const method = String(value || 'GET').toUpperCase() as ApiMethod;
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Unsupported method "${String(value)}". Use GET, POST, PATCH, PUT, or DELETE.`);
  }
  return method;
}

function normalizeInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return normalized;
}

function normalizeBody(value: unknown, method: ApiMethod, action: ApiCallAction): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (action !== 'call') throw new Error('body is only supported when action="call"');
  if (method === 'GET') throw new Error('body is not supported for GET requests; use query instead');
  if (!isRecord(value)) throw new Error('body must be a JSON object');
  return value;
}

function normalizeQueryValue(key: string, value: unknown): QueryValue {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return item;
      throw new Error(`query.${key} arrays may only contain strings, numbers, or booleans`);
    });
  }
  throw new Error(`query.${key} must be a string, number, boolean, array, null, or undefined`);
}

function normalizeQuery(value: unknown): Record<string, QueryValue> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('query must be a JSON object');
  const query: Record<string, QueryValue> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!key.trim()) throw new Error('query keys must not be empty');
    query[key] = normalizeQueryValue(key, rawValue);
  }
  return query;
}

function normalizePathParams(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('params must be a JSON object');
  for (const [key, rawValue] of Object.entries(value)) {
    if (!key.trim()) throw new Error('params keys must not be empty');
    if (Array.isArray(rawValue) || isRecord(rawValue)) {
      throw new Error(`params.${key} must be a string, number, boolean, null, or undefined`);
    }
  }
  return value;
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: QueryValue): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(searchParams, key, item);
    return;
  }
  searchParams.append(key, String(value));
}

function buildApiPath(rawPath: string, pathParams?: Record<string, unknown>, query?: Record<string, QueryValue>): string {
  const trimmedPath = rawPath.trim();
  if (!trimmedPath) throw new Error('path must not be empty');
  if (!trimmedPath.startsWith('/api/')) throw new Error('Only /api/ paths are allowed');
  if (trimmedPath.length > MAX_API_PATH_CHARS) {
    throw new Error(`path must be ${MAX_API_PATH_CHARS} characters or less`);
  }

  const [pathPart, queryPart = ''] = trimmedPath.split('?');
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
      appendQueryValue(url.searchParams, key, value);
    }
  }

  const built = `${url.pathname}${url.search}`;
  if (!built.startsWith('/api/')) throw new Error('Only /api/ paths are allowed');
  if (built.length > MAX_API_PATH_CHARS) {
    throw new Error(`built API path must be ${MAX_API_PATH_CHARS} characters or less`);
  }
  return built;
}

function buildDiscoverPath(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  const search = typeof params.search === 'string' ? params.search.trim() : '';
  const category = typeof params.category === 'string' ? params.category.trim() : '';
  const method = typeof params.method === 'string' ? params.method.trim().toUpperCase() : '';
  const limit = params.limit === undefined || params.limit === null
    ? undefined
    : normalizeInteger(params.limit, 'limit', 1, 1, 200);

  if (search) query.set('q', search);
  if (category) query.set('category', category);
  if (method) {
    if (!ALLOWED_METHODS.has(method as ApiMethod)) {
      throw new Error(`Unsupported method "${params.method}". Use GET, POST, PATCH, PUT, or DELETE.`);
    }
    query.set('method', method);
  }
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
  const limit = params.limit === undefined || params.limit === null
    ? undefined
    : normalizeInteger(params.limit, 'limit', 1, 1, 500);

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

function formatResponse(
  resultBody: unknown,
  maxResponseChars: number,
  metadata: { statusCode: number; path: string; method: ApiMethod },
): { content: string; responseChars: number; returnedChars: number; wasTruncated: boolean } {
  const content = JSON.stringify(resultBody, null, 2);
  if (content.length <= maxResponseChars) {
    return { content, responseChars: content.length, returnedChars: content.length, wasTruncated: false };
  }

  const preview = truncateMiddle(content, maxResponseChars);
  const envelope = {
    _truncated: true,
    statusCode: metadata.statusCode,
    method: metadata.method,
    path: metadata.path,
    responseChars: content.length,
    maxResponseChars,
    preview,
  };
  const envelopeContent = JSON.stringify(envelope, null, 2);
  return {
    content: envelopeContent,
    responseChars: content.length,
    returnedChars: envelopeContent.length,
    wasTruncated: true,
  };
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = `\n\n... [ApiCall response truncated: ${value.length - maxChars} chars omitted] ...\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.max(0, budget - head);
  return value.slice(0, head).trimEnd() + marker + value.slice(value.length - tail).trimStart();
}

async function callInternalWithTimeout(
  api: ApiServer,
  method: ApiMethod,
  path: string,
  body: Record<string, unknown> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let abortCleanup: (() => void) | null = null;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (abortCleanup) abortCleanup();
      fn();
    };

    timeoutId = setTimeout(() => {
      settle(() => reject(new Error(`ApiCall timed out after ${timeoutMs}ms: ${method} ${path}`)));
    }, timeoutMs);

    if (signal) {
      const onAbort = () => {
        settle(() => reject(new Error(`ApiCall cancelled by user: ${method} ${path}`)));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', onAbort);
    }

    api.callInternal(method, path, body)
      .then((result) => settle(() => resolve(result)))
      .catch((err) => settle(() => reject(err)));
  });
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
      '**Bound slow/large calls:** use `timeout_ms` for potentially slow internal routes and `max_response_chars` when listing large collections.\n\n' +
      '**Common use cases:** List sessions. Read agent configurations. Search memory entries. Get tool statistics. Inspect plugin status.\n\n' +
      'Write endpoints (POST/PATCH/PUT/DELETE) require an active WebSocket connection. Read endpoints work anytime.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['call', 'discover', 'tools'], description: 'Use "discover" to search API endpoints, "tools" to search available tools; default is "call".' },
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method. Default: GET.' },
        path:   { type: 'string', minLength: 1, maxLength: MAX_API_PATH_CHARS, pattern: '\\S', description: 'API path or path template, e.g. "/api/v1/agents/:id" or "/api/v1/search".' },
        params: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
          description: 'Named path params used to replace :placeholders in path.',
        },
        query:  {
          type: 'object',
          additionalProperties: {
            type: ['string', 'number', 'boolean', 'array', 'null'],
            items: { type: ['string', 'number', 'boolean'] },
          },
          description: 'Query string object. Values are URL-encoded; arrays append repeated keys.',
        },
        body:   { type: 'object', description: 'JSON body for POST/PATCH/PUT/DELETE requests. Omit for GET.' },
        search: { type: 'string', description: 'Search text when action="discover" or action="tools".' },
        category: { type: 'string', description: 'Endpoint category filter when action="discover".' },
        group: { type: 'string', description: 'Tool group/category filter when action="tools".' },
        source: { type: 'string', enum: ['builtin', 'plugin', 'external'], description: 'Tool source filter when action="tools".' },
        risk: { type: 'string', enum: ['Safe', 'Low', 'Medium', 'High', 'Critical'], description: 'Tool risk filter when action="tools".' },
        readOnly: { type: 'boolean', description: 'Only return read-only tools when action="tools".' },
        detail: { type: 'boolean', description: 'Include full tool parameter schemas when action="tools".' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum endpoints/tools to return. Endpoint discover caps at 200; tool discover caps at 500.' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: MAX_TIMEOUT_MS, description: `Timeout for the internal API call. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
        max_response_chars: { type: 'integer', minimum: 500, maximum: MAX_RESPONSE_CHARS, description: `Maximum response characters returned to the model before a JSON preview envelope is used. Default ${DEFAULT_MAX_RESPONSE_CHARS}, max ${MAX_RESPONSE_CHARS}.` },
      },
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.High; }

  isReadOnly(): boolean { return false; }

  isConcurrencySafe(): boolean { return true; }

  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }

  defaultTimeoutMs(): number { return DEFAULT_TIMEOUT_MS; }

  outputLimit(): number { return MAX_RESPONSE_CHARS + 2000; }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    if (ctx.signal?.aborted) {
      return this.makeError('ApiCall cancelled by user before request started', {
        startedAt,
        structured: { status: 'aborted' },
      });
    }

    let action: ApiCallAction;
    let method: ApiMethod;
    let path: string;
    let body: Record<string, unknown> | undefined;
    let timeoutMs: number;
    let maxResponseChars: number;

    try {
      action = normalizeAction(params);
      method = action === 'call' ? normalizeMethod(params.method) : 'GET';
      timeoutMs = normalizeInteger(params.timeout_ms, 'timeout_ms', DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
      maxResponseChars = normalizeInteger(
        params.max_response_chars,
        'max_response_chars',
        DEFAULT_MAX_RESPONSE_CHARS,
        500,
        MAX_RESPONSE_CHARS,
      );
      body = normalizeBody(params.body, method, action);
      if (action === 'discover') {
        path = buildDiscoverPath(params);
      } else if (action === 'tools') {
        path = buildToolsPath(params);
      } else {
        const rawPath = params.path as string;
        if (!rawPath || typeof rawPath !== 'string') {
          return this.makeError('path is required for action="call" (e.g. "/api/v1/search" with query: { "q": "test" })');
        }
        path = buildApiPath(rawPath, normalizePathParams(params.params), normalizeQuery(params.query));
      }
    } catch (err) {
      return this.makeError((err as Error).message, {
        startedAt,
        structured: { status: 'invalid_request' },
      });
    }

    // Only allow API paths
    if (!path.startsWith('/api/')) {
      return this.makeError('Only /api/ paths are allowed', {
        startedAt,
        structured: { action, method, path, status: 'invalid_path' },
      });
    }

    try {
      const api = ApiServer.getInstance();
      const { statusCode, body: resultBody } = await callInternalWithTimeout(api, method, path, body, timeoutMs, ctx.signal);

      const formatted = formatResponse(resultBody, maxResponseChars, { statusCode, path, method });
      const structured = {
        action,
        statusCode,
        path,
        method,
        timeoutMs,
        maxResponseChars,
        responseChars: formatted.responseChars,
        returnedChars: formatted.returnedChars,
        wasTruncated: formatted.wasTruncated,
        resultCount: Array.isArray(resultBody)
          ? resultBody.length
          : isRecord(resultBody) && Array.isArray(resultBody.endpoints)
            ? resultBody.endpoints.length
            : isRecord(resultBody) && Array.isArray(resultBody.tools)
              ? resultBody.tools.length
              : undefined,
      };

      if (statusCode >= 400) {
        return this.makeError(`API ${statusCode}: ${formatted.content}`, {
          startedAt,
          wasTruncated: formatted.wasTruncated,
          structured,
        });
      }

      return this.makeResult(formatted.content, {
        startedAt,
        wasTruncated: formatted.wasTruncated,
        structured,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('timed out') ? 'timeout' : msg.includes('cancelled') ? 'aborted' : 'failed';
      return this.makeError(`ApiCall failed: ${msg}`, {
        startedAt,
        structured: { action, method, path, status, timeoutMs },
      });
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
