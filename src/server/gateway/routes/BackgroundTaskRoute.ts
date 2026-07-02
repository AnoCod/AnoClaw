// BackgroundTaskRoute — query running background delegation tasks
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { BackgroundTaskManager } from '../../core/agent/supervision/BackgroundTaskManager.js';

export class BackgroundTasksRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/sessions/:id/background-tasks';
  category = 'Sessions'; description = 'List active background delegation tasks for a session';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const tasks = BackgroundTaskManager.getInstance().getTasksForParent(m.params['id']);
      sendJson(res, 200, {
        tasks: tasks.map(t => ({
          id: t.id, parentAgentId: t.parentAgentId,
          summary: t.summary, turnCount: t.turnCount,
          currentTool: t.currentTool, elapsedMs: Date.now() - t.startedAt,
          status: t.status, type: t.type,
        })),
        total: tasks.length,
        globalActiveCount: BackgroundTaskManager.getInstance().activeCount,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
