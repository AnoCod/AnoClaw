/**
 * WsServer — multi-window WebSocket transport
 *
 * Multiple persistent WS connections are supported for Electron multi-window use.
 * Every outgoing message carries `_sessionId` so the frontend can route it
 * to the correct session's UI.
 *
 * Outgoing buffer: events for a sessionId are buffered when the client is
 * disconnected and flushed on reconnect — no event loss during brief blips.
 */

import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import { LogManager } from '../logging/LogManager.js';
import type { Transport } from './Transport.js';
import { WsMessageType } from '../../../shared/types/ws-protocol.js';

export interface WsConnection {
  ws: WebSocket;
  connectedAt: number;
  isAlive: boolean;
}

export function isAllowedWsOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin || !hostHeader) return false;
  try {
    const parsed = new URL(origin);
    const target = new URL(`http://${hostHeader}`);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const targetHostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const allowedHost = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    const targetIsLocal = ['localhost', '127.0.0.1', '::1'].includes(targetHostname);
    return allowedHost && targetIsLocal
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.port === target.port;
  } catch {
    return false;
  }
}

export class WsServer extends EventEmitter implements Transport {
  private static _instance: WsServer;
  private wss: WebSocketServer | null = null;
  /** Active UI connections. Events are broadcast so every window stays current. */
  private _connections: Map<WebSocket, WsConnection> = new Map();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Event buffers keyed by sessionId — survive brief disconnects */
  private _eventBuffers: Map<string, Array<{ event: Record<string, unknown>; ts: number; seq: number }>> = new Map();
  private _seqCounter = 0;
  private static readonly MAX_BUFFERED_EVENTS = 300;
  private static readonly BUFFER_TTL_MS = 5 * 60_000; // 5 min — drop stale events while connected
  private static readonly BUFFER_TTL_DISCONNECTED_MS = 30_000; // 30s — aggressive cleanup when no client
  private static readonly BUFFER_CLEANUP_INTERVAL_MS = 60_000; // sweep every 60s
  private _bufferCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 15000;
  readonly serverEpoch = Date.now();

  static getInstance(): WsServer {
    if (!this._instance) this._instance = new WsServer();
    return this._instance;
  }

  private constructor() { super(); }

  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      maxPayload: 2 * 1024 * 1024,
      verifyClient: ({ req }: { req: IncomingMessage }) => isAllowedWsOrigin(req.headers.origin, req.headers.host),
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      if (pathname !== '/ws') { ws.close(4000, 'Invalid path'); return; }

      const connection: WsConnection = { ws, connectedAt: Date.now(), isAlive: true };
      this._connections.set(ws, connection);
      ws.on('pong', () => { connection.isAlive = true; });

      ws.send(JSON.stringify({ type: 'serverEpoch', epoch: this.serverEpoch }));
      LogManager.getInstance().logger('anochat.core').info('WS client connected (global)');
      this.emit('clientConnected');

