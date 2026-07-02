// PluginDiagnosticRoutes — extension points, host status
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { PluginHostManager } from '../../core/plugin-host/PluginHostManager.js';
import { extensionPoints } from '../../core/plugin-host/ExtensionPoints.js';

export class PluginExtensionsRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/plugins/extensions';
  category = 'Plugins'; description = 'List all extension point overrides (which plugin overrides what)';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      sendJson(res, 200, { overrides: extensionPoints.list() });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class PluginHostStatusRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/plugins/status';
  category = 'Plugins'; description = 'Check if plugin host worker is running';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const pm = PluginHostManager.getInstance();
      sendJson(res, 200, { hostRunning: pm.isRunning() });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
