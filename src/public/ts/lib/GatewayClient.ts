// AnoClaw Frontend — GatewayClient (Hermes-inspired structured WebSocket client)
// Single persistent connection, typed events, connection state machine.
// Handles connect/disconnect, heartbeat, reconnect, server epoch detection.

import { ClientLogger } from '../ClientLogger.js';

export type GatewayConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

type GatewayEventHandler = (payload: unknown) => void;
type GatewayAnyEventHandler = (event: { type: string; payload: unknown }) => void;
type StateChangeHandler = (state: GatewayConnectionState) => void;

export class GatewayClient {
  private _ws: WebSocket | null = null;
  private _connectionId: number = 0;
  private _state: GatewayConnectionState = 'idle';
  private _eventHandlers = new Map<string, Set<GatewayEventHandler>>();
  private _anyHandlers = new Set<GatewayAnyEventHandler>();
  private _stateHandlers = new Set<StateChangeHandler>();
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts: number = 0;
  private _maxReconnectAttempts: number = 20;
  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _intentionalClose: boolean = false;
  private _serverEpoch: number = 0;

  get connectionState(): GatewayConnectionState { return this._state; }

  private _setState(state: GatewayConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const h of this._stateHandlers) h(state);
  }

  connect(): void {
    if (this._ws?.readyState === WebSocket.OPEN || this._state === 'connecting') return;
    this._intentionalClose = false;
    this._connectionId++;
    const connId = this._connectionId;

    if (this._ws) { this._ws.close(1000, 'Reconnecting'); this._ws = null; }

    this._setState('connecting');

    const url = `ws://${location.host}/ws`;
    ClientLogger.ws.info('GatewayClient connecting', { url });

    this._ws = new WebSocket(url);

    this._ws.addEventListener('open', () => {
      if (this._connectionId !== connId) return;
      const wasReconnect = this._reconnectAttempts > 0;
      this._reconnectAttempts = 0;
      this._setState('open');
      this._startPing();
      ClientLogger.ws.info('GatewayClient connected', { reconnect: wasReconnect });
    });

    this._ws.addEventListener('message', (event: MessageEvent) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(event.data as string); } catch { return; }
      const type = data.type as string;
      if (!type) return;

      if (type === 'serverEpoch') {
        const epoch = data.epoch as number;
        if (this._serverEpoch && this._serverEpoch !== epoch) {
          this._emit('serverRestarted', {});
        }
        this._serverEpoch = epoch;
        return;
      }

      // Dispatch to type-specific and catch-all handlers
      // _sessionId is left in data so the WSClient wrapper can extract it for routing
      this._emit(type, data);
      for (const h of this._anyHandlers) h({ type, payload: data });
    });

    this._ws.addEventListener('close', (closeEvent: CloseEvent) => {
      if (this._connectionId !== connId) return;
      this._stopPing();
      this._setState('closed');

      if (closeEvent.code === 1012) {
        ClientLogger.ws.info('Server restart detected — reloading page');
        window.location.reload();
        return;
      }

      if (!this._intentionalClose) this._scheduleReconnect();
    });

    this._ws.addEventListener('error', () => {
      if (this._connectionId !== connId) return;
      this._setState('error');
    });
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._emit('connectionLost', { reason: 'maxReconnectAttempts', attempts: this._reconnectAttempts });
      return;
    }
    this._reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 30000) + Math.random() * 3000;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  disconnect(): void {
    this._intentionalClose = true;
    this._stopPing();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._reconnectAttempts = 0;
    if (this._ws) { this._ws.close(1000, 'Client disconnect'); this._ws = null; }
    this._setState('closed');
  }

  /** Send a message. If not connected, silently drops (caller should check connectionState). */
  send(data: Record<string, unknown>): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify(data));
  }

  /** Subscribe to a specific event type. */
  on(type: string, handler: GatewayEventHandler): void {
    if (!this._eventHandlers.has(type)) this._eventHandlers.set(type, new Set());
    this._eventHandlers.get(type)!.add(handler);
  }

  /** Unsubscribe from a specific event type. */
  off(type: string, handler: GatewayEventHandler): void {
    this._eventHandlers.get(type)?.delete(handler);
  }

  /** Subscribe to ALL events (catch-all). */
  onAny(handler: GatewayAnyEventHandler): void {
    this._anyHandlers.add(handler);
  }

  /** Subscribe to connection state changes. */
  onStateChange(handler: StateChangeHandler): void {
    this._stateHandlers.add(handler);
  }

  get serverEpoch(): number { return this._serverEpoch; }

  private _emit(type: string, payload: unknown): void {
    const handlers = this._eventHandlers.get(type);
    if (handlers) for (const h of handlers) h(payload);
  }

  private _startPing(): void {
    this._stopPing();
    this._pingTimer = setInterval(() => this.send({ type: 'ping', sessionId: '__ping__' }), 30000);
  }

  private _stopPing(): void {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }
}
