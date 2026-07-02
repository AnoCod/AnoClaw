// LogRoutes — log search and level control
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { LogManager } from '../../infra/logging/LogManager.js';

export class LogSearchRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/logs/search';
  category = 'System';
  description = 'Search recent log entries by keyword';

  handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const url = new URL(req.url || '/', `http://localhost`);
      const q = url.searchParams.get('q') || '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 500);
      const category = url.searchParams.get('category') || '';

      const lm = LogManager.getInstance();
      let entries;
      if (category) {
        entries = lm.recentEntries(category, limit);
      } else {
        entries = lm.search(q, limit);
      }

      sendJson(res, 200, {
        results: entries.map(e => ({
          ts: e.ts,
          level: e.level,
          category: e.cat,
          message: e.msg,
          sessionId: e.sid,
          agentId: e.aid,
        })),
        query: q,
        total: entries.length,
      });
    } catch (err) {
      sendJson(res, 500, { error: 'Log search failed', message: (err as Error).message });
    }
    return true;
  }
}

export class PutLogLevelRoute implements RouteHandler {
  method = 'PUT' as const;
  path = '/api/v1/logs/level';
  category = 'System';
  description = 'Set minimum log level (trace|debug|info|warn|error|fatal)';
  permission = 'settings:write';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const body = await readBody(req);
      const level = (body.level as string)?.toLowerCase();
      const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
      if (!level || !validLevels.includes(level)) {
        sendJson(res, 400, { error: `Invalid level. Must be one of: ${validLevels.join(', ')}` });
        return true;
      }
      LogManager.getInstance().setMinLevel(level);
      sendJson(res, 200, { level, set: true });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to set log level', message: (err as Error).message });
    }
    return true;
  }
}
