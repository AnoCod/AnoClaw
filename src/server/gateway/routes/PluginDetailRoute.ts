// PluginDetailRoute — single plugin detail with tools and pages
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { PluginHostManager } from '../../core/plugin-host/PluginHostManager.js';
import { ToolRegistry } from '../../core/tools/ToolRegistry.js';

export class PluginDetailRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/plugins/:name';
  category = 'Plugins';
  description = 'Get detailed info for a single plugin (manifest, tools, pages)';

  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const name = match.params['name'];
      if (!name) {
        sendJson(res, 400, { error: 'Plugin name required' });
        return true;
      }
      const pm = PluginHostManager.getInstance();
      const all = await pm.listPlugins();
      const plugin = all.find(p => p.name === name);
      if (!plugin) {
        sendJson(res, 404, { error: 'Plugin not found' });
        return true;
      }

      // Find tools registered by this plugin
      const tr = ToolRegistry.getInstance();
      const pluginTools = tr.allTools().filter(t => t.name().startsWith(`${name}.`) || t.name() === name);

      sendJson(res, 200, {
        ...plugin,
        tools: pluginTools.map(t => ({ name: t.name(), description: t.description(), isReadOnly: tr.isReadOnly(t.name()) })),
        toolCount: pluginTools.length,
      });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to get plugin', message: (err as Error).message });
    }
    return true;
  }
}
