// WsRequired — shared helpers for HTTP endpoints that require WebSocket

import { WsServer } from '../infra/network/WsServer.js';
import type * as http from 'http';

type SendJson = (res: http.ServerResponse, code: number, body: Record<string, unknown>) => void;

export function requireWs(sessionId: string, res: http.ServerResponse, sendJson: SendJson): boolean {
  if (WsServer.getInstance().isConnected(sessionId)) return true;
  sendJson(res, 503, { error: 'WebSocket Required', message: 'Write operations require WebSocket' });
  return false;
}

export function requireWsAny(res: http.ServerResponse, sendJson: SendJson): boolean {
  if (WsServer.getInstance().isConnected()) return true;
  sendJson(res, 503, { error: 'WebSocket Required', message: 'Write operations require WebSocket' });
  return false;
}
