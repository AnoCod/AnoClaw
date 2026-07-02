// SystemInfoRoute — server process information
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { MemoryManager } from '../../core/memory/MemoryManager.js';
import { APP_NAME, APP_VERSION } from '../../../shared/constants.js';

export class SystemInfoRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/system/info';
  category = 'System';
  description = 'Server process info: uptime, memory, agent/session/memory counts';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const mem = process.memoryUsage();
      const reg = AgentRegistry.getInstance();
      const sm = SessionManager.getInstance();
      const mm = MemoryManager.getInstance();

      // Quick memory count from team + agent scopes
      sendJson(res, 200, {
        app: APP_NAME,
        version: APP_VERSION,
        uptime: Math.floor(process.uptime()),
        nodeVersion: process.version,
        pid: process.pid,
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100 + ' MB',
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100 + ' MB',
          rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100 + ' MB',
          external: Math.round(mem.external / 1024 / 1024 * 100) / 100 + ' MB',
        },
        agents: {
          total: reg.allAgents().length,
          active: reg.activeAgents().length,
        },
        sessions: {
          active: sm.activeSessions().length,
          main: sm.mainSessions().length,
        },
      });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to get system info', message: (err as Error).message });
    }
    return true;
  }
}