      // Flush ALL buffered events on reconnect
      this._flushAllBuffers(ws);

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as { type: string; [key: string]: unknown };
          // sessionId comes from the message payload, not URL
          const sessionId = (msg.sessionId as string) || 'default';
          this.emit('message', sessionId, msg);
        } catch {
          ws.send(JSON.stringify({ type: WsMessageType.Error, errorMessage: 'Invalid JSON' }));
        }
      });

      ws.on('close', () => {
        if (this._connections.delete(ws)) {
          LogManager.getInstance().logger('anochat.core').info('WS client disconnected');
          if (this._connections.size === 0) this.emit('clientDisconnected');
        }
      });

      ws.on('error', (err: Error) => {
        LogManager.getInstance().logger('anochat.core').warn('WS error', { error: err.message });
      });
    });

    LogManager.getInstance().logger('anochat.core').info('WebSocket server attached');

    this._heartbeatTimer = setInterval(() => {
      let removedAny = false;
      for (const [socket, connection] of this._connections) {
        if (!connection.isAlive) {
          LogManager.getInstance().logger('anochat.core').warn('WS heartbeat lost, terminating');
          try { socket.terminate(); } catch {}
          this._connections.delete(socket);
          removedAny = true;
          continue;
        }
        connection.isAlive = false;
        try { socket.ping(); } catch {}
      }
      if (removedAny && this._connections.size === 0) this.emit('clientDisconnected');
    }, WsServer.HEARTBEAT_INTERVAL_MS);

    // Periodic buffer cleanup: drop events older than TTL, remove empty buffers
    this._bufferCleanupTimer = setInterval(() => {
      this._sweepStaleBuffers();
    }, WsServer.BUFFER_CLEANUP_INTERVAL_MS);
  }

  /** Send message tagged with sessionId — the frontend routes by _sessionId.
   *  Never throws. Drops on serialization failure (logged). */
  send(sessionId: string, data: Record<string, unknown>): boolean {
    const openSockets = [...this._connections.keys()].filter(ws => ws.readyState === WebSocket.OPEN);
    if (openSockets.length === 0) {
      // Buffer for reconnect (with timestamp and sequence number)
      if (data.type !== 'ping') {
        this._bufferEvent(sessionId, data);
      }
      return false;
    }
    try {
      const payload = JSON.stringify({ ...data, _sessionId: sessionId });
      let pending = openSockets.length;
      let successful = 0;
      for (const socket of openSockets) socket.send(payload, (err?: Error) => {
        if (err) {
          LogManager.getInstance().logger('anochat.core').warn('WS send error, re-buffering', {
            sid: sessionId, type: data.type, error: err.message,
          });
          try { socket.terminate(); } catch {}
          this._connections.delete(socket);
          if (this._connections.size === 0) this.emit('clientDisconnected');
        } else {
          successful++;
        }
        pending--;
        if (pending === 0 && successful === 0 && data.type !== 'ping') {
          this._bufferEvent(sessionId, data);
        }
      });
    } catch (e) {
      LogManager.getInstance().logger('anochat.core').warn('WS send serialization error', {
        sid: sessionId, type: data.type, error: (e as Error).message,
      });
      return false;
    }
    return true;
  }

  /** Broadcast to the single connection. */
  broadcast(data: Record<string, unknown>): void {
    this.send('*broadcast', data);
  }

  shutdownAll(): void {
    for (const socket of this._connections.keys()) {
      try { socket.close(1012, 'Server restart'); } catch {}
    }
    this._connections.clear();
  }

  isConnected(_sessionId?: string): boolean {
    return [...this._connections.keys()].some(ws => ws.readyState === WebSocket.OPEN);
  }

  clearEventBuffer(sessionId: string): void {
    this._eventBuffers.delete(sessionId);
  }

  activeSessions(): string[] {
    return this.isConnected() ? ['*global*'] : [];
  }

  get connectionCount(): number {
    return this._connections.size;
  }

  /**
   * Add an event to the disconnected buffer. Adjacent delta events are
   * coalesced during long streams, and terminal events displace lower-value
   * entries instead of being dropped when the buffer is full.
   */
  private _bufferEvent(sessionId: string, event: Record<string, unknown>): void {
    const buf = this._eventBuffers.get(sessionId) || [];
    const type = String(event.type || '');
    const last = buf[buf.length - 1];
    const isAdjacentGlobally = !!last && last.seq === this._seqCounter;

    if (isAdjacentGlobally && (type === 'text' || type === 'think') && last.event.type === type) {
      last.event = {
        ...last.event,
        ...event,
        content: String(last.event.content || '') + String(event.content || ''),
      };
      last.ts = Date.now();
      this._eventBuffers.set(sessionId, buf);
      return;
    }
    if (isAdjacentGlobally && type === 'status' && last.event.type === type) {
      last.event = { ...last.event, ...event };
      last.ts = Date.now();
      this._eventBuffers.set(sessionId, buf);
      return;
    }

    const isTerminal = type === 'done' || type === 'error';
    if (buf.length >= WsServer.MAX_BUFFERED_EVENTS) {
      if (!isTerminal) return;
      const replaceIndex = buf.findIndex((entry) => {
        const bufferedType = String(entry.event.type || '');
        return bufferedType === 'text' || bufferedType === 'think' || bufferedType === 'status';
      });
      buf.splice(replaceIndex >= 0 ? replaceIndex : 0, 1);
    }

    buf.push({ event, ts: Date.now(), seq: ++this._seqCounter });
    this._eventBuffers.set(sessionId, buf);
  }

  /** Flush ALL buffered events to a newly connected client.
   *  Sorted by global sequence number to preserve event order across sessions.
   *  Drops events older than BUFFER_TTL_MS during flush. */
  private _flushAllBuffers(ws: WebSocket): void {
    const cutoff = Date.now() - WsServer.BUFFER_TTL_MS;
    const logger = LogManager.getInstance().logger('anochat.core');
    // Collect all fresh events from all buffers, then sort by seq
    const allEntries: Array<{ sid: string; entry: { event: Record<string, unknown>; ts: number; seq: number } }> = [];
    for (const [sid, buf] of this._eventBuffers) {
      const fresh = buf.filter(e => e.ts >= cutoff);
      if (fresh.length === 0) {
        this._eventBuffers.delete(sid);
        continue;
      }
      const dropped = buf.length - fresh.length;
      logger.info('Flushing buffered events', { sid, count: fresh.length, dropped });
      for (const entry of fresh) {
        allEntries.push({ sid, entry });
      }
    }
    // Sort by global sequence number — preserves causal order across sessions
    allEntries.sort((a, b) => a.entry.seq - b.entry.seq);
    // Clear before sending so any callback/exception can safely re-buffer.
    for (const sid of this._eventBuffers.keys()) this._eventBuffers.delete(sid);
    for (const { sid, entry } of allEntries) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ ...entry.event, _sessionId: sid }), (err?: Error) => {
            if (err) {
              this._bufferEvent(sid, entry.event);
              logger.warn('WS flush send failed, re-buffered', { sid, type: entry.event.type, error: err.message });
            }
          });
        } catch (e) {
          this._bufferEvent(sid, entry.event);
          logger.warn('WS flush send exception, re-buffered', { sid, type: entry.event.type, error: (e as Error).message });
        }
      } else {
        this._bufferEvent(sid, entry.event);
      }
    }
  }

  /** Periodic sweep: drop events older than TTL, remove empty session buffers.
   *  When no client is connected, uses a shorter TTL to prevent unbounded
   *  memory growth from sessions that never reconnect. */
  private _sweepStaleBuffers(): void {
    const connected = this.isConnected();
    const ttl = connected ? WsServer.BUFFER_TTL_MS : WsServer.BUFFER_TTL_DISCONNECTED_MS;
    const cutoff = Date.now() - ttl;
    for (const [sid, buf] of this._eventBuffers) {
      const fresh = buf.filter(e => e.ts >= cutoff);
      if (fresh.length === 0) {
        this._eventBuffers.delete(sid);
      } else if (fresh.length < buf.length) {
        this._eventBuffers.set(sid, fresh);
      }
    }
  }

  /** Close the global connection if open. Also clears the event buffer for this session. */
  closeSession(sessionId: string): void {
    this._eventBuffers.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (this._bufferCleanupTimer) { clearInterval(this._bufferCleanupTimer); this._bufferCleanupTimer = null; }
      if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
      for (const socket of this._connections.keys()) {
        try { socket.close(1001, 'Server shutting down'); } catch {}
      }
      this._connections.clear();
      // Don't close this.wss — its upgrade handler on the HTTP server must
      // survive restart cycles (e.g., setup wizard shutdown → restart).
      resolve();
    });
  }
}
