// AnoClaw Frontend — WebSocket Client (single global connection)
// ONE persistent WebSocket connection for the entire app (not per-session).
// All outgoing messages carry a sessionId field. All incoming events
// carry a _sessionId field for routing to the correct session's UI.
//
// Wraps GatewayClient for connection management. Keeps the same public API
// as the original WSClient so no consumers need to change.

import { GatewayClient, type GatewayConnectionState } from '../lib/GatewayClient.js';
import { EventEmitter } from '../EventEmitter.js';
import { ClientLogger } from '../ClientLogger.js';

type WsEventHandler = (data: unknown) => void;

/** Mirror of GatewayClient connection states, exposed as a public enum for consumers. */
export enum WSConnectionState {
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnected = 'disconnected',
}

export class WSClient {
  /** Underlying GatewayClient that manages the actual WebSocket lifecycle. */
  private _gw: GatewayClient;
  /** Internal EventEmitter used to maintain the legacy on/off event subscription API. */
  private _emitter: EventEmitter = new EventEmitter();
  private _connectionState: WSConnectionState = WSConnectionState.Disconnected;
  /** Whether this client has ever successfully connected. Used to distinguish first connect from reconnect. */
  private _hasConnectedOnce: boolean = false;

  constructor() {
    console.log('[WS] WSClient constructor');
    this._gw = new GatewayClient();

    // Forward GatewayClient events to the old EventEmitter-based API.
    // Extract _sessionId from the transport envelope so the router can dispatch
    // to the correct SessionAgent.
    this._gw.onAny(({ type, payload }) => {
      const data = payload as Record<string, unknown>;

      // Extract _sessionId from transport envelope for routing
      const sessionId = (data._sessionId as string) || '';
      delete data._sessionId;

      ClientLogger.ws.debug('WS message received', { type, sessionId });
      // Emit both a generic 'event' (with session routing info) and the typed event
      this._emitter.emit('event', { type, data, sessionId });
      this._emitter.emit(type, data);
    });

    // Map GatewayClient connection states to our public WSConnectionState enum.
    // On reconnect (not first connect), emit 'reconnected' so consumers can reload state.
    this._gw.onStateChange((state: GatewayConnectionState) => {
      const oldState = this._connectionState;
      switch (state) {
        case 'open':
          this._connectionState = WSConnectionState.Connected;
          console.log('[WS] Connection state -> Connected');

          // Emit reconnected only if this is NOT the very first connect
          if (this._hasConnectedOnce) {
            this._emitter.emit('reconnected', {});
          }
          this._hasConnectedOnce = true;
          break;
        case 'connecting':
          this._connectionState = WSConnectionState.Connecting;
          break;
        default:
          this._connectionState = WSConnectionState.Disconnected;
          console.log('[WS] Connection state -> Disconnected');
          break;
      }
      if (oldState !== this._connectionState) {
        ClientLogger.ws.debug('WS state changed', { from: oldState, to: this._connectionState });
        this._emitter.emit('connectionStateChanged', this._connectionState);
      }
    });

    // Forward serverRestarted event — consumers should reload sessions, agents, etc.
    this._gw.on('serverRestarted', (data) => {
      ClientLogger.ws.info('Server restarted detected — reloading all state');
      this._emitter.emit('serverRestarted', data);
    });

    // Forward connectionLost event — fired when max reconnect attempts are exhausted
    this._gw.on('connectionLost', (data) => {
      ClientLogger.ws.error('Max reconnect attempts reached');
      this._emitter.emit('connectionLost', data);
    });
  }

  /** Connect once at app init (no session binding). GatewayClient handles auto-reconnect internally. */
  connect(): void {
    console.log('[WS] connect() called');
    this._gw.connect();
  }

  /** Disconnect and stop auto-reconnect. */
  disconnect(): void {
    console.log('[WS] disconnect() called');
    this._gw.disconnect();
  }

  get connected(): boolean {
    return this._gw.connectionState === 'open';
  }

  get connectionState(): WSConnectionState {
    return this._connectionState;
  }

  /** Always null — this is a global connection, not per-session. */
  get sessionId(): string | null {
    return null; // Global connection, not per-session
  }

  /** Send a chat message for a given session. Includes permission mode, effort, and attachments. */
  sendMessage(sessionId: string, content: string, mode?: string, effortMode?: boolean, attachments?: Array<Record<string, unknown>>): void {
    console.log('[WS] sendMessage — sessionId:', sessionId);
    this._gw.send({
      type: 'send_message',
      sessionId,
      content,
      mode: mode || 'auto',
      effort: effortMode !== undefined ? effortMode : true,
      messageId: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      attachments,
    });
  }

  /** Send a stop-generation command for a given session. */
  stopGeneration(sessionId: string): void {
    console.log('[WS] stopGeneration — sessionId:', sessionId);
    this._gw.send({ type: 'stop', sessionId });
  }

  /** Run a slash command in the context of a session. */
  runCommand(sessionId: string, command: string, args?: Record<string, string>): void {
    this._gw.send({
      type: 'run_command',
      sessionId,
      command,
      args: args || {},
      messageId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
  }

  /** Send a ping to keep the connection alive / check latency. */
  sendPing(): void {
    this._gw.send({ type: 'ping', sessionId: '__ping__' });
  }

  /** Push editor context (open files, cursor, selection) to server for prompt injection. */
  sendEditorContext(sessionId: string, ctx: { openFiles?: string[]; activeFile?: string; cursorLine?: number; cursorColumn?: number; selectedText?: string; selectedStartLine?: number; selectedEndLine?: number }): void {
    this._gw.send({ type: 'editor_context', sessionId, ...ctx });
  }

  /** Generic send for arbitrary WS messages. */
  send(data: Record<string, unknown>): void {
    this._gw.send(data);
  }

  /** Subscribe to an event type (legacy API, delegates to internal EventEmitter). */
  on(eventType: string, handler: WsEventHandler): void {
    this._emitter.on(eventType, handler as (...args: unknown[]) => void);
  }

  /** Unsubscribe from an event type. */
  off(eventType: string, handler: WsEventHandler): void {
    this._emitter.off(eventType, handler as (...args: unknown[]) => void);
  }
}
