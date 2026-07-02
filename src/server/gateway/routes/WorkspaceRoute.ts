// WorkspaceRoute — GET /api/v1/workspace (global workspace info)
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import * as fs from 'fs';
import * as path from 'path';

export class WorkspaceInfoRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/workspace';
  category = 'Workspace';
  description = 'Get global workspace directory info';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const root = SettingsManager.getInstance().get<string>('workspace.root', process.cwd());
      const exists = fs.existsSync(root);
      let entries: string[] = [];
      if (exists && fs.statSync(root).isDirectory()) {
        entries = fs.readdirSync(root).slice(0, 50);
      }
      sendJson(res, 200, { root, exists, entries: entries.slice(0, 20), entryCount: entries.length });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }
}
