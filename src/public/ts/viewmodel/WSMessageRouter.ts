// WSMessageRouter — typed registry for client-side WebSocket event dispatch
// Replaces scattered `wsClient.on('type', handler)` calls with a centralized router.
// Message handlers self-register; new message types only need a handler file.

export interface WSHandlerContext {
  type: string;
  data: Record<string, unknown>;
  sessionId: string;
}

export type WSHandler = (ctx: WSHandlerContext) => void;

export class WSMessageRouter {
  private _handlers = new Map<string, WSHandler[]>();

  on(type: string, handler: WSHandler): void {
    console.log('[Router] Handler registered for type:', type);
    if (!this._handlers.has(type)) {
      this._handlers.set(type, []);
    }
    this._handlers.get(type)!.push(handler);
  }

  dispatch(type: string, data: Record<string, unknown>, sessionId: string): void {
    console.debug('[Router] dispatch — type:', type, 'sessionId:', sessionId);
    const handlers = this._handlers.get(type);
    if (!handlers?.length) return;
    for (const handler of handlers) {
      handler({ type, data, sessionId });
    }
  }

  clear(): void { this._handlers.clear(); }
}
