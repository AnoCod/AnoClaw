import { beforeEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../ApiServer.js';
import type { RouteHandler } from '../RouteHandler.js';
import { ListCapabilitiesRoute, ResolveTaskRoute } from '../routes/CapabilityRoutes.js';
import { CapabilityRegistry } from '../../core/capability/CapabilityRegistry.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';

describe('capability API routes', () => {
  let api: ApiServer;

  beforeEach(() => {
    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
    (api as unknown as { _endpointRegistry: unknown[] })._endpointRegistry = [];
    (api as unknown as { _pluginRoutes: unknown[] })._pluginRoutes = [];

    CapabilityRegistry.resetInstance();
    ToolRegistry.resetInstance();
    CapabilityRegistry.getInstance().setCatalogCapabilities([{
      id: 'widget.create',
      title: 'Create a widget',
      description: 'Create a widget artifact.',
      domain: 'utility',
      kind: 'artifact',
      triggers: ['widget'],
      requiredTools: ['widget.render'],
      recommendedPlugins: ['widget-provider'],
    }]);
    api.registerRoute(new ListCapabilitiesRoute());
    api.registerRoute(new ResolveTaskRoute());
  });

  it('lists and filters user-level capabilities', async () => {
    const result = await api.callInternal('GET', '/api/v1/capabilities?q=widget&limit=5');

    expect(result.statusCode).toBe(200);
    const body = result.body as {
      capabilities: Array<{
        id: string;
        status: string;
        missingTools: string[];
        pluginName?: string;
      }>;
      total: number;
      filters: Record<string, unknown>;
    };

    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.filters).toEqual(expect.objectContaining({ search: 'widget', limit: 5 }));
    expect(body.capabilities[0]).toEqual(expect.objectContaining({
      id: 'widget.create',
      status: 'needs_plugin',
      recommendedPlugins: ['widget-provider'],
    }));
    expect(body.capabilities[0].missingTools).toContain('widget.render');
  });

  it('resolves natural-language requests through the API', async () => {
    const result = await api.callInternal('POST', '/api/v1/tasks/resolve', {
      message: 'Please create a widget',
    });

    expect(result.statusCode).toBe(200);
    const body = result.body as {
      intent: string;
      nextAction: string;
      bestCapability?: { id: string };
    };

    expect(body.intent).toBe('capability');
    expect(body.nextAction).toBe('recommend_plugin');
    expect(body.bestCapability?.id).toBe('widget.create');
  });
});
