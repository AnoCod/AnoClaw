// WsRoutes — WebSocket connection info, broadcast, disconnect
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson, readBody } from '../RouteHelpers.js';
import { WsServer } from '../../infra/network/WsServer.js';

export class WsConnectionsRoute implements RouteHandler {
  method = 'GET' as const; path = '/api/v1/ws/connections';
  category = 'System'; description = 'List sessions with active WebSocket connections';
  handle(_m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      const ws = WsServer.getInstance();
      sendJson(res, 200, { sessions: ws.activeSessions(), connectionCount: ws.connectionCount });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class WsBroadcastRoute implements RouteHandler {
  method = 'POST' as const; path = '/api/v1/ws/broadcast';
  category = 'System'; description = 'Broadcast a message to all connected WebSocket clients';
  async handle(_m: RouteMatch, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const body = await readBody(req);
      WsServer.getInstance().broadcast(body as Record<string, unknown>);
      sendJson(res, 200, { broadcast: true });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}

export class WsDisconnectRoute implements RouteHandler {
  method = 'DELETE' as const; path = '/api/v1/ws/connections/:sessionId';
  category = 'System'; description = 'Force-close a WebSocket connection by session ID';
  handle(m: RouteMatch, _r: IncomingMessage, res: ServerResponse): boolean {
    try {
      WsServer.getInstance().closeSession(m.params['sessionId']);
      sendJson(res, 200, { sessionId: m.params['sessionId'], disconnected: true });
    } catch (err) { sendJson(res, 500, { error: (err as Error).message }); }
    return true;
  }
}
