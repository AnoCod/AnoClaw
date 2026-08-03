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

  waitForConfirmation(
    sessionId: string,
    toolCallId: string,
    timeoutMs: number = 60000,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = confirmationKey(sessionId, toolCallId);
    // A duplicated provider tool-call ID must never share or inherit another
    // pending approval. Reject the duplicate safely and leave the original
    // request untouched.
    if (this._pending.has(key)) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        this.resolve(sessionId, toolCallId, false);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        this.resolve(sessionId, toolCallId, false);
      }, timeoutMs);

      this._pending.set(key, {
        resolve,
        timer,
        signalAbort: signal ? () => signal.removeEventListener('abort', onAbort) : undefined,
      });
    });
  }

  resolve(sessionId: string, toolCallId: string, approved: boolean): boolean {
    const key = confirmationKey(sessionId, toolCallId);
    const entry = this._pending.get(key);
    if (!entry) return false;

    clearTimeout(entry.timer);
    if (entry.signalAbort) entry.signalAbort();
    this._pending.delete(key);
    entry.resolve(approved);
    return true;
  }
}

function confirmationKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}
