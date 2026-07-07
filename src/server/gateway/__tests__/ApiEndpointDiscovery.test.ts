import { describe, it, expect, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiServer } from '../ApiServer.js';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';

describe('ApiServer endpoint discovery', () => {
  let api: ApiServer;

  beforeEach(() => {
    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
    (api as unknown as { _endpointRegistry: unknown[] })._endpointRegistry = [];
    (api as unknown as { _pluginRoutes: unknown[] })._pluginRoutes = [];
  });

  it('discovers routes even when the route handler has no explicit description', async () => {
    api.registerRoute(new CompactToolsRoute());

    const result = await api.callInternal('GET', '/api/v1/endpoints?q=compact&method=GET');
    expect(result.statusCode).toBe(200);

    const endpoints = result.body.endpoints as Array<{
      method: string;
      path: string;
      description: string;
      category: string;
    }>;
    expect(endpoints).toEqual([
      {
        method: 'GET',
        path: '/api/v1/tools/compact',
        description: 'GET Tools Compact',
        category: 'Tools',
      },
    ]);
  });

  it('deduplicates declarative and non-declarative registrations for the same method/path', async () => {
    api.registerRoute(new CompactToolsRoute());
    api.registerNonDeclarativeEndpoint('GET', '/api/v1/tools/compact', 'Compact tool list', 'Tools');

    const result = await api.callInternal('GET', '/api/v1/endpoints?q=compact&method=GET');
    const endpoints = result.body.endpoints as Array<{ path: string; description: string }>;

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual(expect.objectContaining({
      path: '/api/v1/tools/compact',
      description: 'Compact tool list',
    }));
  });
});

class CompactToolsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/tools/compact';

  handle(
    _match: RouteMatch,
    _req: IncomingMessage,
    res: ServerResponse,
    _token: ApiToken | null,
  ): boolean {
    sendJson(res, 200, { tools: [] });
    return true;
  }
}
