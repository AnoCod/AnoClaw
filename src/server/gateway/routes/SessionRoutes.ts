// SessionRoutes — legacy session CRUD handlers wrapped as RouteHandler classes
// Wraps existing handler functions from handlers/SessionHandlers.ts

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import {
  handleListSessions, handleCreateSession, handleGetSession, handleArchiveSession,
  handleClearAllSessions, handleRenameSession, handleAutoTitle,
  handleSearchSessions, handleGetOverview, handleSessionToolStats,
} from '../handlers/SessionHandlers.js';
import { sendJson, readBody } from '../RouteHelpers.js';

// ═══ Session Routes ═══════════════════════════════════════════

export class ListSessionsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/sessions';
  description = 'List all sessions';
  category = 'Sessions';
  permission = 'sessions:read';
  handle = (_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleListSessions(req, res, sendJson, 'localhost');
    return true;
  };
}

export class CreateSessionRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/sessions';
  description = 'Create a new session';
  category = 'Sessions';
  permission = 'sessions:write';
  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleCreateSession(req, res, sendJson, readBody);
    return true;
  }
}

export class SearchSessionsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/search';
  description = 'Unified search: session messages + cross-session memories';
  category = 'Search';
  permission = 'sessions:read';
  handle = (_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleSearchSessions(req, res, sendJson);
    return true;
  };
}

export class GetSessionRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/sessions/:id';
  description = 'Get session details';
  category = 'Sessions';
  permission = 'sessions:read';
  handle = (match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleGetSession(match.params.id, res, sendJson);
    return true;
  };
}

export class PatchSessionRoute implements RouteHandler {
  method = 'PATCH' as const;
  path = '/api/v1/sessions/:id';
  description = 'Rename a session';
  category = 'Sessions';
  permission = 'sessions:write';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleRenameSession(match.params.id, req, res, sendJson, readBody);
    return true;
  }
}

export class DeleteSessionRoute implements RouteHandler {
  method = 'DELETE' as const;
  path = '/api/v1/sessions/:id';
  description = 'Archive a session';
  category = 'Sessions';
  permission = 'sessions:write';
  handle = (match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleArchiveSession(match.params.id, res, sendJson);
    return true;
  };
}

export class ClearSessionsRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/sessions/clear';
  description = 'Clear all sessions';
  category = 'Sessions';
  permission = 'sessions:write';
  handle = (_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleClearAllSessions(res, sendJson);
    return true;
  };
}

export class SessionOverviewRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/sessions/:id/overview';
  description = 'Session overview';
  category = 'Sessions';
  permission = 'sessions:read';
  handle = (match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleGetOverview(match.params.id, res, sendJson);
    return true;
  };
}

export class SessionToolStatsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/sessions/:id/tool-stats';
  description = 'Per-session tool usage stats';
  category = 'Sessions';
  permission = 'sessions:read';
  handle = (match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean => {
    handleSessionToolStats(match.params.id, res, sendJson);
    return true;
  };
}

export class SessionAutoTitleRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/sessions/:id/auto-title';
  description = 'Auto-generate session title via LLM';
  category = 'Sessions';
  permission = 'sessions:write';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    await handleAutoTitle(match.params.id, req, res, sendJson, readBody);
    return true;
  }
}
