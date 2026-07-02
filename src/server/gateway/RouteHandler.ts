// RouteHandler — interface for declarative HTTP route registration
// Routes self-register by calling ApiServer.registerRoute().
// Adding a new endpoint means creating one file implementing this interface.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from './ApiAuth.js';

export interface RouteMatch {
  /** Path segments, e.g. ['api', 'v1', 'sessions', 'abc123'] */
  segments: string[];
  /** Named params extracted from path pattern, e.g. { id: 'abc123' } */
  params: Record<string, string>;
  /** Query parameters */
  query: URLSearchParams;
}

export interface RouteHandler {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  /**
   * Path pattern. Segments starting with ':' are params.
   * Example: '/api/v1/sessions/:id/messages'
   */
  path: string;
  /** One-line description for endpoint discovery (GET /api/v1/endpoints). */
  description?: string;
  /** Category for grouping in endpoint discovery. */
  category?: string;
  /** Optional permission required. If set, `token` must have this permission. */
  permission?: string;
  /** Handle the request. Return true if handled, false to try next handler. */
  handle(
    match: RouteMatch,
    req: IncomingMessage,
    res: ServerResponse,
    token: ApiToken | null,
  ): Promise<boolean> | boolean;
}

/** Match a path pattern against a URL pathname. Returns null if no match. */
export function matchRoute(pattern: string, pathname: string): RouteMatch | null {
  const patSegs = pattern.split('/').filter(Boolean);
  const pathSegs = pathname.split('/').filter(Boolean);

  if (patSegs.length !== pathSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patSegs.length; i++) {
    if (patSegs[i].startsWith(':')) {
      params[patSegs[i].slice(1)] = decodeURIComponent(pathSegs[i]);
    } else if (patSegs[i] !== pathSegs[i]) {
      return null;
    }
  }

  const queryString = pathname.includes('?') ? pathname.slice(pathname.indexOf('?')) : '';
  return {
    segments: pathSegs,
    params,
    query: new URLSearchParams(queryString),
  };
}
