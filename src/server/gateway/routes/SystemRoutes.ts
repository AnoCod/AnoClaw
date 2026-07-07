// SystemRoutes — system utility endpoints

import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { AgentRuntime } from '../../core/agent/AgentRuntime.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { LogManager } from '../../infra/logging/LogManager.js';

export class OpenFileRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/system/open-file';
  permission = 'admin';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const { filePath } = (await readBody(req)) as { filePath?: string };
    if (!filePath) {
      sendJson(res, 400, { error: 'Missing filePath' });
      return true;
    }

    const absPath = path.resolve(filePath);
    const command = process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';

    const child = spawn(command, [absPath], { detached: true, stdio: 'ignore', shell: false });
    child.once('error', (err) => {
      sendJson(res, 500, { error: 'Failed to open file', message: err.message });
    });
    child.once('spawn', () => {
      child.unref();
      sendJson(res, 200, { ok: true, path: absPath });
    });
    return true;
  }
}

export class StatsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/stats';
  description = 'Global agent/session/memory stats';
  category = 'System';
  permission = 'admin';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    const runtime = AgentRuntime.getInstance();
    const registry = AgentRegistry.getInstance();
    const sessionManager = SessionManager.getInstance();
    sendJson(res, 200, {
      agents: { total: registry.size, active: registry.activeAgents().length },
      sessions: { total: sessionManager.listSessions().length, active: sessionManager.activeSessions().length },
      runtime: { activeLoops: runtime.activeSessionCount },
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return true;
  }
}

export class GetLogEntriesRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/logs/entries';
  description = 'Read recent log entries by category';
  category = 'System';

  handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    const url = new URL(req.url || '/', 'http://localhost');
    const count = parseInt(url.searchParams.get('count') || '200', 10);
    const category = url.searchParams.get('category') || '';
    const logManager = LogManager.getInstance();
    const entries = category
      ? logManager.recentEntries(category, count)
      : logManager.search('', count);
    sendJson(res, 200, { entries });
    return true;
  }
}
