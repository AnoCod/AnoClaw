// HealthRoute — GET /api/v1/health

import { APP_NAME, APP_VERSION } from '../../../shared/constants.js';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';

export class HealthRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/health';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    sendJson(res, 200, {
      status: 'ok',
      app: APP_NAME,
      version: APP_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return true;
  }
}
