// ConfirmationRegistry — server-side promise registry for pending tool confirmations
// AgentLoop calls waitForConfirmation() which returns Promise<boolean>.
// The WS handler calls resolve() when the user clicks Approve/Reject.

export class ConfirmationRegistry {
  private static _instance: ConfirmationRegistry;
  private _pending: Map<string, {
    resolve: (approved: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
    signalAbort?: () => void;
  }> = new Map();

  static getInstance(): ConfirmationRegistry {
    if (!ConfirmationRegistry._instance) {
      ConfirmationRegistry._instance = new ConfirmationRegistry();
    }
    return ConfirmationRegistry._instance;
  }

  static resetInstance(): void {
    const inst = ConfirmationRegistry._instance;
    if (inst) {
      for (const [, entry] of inst._pending) {
        clearTimeout(entry.timer);
        if (entry.signalAbort) entry.signalAbort();
        entry.resolve(false);
      }
      inst._pending.clear();
    }
    ConfirmationRegistry._instance = undefined as unknown as ConfirmationRegistry;
  }

  waitForConfirmation(toolCallId: string, timeoutMs: number = 60000, signal?: AbortSignal): Promise<boolean> {
    if (this._pending.has(toolCallId)) {
      return this._pending.get(toolCallId)!.resolve as unknown as Promise<boolean>;
    }

    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        this.resolve(toolCallId, false);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        this.resolve(toolCallId, false);
      }, timeoutMs);

      this._pending.set(toolCallId, {
        resolve,
        timer,
        signalAbort: signal ? () => signal.removeEventListener('abort', onAbort) : undefined,
      });
    });
  }

  resolve(toolCallId: string, approved: boolean): void {
    const entry = this._pending.get(toolCallId);
    if (!entry) return;

    clearTimeout(entry.timer);
    if (entry.signalAbort) entry.signalAbort();
    this._pending.delete(toolCallId);
    entry.resolve(approved);
  }
}
