// PromptCache — two-level cache (global + per-session)
// Key pattern: {agentId}:{sessionId}:{sectionName}

import { CacheScope } from './PromptSection.js';

export class PromptCache {
  /** Global cache — static zone content shared across all agents/sessions */
  private _globalCache = new Map<string, string>();

  /** Session-scoped cache — keyed by `agentId:sessionId:sectionName` */
  private _sessionCache = new Map<string, string>();

  // ─── Set / Get / Has ───────────────────────────────────────

  set(key: string, value: string, scope: CacheScope): void {
    switch (scope) {
      case CacheScope.Global:
        this._globalCache.set(key, value);
        break;
      case CacheScope.Agent:
      case CacheScope.Session:
        this._sessionCache.set(key, value);
        break;
    }
  }

  get(key: string): string | undefined {
    return this._globalCache.get(key) ?? this._sessionCache.get(key);
  }

  has(key: string): boolean {
    return this._globalCache.has(key) || this._sessionCache.has(key);
  }

  // ─── Invalidation ──────────────────────────────────────────

  /** Clear static zone cache (app update, version bump) */
  invalidateGlobal(): void {
    this._globalCache.clear();
  }

  /** Clear all caches for a given agent */
  invalidateAgent(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const key of this._sessionCache.keys()) {
      // Exact agentId match — verify the key's agent segment equals agentId
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (!rest.includes(':')) continue; // malformed key, skip
        this._sessionCache.delete(key);
      }
    }
  }

  /** Clear all caches for a given session */
  invalidateSession(sessionId: string): void {
    for (const key of this._sessionCache.keys()) {
      // Split key into agentId:sessionId:sectionName and match sessionId exactly
      const parts = key.split(':');
      if (parts.length >= 2 && parts[1] === sessionId) {
        this._sessionCache.delete(key);
      }
    }
  }

  /** Nuke everything */
  invalidateAll(): void {
    this._globalCache.clear();
    this._sessionCache.clear();
  }

  // ─── Conditional invalidation ───────────────────────────────

  /** Clear memory section for a specific agent */
  onMemoryWritten(agentId: string): void {
    const prefix = `${agentId}:`;
    const suffix = ':Memory';
    for (const key of this._sessionCache.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        this._sessionCache.delete(key);
      }
    }
  }

  /** Convenience: clear everything for a given agent+session combo */
  onClear(agentId: string, sessionId: string): void {
    const prefix = `${agentId}:${sessionId}:`;
    for (const key of this._sessionCache.keys()) {
      if (key.startsWith(prefix)) {
        this._sessionCache.delete(key);
      }
    }
  }

  /** Number of entries in global cache (for diagnostics) */
  get globalSize(): number {
    return this._globalCache.size;
  }

  /** Number of entries in session cache (for diagnostics) */
  get sessionSize(): number {
    return this._sessionCache.size;
  }
}
