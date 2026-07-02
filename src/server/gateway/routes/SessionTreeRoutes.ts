// SessionTreeRoutes — session hierarchy endpoints
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import type { SessionNode } from '../../../shared/types/session.js';

export class GetSessionTreeRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/sessions/tree';
  category = 'Sessions';
  description = 'Get full session hierarchy tree';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const mgr = SessionManager.getInstance();
      const flat = mgr.getSessionTree();
      const nested = buildNestedTree(flat);
      sendJson(res, 200, { sessions: nested, total: flat.length });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to list sessions', message: (err as Error).message });
    }
    return true;
  }
}

export class GetSessionSubtreeRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/sessions/:id/tree';
  category = 'Sessions';
  description = 'Get session subtree starting from a specific session';

  handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const sessionId = match.params['id'];
      const mgr = SessionManager.getInstance();
      const session = mgr.session(sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      const flat = mgr.getSessionTree();
      // Find the target in the flat list and collect its subtree
      const children = flat.filter(s => s.parentSessionId === sessionId || s.sessionId === sessionId);
      const nested = buildNestedTree(children);
      sendJson(res, 200, { sessionId, sessions: nested, total: children.length });
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to get subtree', message: (err as Error).message });
    }
    return true;
  }
}

/** Convert flat SessionNode[] into nested tree structure */
function buildNestedTree(flat: SessionNode[]): SessionNode[] {
  const map = new Map<string, SessionNode & { children?: SessionNode[] }>();
  for (const s of flat) {
    map.set(s.sessionId, { ...s, children: [] });
  }
  const roots: SessionNode[] = [];
  for (const node of map.values()) {
    if (node.parentSessionId && map.has(node.parentSessionId)) {
      map.get(node.parentSessionId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
