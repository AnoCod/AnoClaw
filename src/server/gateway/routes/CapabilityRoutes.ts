import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { readBody, sendJson } from '../RouteHelpers.js';
import { CapabilityRegistry } from '../../core/capability/CapabilityRegistry.js';
import { TaskResolver } from '../../core/capability/TaskResolver.js';
import type { CapabilityAvailability, CapabilitySource } from '../../../shared/types/capability.js';

function parseLimit(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseIncludeUnavailable(value: string | null): boolean {
  if (value === null) return true;
  return !['0', 'false', 'no'].includes(value.trim().toLowerCase());
}

export class ListCapabilitiesRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/capabilities';
  category = 'Capabilities';
  description = 'List user-level capabilities from the built-in catalog and installed plugins';

  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const result = await CapabilityRegistry.getInstance().allCapabilities({
      search: match.query.get('q') || match.query.get('search') || undefined,
      domain: match.query.get('domain') || undefined,
      status: (match.query.get('status') || undefined) as CapabilityAvailability | undefined,
      source: (match.query.get('source') || undefined) as CapabilitySource | undefined,
      includeUnavailable: parseIncludeUnavailable(match.query.get('includeUnavailable')),
      limit: parseLimit(match.query.get('limit'), 200, 500),
    });
    sendJson(res, 200, result);
    return true;
  }
}

export class ResolveTaskRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/tasks/resolve';
  category = 'Capabilities';
  description = 'Resolve a natural-language user request into the best available user-level capability';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const body = await readBody(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      sendJson(res, 400, { error: 'message is required' });
      return true;
    }

    const resolver = new TaskResolver();
    const result = await resolver.resolve({
      message,
      userMode: typeof body.userMode === 'string' ? body.userMode : undefined,
      locale: typeof body.locale === 'string' ? body.locale : undefined,
      includeUnavailable: typeof body.includeUnavailable === 'boolean' ? body.includeUnavailable : true,
    });
    sendJson(res, 200, result);
    return true;
  }
}
