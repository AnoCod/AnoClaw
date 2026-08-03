// WorkspaceRoutes — declarative routes for read-only file browsing and previews.
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
  handleInspectWorkspaceArchive,
  handlePreviewWorkspacePsd,
} from '../handlers/WorkspaceHandlers.js';

// ── Session-scoped workspace ──

/** GET /api/v1/sessions/:id/workspace — Get session workspace path */
export class GetWorkspaceRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/sessions/:id/workspace';
  readonly category = 'Sessions';
  readonly description = 'Get session workspace path';
  readonly permission = 'workspace:read';

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
  readonly permission = 'workspace:write';

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
  readonly permission = 'workspace:read';

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
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleReadWorkspaceFile(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}

// ── Disabled legacy mutations (stable WORKSPACE_READ_ONLY response) ──

/** Disabled legacy POST /api/v1/workspace/create-dir route. */
export class CreateWorkspaceDirRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/workspace/create-dir';
  readonly category = 'Workspace';
  readonly description = 'Disabled: Workspace is read-only';
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleCreateWorkspaceDir(req, res, sendJson, readBody);
    return true;
  }
}

/** Disabled legacy POST /api/v1/workspace/create-file route. */
export class CreateWorkspaceFileRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/workspace/create-file';
  readonly category = 'Workspace';
  readonly description = 'Disabled: Workspace is read-only';
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleCreateWorkspaceFile(req, res, sendJson, readBody);
    return true;
  }
}

/** Disabled legacy DELETE /api/v1/workspace/file route. */
export class DeleteWorkspaceFileRoute implements RouteHandler {
  readonly method = 'DELETE';
  readonly path = '/api/v1/workspace/file';
  readonly category = 'Workspace';
  readonly description = 'Disabled: Workspace is read-only';
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleDeleteWorkspaceFile(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}

/** Disabled legacy PATCH /api/v1/workspace/rename route. */
export class RenameWorkspaceFileRoute implements RouteHandler {
  readonly method = 'PATCH';
  readonly path = '/api/v1/workspace/rename';
  readonly category = 'Workspace';
  readonly description = 'Disabled: Workspace is read-only';
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleRenameWorkspaceFile(req, res, sendJson, readBody);
    return true;
  }
}

/** Disabled legacy POST /api/v1/workspace/move route. */
export class MoveWorkspaceFileRoute implements RouteHandler {
  readonly method = 'POST';
  readonly path = '/api/v1/workspace/move';
  readonly category = 'Workspace';
  readonly description = 'Disabled: Workspace is read-only';
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleMoveWorkspaceFile(req, res, sendJson, readBody);
    return true;
  }
}

/** Disabled legacy PUT /api/v1/workspace/write route. */
export class WriteWorkspaceFileRoute implements RouteHandler {
  readonly method = 'PUT';
  readonly path = '/api/v1/workspace/write';
  readonly category = 'Workspace';
  readonly description = 'Disabled: Workspace is read-only';
  readonly permission = 'workspace:read';

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
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleConvertOffice(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}

/** GET /api/v1/workspace/inspect-archive — List a safe ZIP-family archive */
export class InspectWorkspaceArchiveRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/workspace/inspect-archive';
  readonly category = 'Workspace';
  readonly description = 'List entries in a ZIP-family archive';
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleInspectWorkspaceArchive(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}

/** GET /api/v1/workspace/preview-psd — Render a flattened PSD/PSB preview. */
export class PreviewWorkspacePsdRoute implements RouteHandler {
  readonly method = 'GET';
  readonly path = '/api/v1/workspace/preview-psd';
  readonly category = 'Workspace';
  readonly description = 'Render a read-only merged PSD or PSB preview';
  readonly permission = 'workspace:read';

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handlePreviewWorkspacePsd(req, res, sendJson, DEFAULT_HOST, API_PORT);
    return true;
  }
}
