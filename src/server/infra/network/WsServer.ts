/**
 * WsServer — single-connection WebSocket server
 *
 * One persistent WS connection for the entire app (no per-session binding).
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

export class WsServer extends EventEmitter implements Transport {
  private static _instance: WsServer;
  private wss: WebSocketServer | null = null;
  /** Single global connection (replaces old per-session Map) */
  private _conn: WsConnection | null = null;
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
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      if (pathname !== '/ws') { ws.close(4000, 'Invalid path'); return; }

      // Close any previous connection (duplicate tab / reconnect)
      if (this._conn) {
        try { this._conn.ws.close(1000, 'Replaced by new connection'); } catch {}
      }

      this._conn = { ws, connectedAt: Date.now(), isAlive: true };
      ws.on('pong', () => { if (this._conn) this._conn.isAlive = true; });

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
        if (this._conn && this._conn.ws === ws) {
          LogManager.getInstance().logger('anochat.core').info('WS client disconnected');
          this._conn = null;
          this.emit('clientDisconnected');
        }
      });

      ws.on('error', (err: Error) => {
        LogManager.getInstance().logger('anochat.core').warn('WS error', { error: err.message });
      });
    });

    LogManager.getInstance().logger('anochat.core').info('WebSocket server attached');

    this._heartbeatTimer = setInterval(() => {
      if (!this._conn) return;
      if (!this._conn.isAlive) {
        LogManager.getInstance().logger('anochat.core').warn('WS heartbeat lost, terminating');
        try { this._conn.ws.terminate(); } catch {}
        this._conn = null;
        this.emit('clientDisconnected');
        return;
      }
      this._conn.isAlive = false;
      try {
        this._conn.ws.ping();
      } catch {}
    }, WsServer.HEARTBEAT_INTERVAL_MS);

    // Periodic buffer cleanup: drop events older than TTL, remove empty buffers
    this._bufferCleanupTimer = setInterval(() => {
      this._sweepStaleBuffers();
    }, WsServer.BUFFER_CLEANUP_INTERVAL_MS);
  }

  /** Send message tagged with sessionId — the frontend routes by _sessionId.
   *  Never throws. Drops on serialization failure (logged). */
  send(sessionId: string, data: Record<string, unknown>): boolean {
    if (!this._conn || this._conn.ws.readyState !== WebSocket.OPEN) {
      // Buffer for reconnect (with timestamp and sequence number)
      if (data.type !== 'ping') {
        const buf = this._eventBuffers.get(sessionId) || [];
        if (buf.length < WsServer.MAX_BUFFERED_EVENTS) {
          buf.push({ event: data, ts: Date.now(), seq: ++this._seqCounter });
          this._eventBuffers.set(sessionId, buf);
        }
      }
      return false;
    }
    try {
      const payload = JSON.stringify({ ...data, _sessionId: sessionId });
      this._conn.ws.send(payload, (err?: Error) => {
        if (err) {
          LogManager.getInstance().logger('anochat.core').warn('WS send error, re-buffering', {
            sid: sessionId, type: data.type, error: err.message,
          });
          if (data.type !== 'ping') {
            const buf = this._eventBuffers.get(sessionId) || [];
            if (buf.length < WsServer.MAX_BUFFERED_EVENTS) {
              buf.push({ event: data, ts: Date.now(), seq: ++this._seqCounter });
              this._eventBuffers.set(sessionId, buf);
            }
          }
          try { this._conn?.ws.terminate(); } catch {}
          this._conn = null;
          this.emit('clientDisconnected');
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
    if (this._conn) {
      try { this._conn.ws.close(1012, 'Server restart'); } catch {}
      this._conn = null;
    }
  }

  isConnected(_sessionId?: string): boolean {
    return this._conn !== null && this._conn.ws.readyState === WebSocket.OPEN;
  }

  clearEventBuffer(sessionId: string): void {
    this._eventBuffers.delete(sessionId);
  }

  activeSessions(): string[] {
    return this._conn ? ['*global*'] : [];
  }

  get connectionCount(): number {
    return this._conn ? 1 : 0;
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
    for (const { sid, entry } of allEntries) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ ...entry.event, _sessionId: sid }), (err?: Error) => {
            if (err) {
              const buf = this._eventBuffers.get(sid) || [];
              if (buf.length < WsServer.MAX_BUFFERED_EVENTS) {
                buf.push({ event: entry.event, ts: Date.now(), seq: ++this._seqCounter });
                this._eventBuffers.set(sid, buf);
              }
              logger.warn('WS flush send failed, re-buffered', { sid, type: entry.event.type, error: err.message });
            }
          });
        } catch (e) {
          const buf = this._eventBuffers.get(sid) || [];
          if (buf.length < WsServer.MAX_BUFFERED_EVENTS) {
            buf.push({ event: entry.event, ts: Date.now(), seq: ++this._seqCounter });
            this._eventBuffers.set(sid, buf);
          }
          logger.warn('WS flush send exception, re-buffered', { sid, type: entry.event.type, error: (e as Error).message });
        }
      }
    }
    // Clear all buffers after flushing
    for (const sid of this._eventBuffers.keys()) {
      this._eventBuffers.delete(sid);
    }
  }

  /** Periodic sweep: drop events older than TTL, remove empty session buffers.
   *  When no client is connected, uses a shorter TTL to prevent unbounded
   *  memory growth from sessions that never reconnect. */
  private _sweepStaleBuffers(): void {
    const connected = this._conn !== null && this._conn.ws.readyState === WebSocket.OPEN;
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
      if (this._conn) { try { this._conn.ws.close(1001, 'Server shutting down'); } catch {} this._conn = null; }
      // Don't close this.wss — its upgrade handler on the HTTP server must
      // survive restart cycles (e.g., setup wizard shutdown → restart).
      resolve();
    });
  }
}
