// WorkspaceRoutes — declarative route handlers for workspace file-browsing, binding, and mutation
// Migrated from legacy if-else routing in ApiServer.ts (Phase: SA-10 declarative routes)

import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { DEFAULT_HOST, API_PORT } from '../../../shared/constants.js';
import {
  handleGetWorkspace,
  handleBindWorkspace,
  handleBrowseWorkspace,
  handleReadWorkspaceFile,
  handleCreateWorkspaceDir,
  handleCreateWorkspaceFile,
  handleDeleteWorkspaceFile,
  handleRenameWorkspaceFile,
  handleMoveWorkspaceFile,
  handleWriteWorkspaceFile,
  handleConvertOffice,
} from '../handlers/WorkspaceHandlers.js';

// ── Session-scoped workspace ──

/** GET /api/v1/sessions/:id/workspace — Get session workspace path */
export class GetWorkspaceRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/sessions/:id/workspace';
  readonly category = 'Sessions';
  readonly description = 'Get session workspace path';

  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    handleGetWorkspace(match.params.id, res, sendJson);
    return true;
  }
}

/** PATCH /api/v1/sessions/:id/bind-workspace — Bind workspace to session */
export class BindWorkspaceRoute implements RouteHandler {
  readonly method = 'PATCH';
  readonly path = '/api/v1/sessions/:id/bind-workspace';
  readonly category = 'Sessions';
  readonly description = 'Bind workspace to session';

  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleBindWorkspace(match.params.id, req, res, sendJson, readBody);
    return true;
  }
}

// ── Workspace browsing / reading ──

/** GET /api/v1/workspace/browse — Browse workspace directory */
export class BrowseWorkspaceRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/workspace/browse';
  readonly category = 'Workspace';
  readonly description = 'Browse workspace directory';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleBrowseWorkspace(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}

/** GET /api/v1/workspace/read — Read a workspace file */
export class ReadWorkspaceFileRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/workspace/read';
  readonly category = 'Workspace';
  readonly description = 'Read a workspace file';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleReadWorkspaceFile(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}

// ── Workspace mutations (body-based) ──

/** POST /api/v1/workspace/create-dir — Create workspace directory */
export class CreateWorkspaceDirRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/workspace/create-dir';
  readonly category = 'Workspace';
  readonly description = 'Create workspace directory';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleCreateWorkspaceDir(req, res, sendJson, readBody);
    return true;
  }
}

/** POST /api/v1/workspace/create-file — Create empty file */
export class CreateWorkspaceFileRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/workspace/create-file';
  readonly category = 'Workspace';
  readonly description = 'Create empty file';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleCreateWorkspaceFile(req, res, sendJson, readBody);
    return true;
  }
}

/** DELETE /api/v1/workspace/file — Delete file or directory */
export class DeleteWorkspaceFileRoute implements RouteHandler {
  readonly method = 'DELETE';
  readonly path = '/api/v1/workspace/file';
  readonly category = 'Workspace';
  readonly description = 'Delete file or directory';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleDeleteWorkspaceFile(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}

/** PATCH /api/v1/workspace/rename — Rename file or directory */
export class RenameWorkspaceFileRoute implements RouteHandler {
  readonly method = 'PATCH';
  readonly path = '/api/v1/workspace/rename';
  readonly category = 'Workspace';
  readonly description = 'Rename file or directory';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleRenameWorkspaceFile(req, res, sendJson, readBody);
    return true;
  }
}

/** POST /api/v1/workspace/move — Move file or directory */
export class MoveWorkspaceFileRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/workspace/move';
  readonly category = 'Workspace';
  readonly description = 'Move file or directory';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleMoveWorkspaceFile(req, res, sendJson, readBody);
    return true;
  }
}

/** PUT /api/v1/workspace/write — Write content to file */
export class WriteWorkspaceFileRoute implements RouteHandler {
  readonly method = 'PUT';
  readonly path = '/api/v1/workspace/write';
  readonly category = 'Workspace';
  readonly description = 'Write content to file';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleWriteWorkspaceFile(req, res, sendJson, readBody);
    return true;
  }
}

// ── Office document conversion ──

/** GET /api/v1/workspace/convert-office — Convert Office documents to HTML/text */
export class ConvertOfficeRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/workspace/convert-office';
  readonly category = 'Workspace';
  readonly description = 'Convert Office documents to HTML or plain text';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleConvertOffice(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}
