// SessionControlRoutes — interrupt, compact, metadata, parent/root, active session
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { InterruptController, InterruptReason } from '../../core/agent/supervision/InterruptController.js';
import { SessionStore } from '../../core/session/SessionStore.js';
import { AgentRuntime } from '../../core/agent/AgentRuntime.js';
import { SessionStatus } from '../../../shared/types/session.js';
import { TypedEventBus } from '../../core/events/TypedEventBus.js';

export class InterruptSessionRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/sessions/:id/interrupt';
  category = 'Sessions'; description = 'Interrupt a running session (body: { reason? })';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const body = await readBody(req);
      const reasonStr = (body.reason as string) || 'user_stop';
      const reasonMap: Record<string, InterruptReason> = {
        user_stop: InterruptReason.UserStop, user_steer: InterruptReason.UserSteer,
        timeout: InterruptReason.Timeout,
      };
      const reason = reasonMap[reasonStr] || InterruptReason.UserStop;
      InterruptController.getInstance().requestInterrupt(match.params['id'], reason);
      sendJson(res, 200, { sessionId: match.params['id'], interrupted: true, reason: reasonStr });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class InterruptStatusRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/sessions/:id/interrupt-status';
  category = 'Sessions'; description = 'Check if a session is interrupted';
  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const ic = InterruptController.getInstance();
      sendJson(res, 200, {
        sessionId: match.params['id'],
        interrupted: ic.isInterrupted(match.params['id']),
        reason: ic.reason(match.params['id']),
        activeInterruptCount: ic.activeCount,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SessionMetadataRoute implements RouteHandler {
  method = 'PATCH' as const; path = '/api/v1/sessions/:id/metadata';
  category = 'Sessions'; description = 'Set metadata key-value on a session (body: { key, value })';
  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const body = await readBody(req);
      const key = body.key as string;
      if (!key) { sendJson(res, 400, { error: 'key is required' }); return true; }
      const mgr = SessionManager.getInstance();
      mgr.setMetadata(match.params['id'], key, body.value);
      sendJson(res, 200, { sessionId: match.params['id'], key, value: body.value });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SessionParentRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/sessions/:id/parent';
  category = 'Sessions'; description = 'Get parent session of a session';
  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const mgr = SessionManager.getInstance();
      const parent = mgr.getParentSession(match.params['id']);
      if (!parent) { sendJson(res, 404, { error: 'Parent session not found' }); return true; }
      sendJson(res, 200, { sessionId: parent.sessionId, title: parent.title, agentId: parent.agentId, status: parent.status });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SessionRootRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/sessions/:id/root';
  category = 'Sessions'; description = 'Get root (top-level) session of a session';
  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const mgr = SessionManager.getInstance();
      const root = mgr.getRootSession(match.params['id']);
      sendJson(res, 200, { sessionId: root.sessionId, title: root.title, agentId: root.agentId, status: root.status });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class ActiveSessionRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/sessions-active';
  category = 'Sessions'; description = 'Get the currently active main session';
  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const mgr = SessionManager.getInstance();
      const id = mgr.getActiveSessionId();
      const active = id ? mgr.session(id) : undefined;
      sendJson(res, 200, { sessionId: id, title: active?.title, agentId: active?.agentId });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SetActiveSessionRoute implements RouteHandler {
  method = 'PUT' as const; path = '/api/v1/sessions-active';
  category = 'Sessions'; description = 'Set the active main session (body: { sessionId })';
  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const body = await readBody(req);
      const id = body.sessionId as string;
      if (!id) { sendJson(res, 400, { error: 'sessionId required' }); return true; }
      SessionManager.getInstance().setActiveSession(id);
      sendJson(res, 200, { sessionId: id, active: true });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SessionGarbageCollectRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/sessions/gc';
  category = 'Sessions'; description = 'Trigger garbage collection (archive idle >90 day sessions)';
  async handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const count = await SessionStore.getInstance().garbageCollect();
      sendJson(res, 200, { archived: count });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class HardDeleteSessionRoute implements RouteHandler {
  method = 'DELETE' as const; path = '/api/v1/sessions/:id/permanent';
  category = 'Sessions'; description = 'Permanently delete a session from disk (no recovery)';
  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const sessionId = match.params['id'];
      const mgr = SessionManager.getInstance();

      // Clean up in-memory state before deleting from disk
      const session = mgr.session(sessionId);
      if (session) {
        // Remove from parent's subSessionIds
        if (session.parentSessionId) {
          const parent = mgr.session(session.parentSessionId);
          if (parent) {
            parent.removeSubSession(sessionId);
            await SessionStore.getInstance().writeSessionMeta(parent.sessionId, parent.toJSON());
          }
        }
        // Clean up interrupt controller + abort any stuck loop
        InterruptController.getInstance().requestInterrupt(sessionId, InterruptReason.UserStop);
        InterruptController.getInstance().removeController(sessionId);
        AgentRuntime.getInstance().cleanupSession(sessionId);
      }

      await SessionStore.getInstance().deleteSession(sessionId);
      mgr.releaseSessionResources(sessionId, true);
      TypedEventBus.emit('session:hard_deleted', { sessionId });
      sendJson(res, 200, { sessionId, deleted: true });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class SessionListFilteredRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/sessions-filtered';
  category = 'Sessions'; description = 'List sessions with status/type filter (?status=Archived&type=main)';
  handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const status = url.searchParams.get('status') || '';
      const type = url.searchParams.get('type') || '';
      const mgr = SessionManager.getInstance();
      let sessions = status ? mgr.listSessions(status as SessionStatus) : type === 'main' ? mgr.mainSessions() : mgr.activeSessions();
      sendJson(res, 200, {
        sessions: sessions.map(s => ({ sessionId: s.sessionId, title: s.title, agentId: s.agentId, status: s.status, parentSessionId: s.parentSessionId, level: s.level })),
        total: sessions.length,
      });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
