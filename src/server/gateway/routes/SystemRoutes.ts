// SystemRoutes — system utility endpoints

import * as path from 'node:path';
import { exec } from 'node:child_process';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';

export class OpenFileRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/system/open-file';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const { filePath } = (await readBody(req)) as { filePath?: string };
    if (!filePath) {
      sendJson(res, 400, { error: 'Missing filePath' });
      return true;
    }

    const absPath = path.resolve(filePath);
    const cmd = process.platform === 'win32'
      ? `start "" "${absPath}"`
      : process.platform === 'darwin'
        ? `open "${absPath}"`
        : `xdg-open "${absPath}"`;

    exec(cmd, (err) => {
      if (err) {
        sendJson(res, 500, { error: 'Failed to open file', message: err.message });
      } else {
        sendJson(res, 200, { ok: true, path: absPath });
      }
    });
    return true;
  }
}
