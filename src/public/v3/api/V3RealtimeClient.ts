export interface V3RealtimeSubscription {
  companyAfterRevision: number;
  works: Array<{ workId: string; afterRevision: number }>;
}

export interface V3RealtimeInvalidation {
  scopeType: 'company' | 'work' | 'all';
  scopeId: string;
  revision: number;
  snapshotRequired: boolean;
}

/**
 * Browser-side revision client. REST snapshots remain authoritative; WebSocket
 * events only invalidate a scope and allow the shell to refetch it.
 */
export class V3RealtimeClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private subscription: V3RealtimeSubscription = {
    companyAfterRevision: 0,
    works: [],
  };

  constructor(
    private readonly onInvalidation: (event: V3RealtimeInvalidation) => void,
  ) {}

  start(subscription: V3RealtimeSubscription): void {
    this.subscription = cloneSubscription(subscription);
    this.stopped = false;
    this.connect();
  }

  update(subscription: V3RealtimeSubscription): void {
    this.subscription = cloneSubscription(subscription);
    this.sendSubscription();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, 'view disposed');
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped || this.socket?.readyState === WebSocket.OPEN) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.addEventListener('open', () => this.sendSubscription());
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1_500);
    });
    socket.addEventListener('error', () => socket.close());
  }

  private sendSubscription(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: 'v3_subscribe',
      sessionId: 'v3-shell',
      ...this.subscription,
    }));
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'v3_event') {
      const scopeType = message.scopeType;
      const scopeId = message.scopeId;
      const revision = message.revision;
      if (
        (scopeType === 'company' || scopeType === 'work')
        && typeof scopeId === 'string'
        && Number.isSafeInteger(revision)
      ) {
        this.onInvalidation({
          scopeType,
          scopeId,
          revision: Number(revision),
          snapshotRequired: false,
        });
      }
    } else if (message.type === 'v3_snapshot_required') {
      this.onInvalidation({
        scopeType: message.scopeType === 'company' || message.scopeType === 'work'
          ? message.scopeType
          : 'all',
        scopeId: typeof message.scopeId === 'string' ? message.scopeId : '*',
        revision: Number.isSafeInteger(message.currentRevision)
          ? Number(message.currentRevision)
          : 0,
        snapshotRequired: true,
      });
    }
  }
}

function cloneSubscription(value: V3RealtimeSubscription): V3RealtimeSubscription {
  return {
    companyAfterRevision: value.companyAfterRevision,
    works: value.works.map((entry) => ({ ...entry })),
  };
}
