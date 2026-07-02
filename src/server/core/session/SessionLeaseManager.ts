// SessionLeaseManager — limits concurrent session execution, releases idle sessions.
// Prevents server overload from too many simultaneous agent loops.

export interface LeaseToken {
  sessionId: string;
  acquiredAt: number;
  lastActivityAt: number;
}

export class SessionLeaseManager {
  private static _instance: SessionLeaseManager | null = null;
  private _leases: Map<string, LeaseToken> = new Map();
  private _reaperTimer: ReturnType<typeof setInterval> | null = null;

  static getInstance(): SessionLeaseManager {
    if (!SessionLeaseManager._instance) {
      SessionLeaseManager._instance = new SessionLeaseManager();
    }
    return SessionLeaseManager._instance;
  }

  constructor(
    private _maxConcurrent: number = Infinity,
    private _idleTimeoutMs: number = 5 * 60 * 1000,
    private _reaperIntervalMs: number = 30000,
  ) {}

  acquire(sessionId: string): LeaseToken | null {
    // If already has a lease, refresh it
    const existing = this._leases.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    // No global limit — AnoClaw is a team collaboration platform.
    // Per-session concurrency is enforced by SessionManager._concurrentTurnGuard.
    const token: LeaseToken = { sessionId, acquiredAt: Date.now(), lastActivityAt: Date.now() };
    this._leases.set(sessionId, token);
    return token;
  }

  release(sessionId: string): void {
    this._leases.delete(sessionId);
  }

  touch(sessionId: string): void {
    const token = this._leases.get(sessionId);
    if (token) token.lastActivityAt = Date.now();
  }

  get activeCount(): number { return this._leases.size; }

  get activeSessionIds(): string[] { return [...this._leases.keys()]; }

  start(): void {
    if (this._reaperTimer) return;
    this._reaperTimer = setInterval(() => this._reap(), this._reaperIntervalMs);
  }

  stop(): void {
    if (this._reaperTimer) { clearInterval(this._reaperTimer); this._reaperTimer = null; }
  }

  private _reap(): void {
    const now = Date.now();
    for (const [sid, token] of this._leases) {
      if (now - token.lastActivityAt > this._idleTimeoutMs) {
        this._leases.delete(sid);
      }
    }
  }

  resetInstance(): void {
    this.stop();
    this._leases.clear();
    SessionLeaseManager._instance = null;
  }
}
