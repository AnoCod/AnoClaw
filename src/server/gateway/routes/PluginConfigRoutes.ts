// PluginConfigRoutes — plugin configuration read/write
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { PluginStorage } from '../../core/plugin-host/PluginStorage.js';

export class GetPluginConfigRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/plugins/:name/config';
  category = 'Plugins';
  description = 'Read plugin configuration';
  permission = 'admin';

  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const name = match.params['name'];
      const config = PluginStorage.getConfig(name);
      sendJson(res, 200, { plugin: name, config: config || {} });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to read config', message: (err as Error).message });
    }
    return true;
  }
}

export class PutPluginConfigRoute implements RouteHandler {
  method = 'PUT' as const;
  path = '/api/v1/plugins/:name/config';
  category = 'Plugins';
  description = 'Write plugin configuration';
  permission = 'admin';

  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const name = match.params['name'];
      const body = await readBody(req);
      const config = (body.config as Record<string, unknown>) || body;
      PluginStorage.setConfig(name, config);
      sendJson(res, 200, { plugin: name, config, saved: true });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to write config', message: (err as Error).message });
    }
    return true;
  }
}
