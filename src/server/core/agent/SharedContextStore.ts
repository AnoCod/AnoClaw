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
  value: unknown;
  writtenBy: string; // agentId
  timestamp: number; // Date.now() for TTL eviction
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
  /** Default TTL in milliseconds (5 minutes). Entries older than this are evicted on read. */
  private static DEFAULT_TTL_MS = 5 * 60 * 1000;

  static getInstance(): SharedContextStore {
    if (!this._instance) this._instance = new SharedContextStore();
    return this._instance;
  }

  /** Write a value to the shared context. */
  set(scope: string, key: string, value: unknown, agentId: string): void {
    if (!this._stores.has(scope)) {
      this._stores.set(scope, new Map());
    }
    const store = this._stores.get(scope)!;

    store.set(key, {
      key,
      value,
      writtenBy: agentId,
      timestamp: Date.now(),
    });

    // Evict oldest entries while over limit
    while (store.size > SharedContextStore.MAX_ENTRIES) {
      const oldest = store.keys().next().value as string;
      if (oldest) store.delete(oldest);
    }
  }

  /** Read a value. Returns null if not found or expired. */
  get(scope: string, key: string): ContextEntry | null {
    const entry = this._stores.get(scope)?.get(key) ?? null;
    if (entry && this._isExpired(entry)) {
      this._stores.get(scope)?.delete(key);
      return null;
    }
    return entry;
  }

  /** Get all entries in a scope, ordered by timestamp (oldest first). Expired entries are evicted. */
  getAll(scope: string): ContextEntry[] {
    const store = this._stores.get(scope);
    if (!store) return [];
    this._evictExpired(store);
    return [...store.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get entries written after a specific timestamp. Expired entries are evicted. */
  getSince(scope: string, since: number): ContextEntry[] {
    return this.getAll(scope).filter(e => e.timestamp > since);
  }

  /** Remove all entries for a scope (cleanup when session ends). */
  clearScope(scope: string): void {
    this._stores.delete(scope);
  }

  /** Number of entries in a scope (after TTL eviction). */
  size(scope: string): number {
    const store = this._stores.get(scope);
    if (!store) return 0;
    this._evictExpired(store);
    return store.size;
  }

  /** Check if an entry has exceeded its TTL. */
  private _isExpired(entry: ContextEntry): boolean {
    return Date.now() - entry.timestamp > SharedContextStore.DEFAULT_TTL_MS;
  }

  /** Remove all expired entries from a store. */
  private _evictExpired(store: Map<string, ContextEntry>): void {
    for (const [key, entry] of store) {
      if (this._isExpired(entry)) {
        store.delete(key);
      }
    }
  }
}
