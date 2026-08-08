/**
 * Minimal JSON-RPC 2.0 engine for MCP transports (stdio / SSE / HTTP).
 */

export type SendFn = (message: string) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpJsonRpc {
  private _reqId = 0;
  private _pending = new Map<number, PendingRequest>();

  private _nextId(): number {
    return ++this._reqId;
  }

  request(sendFn: SendFn, method: string, params: unknown, timeoutMs = 25_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        sendFn(msg);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(sendFn: SendFn, method: string, params: unknown): void {
    sendFn(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /** Feed a received JSON string. Returns true when it resolved a pending request. */
  feed(jsonStr: string): boolean {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (msg.id == null || !this._pending.has(Number(msg.id))) return false;
    const { resolve, reject, timer } = this._pending.get(Number(msg.id))!;
    this._pending.delete(Number(msg.id));
    clearTimeout(timer);
    if (msg.error) reject(new Error(String((msg.error as { message?: string }).message ?? JSON.stringify(msg.error))));
    else resolve(msg.result);
    return true;
  }

  /** Reject all pending requests (called on disconnect). */
  drain(error: Error): void {
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }
}
