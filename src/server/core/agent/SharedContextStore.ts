/**
 * SharedContextStore — key-value shared state per team/session.
 *
 * Enables bidirectional context sharing between parent and child agents.
 * Parent writes progress updates → child reads them in real-time.
 * Child writes results → parent reads immediately (no waiting for completion).
 *
 * Data is scoped by team name (from agent config) or session ID.
 * Stored in-memory; survives for the session lifetime.
 *
 * @module SharedContextStore
 */

/** Entry in the shared context store — written by one agent, read by others. */
export interface ContextEntry {
  key: string;
  value: string;
  writtenBy: string; // agentId
  timestamp: string;
}

/**
 * Singleton store for bidirectional key-value sharing between agents.
 * Scoped by team name or session ID. Entries auto-evict when over limit.
 */
export class SharedContextStore {
  private static _instance: SharedContextStore;
  /** teamName → Map<key, ContextEntry> */
  private _stores = new Map<string, Map<string, ContextEntry>>();
  /** Max entries per team before oldest are evicted */
  private static MAX_ENTRIES = 500;

  static getInstance(): SharedContextStore {
    if (!this._instance) this._instance = new SharedContextStore();
    return this._instance;
  }

  /** Write a value to the shared context. */
  set(scope: string, key: string, value: string, agentId: string): void {
    if (!this._stores.has(scope)) {
      this._stores.set(scope, new Map());
    }
    const store = this._stores.get(scope)!;

    store.set(key, {
      key,
      value,
      writtenBy: agentId,
      timestamp: new Date().toISOString(),
    });

    // Evict oldest entries while over limit
    while (store.size > SharedContextStore.MAX_ENTRIES) {
      const oldest = store.keys().next().value as string;
      if (oldest) store.delete(oldest);
    }
  }

  /** Read a value. Returns null if not found. */
  get(scope: string, key: string): ContextEntry | null {
    return this._stores.get(scope)?.get(key) ?? null;
  }

  /** Get all entries in a scope, ordered by timestamp (oldest first). */
  getAll(scope: string): ContextEntry[] {
    const store = this._stores.get(scope);
    if (!store) return [];
    return [...store.values()].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  /** Get entries written after a specific timestamp. */
  getSince(scope: string, since: string): ContextEntry[] {
    return this.getAll(scope).filter(e => e.timestamp > since);
  }

  /** Remove all entries for a scope (cleanup when session ends). */
  clearScope(scope: string): void {
    this._stores.delete(scope);
  }

  /** Number of entries in a scope. */
  size(scope: string): number {
    return this._stores.get(scope)?.size ?? 0;
  }
}
