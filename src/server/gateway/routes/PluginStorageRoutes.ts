// PluginStorageRoutes — plugin K/V storage CRUD
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { PluginStorage } from '../../core/plugin-host/PluginStorage.js';

export class ListPluginStorageRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/plugins/:name/storage';
  category = 'Plugins';
  description = 'List all storage keys for a plugin';

  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const name = match.params['name'];
      const keys = PluginStorage.listKeys(name);
      sendJson(res, 200, { plugin: name, keys });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to list storage', message: (err as Error).message });
    }
    return true;
  }
}

export class GetPluginStorageRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/plugins/:name/storage/:key';
  category = 'Plugins';
  description = 'Read a storage value by key for a plugin';

  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const name = match.params['name'];
      const key = match.params['key'];
      const value = PluginStorage.get(name, key);
      if (value === null) {
        sendJson(res, 404, { error: 'Key not found' });
        return true;
      }
      sendJson(res, 200, { plugin: name, key, value });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to read storage', message: (err as Error).message });
    }
    return true;
  }
}

export class PutPluginStorageRoute implements RouteHandler {
  method = 'PUT' as const;
  path = '/api/v1/plugins/:name/storage/:key';
  category = 'Plugins';
  description = 'Write a storage value by key for a plugin';

  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const name = match.params['name'];
      const key = match.params['key'];
      const body = await readBody(req);
      if (!('value' in body)) {
        sendJson(res, 400, { error: 'value field is required in body' });
        return true;
      }
      PluginStorage.set(name, key, body.value);
      sendJson(res, 200, { plugin: name, key, value: body.value, saved: true });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to write storage', message: (err as Error).message });
    }
    return true;
  }
}
