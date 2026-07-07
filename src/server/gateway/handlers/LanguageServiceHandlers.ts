// LanguageServiceHandlers — workspace-scoped code intelligence API.

import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionManager } from '../../core/session/SessionManager.js';
import { LanguageIntelligenceService, type LanguageRequest } from '../../core/language/LanguageIntelligenceService.js';
import { resolveWorkspacePath } from './WorkspaceHandlers.js';
import type { SendJson, ReadBody } from '../RouteHelpers.js';

type LanguageOperation = 'completions' | 'hover' | 'definition' | 'diagnostics' | 'organize-imports';

export async function handleLanguageServiceRequest(
  operation: LanguageOperation,
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  try {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const filePath = String(body.path || '');
    const content = typeof body.content === 'string' ? body.content : '';
    const language = typeof body.language === 'string' ? body.language : undefined;
    const line = Number(body.line || 1);
    const column = Number(body.column || 1);

    if (!sessionId) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "sessionId"' });
      return;
    }
    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path"' });
      return;
    }

    const session = SessionManager.getInstance().session(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Not Found', message: `Session '${sessionId}' not found` });
      return;
    }

    const workspaceRoot = path.resolve(session.workspace || process.cwd());
    const absPath = resolveWorkspacePath(workspaceRoot, filePath);
    const service = LanguageIntelligenceService.getInstance();
    const request: LanguageRequest = {
      workspaceRoot,
      filePath: absPath,
      content,
      line: Number.isFinite(line) ? line : 1,
      column: Number.isFinite(column) ? column : 1,
      language,
    };

    if (operation === 'completions') {
      const items = await service.complete(request);
      sendJson(res, 200, { items });
      return;
    }
    if (operation === 'hover') {
      const hover = await service.hover(request);
      sendJson(res, 200, { hover });
      return;
    }
    if (operation === 'definition') {
      const locations = await service.definition(request);
      sendJson(res, 200, { locations });
      return;
    }
    if (operation === 'diagnostics') {
      const diagnostics = await service.diagnostics(request);
      sendJson(res, 200, { diagnostics });
      return;
    }
    if (operation === 'organize-imports') {
      const edits = service.organizeImports(request);
      sendJson(res, 200, { edits });
      return;
    }
    sendJson(res, 400, { error: 'Bad Request', message: `Unsupported operation '${operation}'` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Path escapes workspace root') {
      sendJson(res, 403, { error: 'Forbidden', message });
      return;
    }
    sendJson(res, 500, { error: 'Language service failed', message });
  }
}
