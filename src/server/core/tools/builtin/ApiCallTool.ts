// ApiCallTool — internal API dispatcher for agents
// Agents call this instead of SSH'ing into their own server.
// Routes through ApiServer.callInternal() — no HTTP overhead, no auth.
// Write endpoints (POST/PATCH/PUT/DELETE) require active WebSocket connection — returns 503 without one.

import { Tool, RiskLevel, InterruptBehavior } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { ApiServer } from '../../../gateway/ApiServer.js';

export class ApiCallTool extends Tool {

  static category = 'System';
  static toolDescription = 'Calls AnoClaw REST API endpoints directly — search sessions, read agents, inspect memory.';

  name(): string { return 'ApiCall'; }

  description(): string {
    return 'Call AnoClaw REST API internally. No auth, no HTTP overhead. Use GET /api/v1/endpoints to discover available endpoints.';
  }

  prompt(): string {
    return '## ApiCall Usage\n' +
      'Call AnoClaw\'s internal REST API directly. No authentication needed — runs within the server process.\n\n' +
      '**Always discover first:** `GET /api/v1/endpoints` returns all available endpoints with descriptions. Use this before calling any endpoint you haven\'t used before.\n\n' +
      '**Common use cases:** List sessions. Read agent configurations. Search memory entries. Get tool statistics. Inspect plugin status.\n\n' +
      'Write endpoints (POST/PATCH/PUT/DELETE) require an active WebSocket connection. Read endpoints work anytime.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'DELETE'], description: 'HTTP method. Default: GET.' },
        path:   { type: 'string', description: 'API path with optional query string, e.g. "/api/v1/search?q=login+bug&limit=5".' },
        body:   { type: 'object',   description: 'JSON body for POST/PATCH requests. Omit for GET/DELETE.' },
      },
      required: ['path'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.High; }

  isReadOnly(): boolean { return false; }

  isConcurrencySafe(): boolean { return true; }

  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }

  defaultTimeoutMs(): number { return 15000; }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const method = (params.method as string) || 'GET';
    const path = params.path as string;
    const body = params.body as Record<string, unknown> | undefined;

    if (!path || typeof path !== 'string') {
      return this.makeError('path is required (e.g. "/api/v1/search?q=test")');
    }

    // Only allow API paths
    if (!path.startsWith('/api/')) {
      return this.makeError('Only /api/ paths are allowed');
    }

    try {
      const api = ApiServer.getInstance();
      const { statusCode, body: resultBody } = await api.callInternal(method, path, body);

      const content = JSON.stringify(resultBody, null, 2);
      const MAX_OUT = 16000;
      const truncated = content.length > MAX_OUT
        ? content.slice(0, MAX_OUT) + `\n\n⚠️ TRUNCATED — ${content.length - MAX_OUT} more chars omitted. Use query/filter params to narrow results.`
        : content;

      if (statusCode >= 400) {
        return this.makeError(`API ${statusCode}: ${truncated}`);
      }

      return this.makeResult(truncated, {
        structured: { statusCode, path, method, resultCount: Array.isArray(resultBody) ? resultBody.length : undefined },
      });
    } catch (err) {
      return this.makeError(`ApiCall failed: ${(err as Error).message}`);
    }
  }

  // ── UI helpers ──

  userFacingName(_input?: Record<string, unknown>): string {
    const path = (_input?.path as string) || '';
    const short = path.split('?')[0];
    return `API ${short}`;
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    const path = (input?.path as string) || '';
    const short = path.split('?')[0];
    return short.length > 60 ? short.slice(0, 57) + '...' : short;
  }
}
