// WsMessageRouter — typed registry for WebSocket message handlers
// Replaces hardcoded switch statements with a pluggable dispatch system.
// Subsystems register handlers for their message types; unknown types pass through silently.

import type { Transport } from './Transport.js';

export interface WsMessageContext {
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
  ws: Transport;
}

export type WsMessageHandler = (ctx: WsMessageContext) => Promise<void> | void;

export class WsMessageRouter {
  private _handlers = new Map<string, WsMessageHandler[]>();

  /** Register a handler for a message type. Multiple handlers per type are allowed. */
  on(type: string, handler: WsMessageHandler): void {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, []);
    }
    this._handlers.get(type)!.push(handler);
  }

  /** Dispatch a message to all registered handlers for its type. */
  async dispatch(ctx: WsMessageContext): Promise<void> {
    const handlers = this._handlers.get(ctx.type);
    if (!handlers || handlers.length === 0) return;
    for (const handler of handlers) {
      await handler(ctx);
    }
  }

  /** Remove all handlers (for testing/reset). */
  clear(): void {
    this._handlers.clear();
  }
}
