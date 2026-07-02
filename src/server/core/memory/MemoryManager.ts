// MemoryManager.ts — Singleton memory manager
// Manages read/write/search of persistent agent and team memories
// Auto-extracts facts from conversation messages
// Integrates with PromptAssembler for cache invalidation

import { EventEmitter } from 'events';
import * as path from 'path';
import { PATHS } from '../../../shared/constants.js';
import { MemoryScope, MemoryType, parseScopeParameter, mapType, defaultCategory } from './MemoryEntry.js';
import type { MemoryEntry } from './MemoryEntry.js';
import {
  saveMemory,
  removeMemory,
  loadIndex,
  loadAllMemoryFiles,
  parseIndexLinks,
} from './MemoryStore.js';
import { createLogger } from '../logger.js';
import { TypedEventBus } from '../events/TypedEventBus.js';

const log = createLogger('anochat.memory');

/** Patterns for auto-extracting facts from agent messages */
const AUTO_EXTRACT_PATTERNS: Array<{ regex: RegExp; type: MemoryType; prefix: string }> = [
  { regex: /remember[：:]\s*(.+?)(?:[.\n]|$)/i, type: MemoryType.Feedback, prefix: 'Remember:' },
  { regex: /learned[：:]\s*(.+?)(?:[.\n]|$)/i, type: MemoryType.Reference, prefix: 'Learned:' },
  { regex: /decided[：:]\s*(.+?)(?:[.\n]|$)/i, type: MemoryType.Project, prefix: 'Decided:' },
  { regex: /know(?: that)?[：:]\s*(.+?)(?:[.\n]|$)/i, type: MemoryType.User, prefix: 'Know that:' },
];

export class MemoryManager extends EventEmitter {
  private static _instance: MemoryManager;

  static getInstance(): MemoryManager {
    if (!this._instance) {
      this._instance = new MemoryManager();
    }
    return this._instance;
  }

  /** Base memory directory (resolved from PATHS.memory) */
  private get _baseDir(): string {
    return path.resolve(process.cwd(), PATHS.memory);
  }

  /** Synchronous cache populated by search/load — for PromptAssembler.
   * Capped at 50 entries to prevent unbounded growth from old sessions. */
  private _recentCache: Map<string, MemoryEntry[]> = new Map();
  private static readonly _MAX_CACHE_ENTRIES = 50;

  /** ExtensionPoints registry — injected by PluginHostManager for plugin memoryStore override */
  private _extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null } | null = null;

  /** Inject ExtensionPoints for plugin memory store overrides */
  setExtensionPoints(extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null }): void {
    this._extPoints = extPoints;
  }

  private constructor() {
    super();
  }

  /** Synchronously return recently loaded memories for prompt injection. */
  getRecentMemories(scope: string, targetId: string, limit = 5): MemoryEntry[] {
    const cacheKey = scope === 'team' ? 'team:team' : `${scope}:${targetId}`;
    const entries = this._recentCache.get(cacheKey) || [];
    return entries.slice(0, limit);
  }

  // ─── Search ──────────────────────────────────────────────────

  /**
   * Search memories by query string within a given scope.
   * Matches against name, description, and content (case-insensitive).
   *
   * @param agentId    The agent performing the search
   * @param scope      Which memory scope to search
   * @param query      Search query (empty = return all entries)
   * @param sessionId  Session ID (required for Session scope)
   * @param subScope   Sub-scope for session memories ('team' or 'personal')
   * @returns          Matching MemoryEntry objects
   */
  async search(
    agentId: string,
    scope: MemoryScope,
    query: string,
    sessionId?: string,
    subScope?: 'team' | 'personal',
    fuzzy = true,
  ): Promise<MemoryEntry[]> {
    if (scope === MemoryScope.Session && !sessionId) return [];

    let targetId: string;
    if (scope === MemoryScope.Team) { targetId = 'team'; }
    else if (scope === MemoryScope.Session) { targetId = sessionId || path.basename(agentId); }
    else { targetId = path.basename(agentId); }

    // Primary: search SQLite database
    let entries = await this._searchV2(scope, targetId, query, sessionId, subScope);

    // Fall back to filesystem ONLY if DB is genuinely unavailable (not just empty)
    if (entries.length === 0) {
      let dbAvailable = false;
      try {
        const { MemoryDatabase } = await import('./storage/MemoryDatabase.js');
        dbAvailable = MemoryDatabase.getInstance().isReady;
      } catch { /* ignore */ }

      if (!dbAvailable) {
        entries = await loadAllMemoryFiles(scope, targetId, sessionId, subScope);
        // Migrate filesystem memories to DB for future use
        this._migrateToDatabase(scope, targetId, sessionId, subScope).catch(() => {});
      }
    }

    // Apply query scoring when needed
    if (query && entries.length > 0) {
      try {
        const { scoreEntries } = await import('./MemorySearchScorer.js');
        return (await scoreEntries(entries, query, { fuzzy, threshold: 0.15 })).map(r => r.entry);
      } catch {
        const q = query.toLowerCase();
        return entries.filter(e => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.content.toLowerCase().includes(q));
      }
    }

    // Populate synchronous cache
    const cacheKey = scope === MemoryScope.Team ? 'team:team'
      : scope === MemoryScope.Session ? `session:${sessionId || 'unknown'}` : `${scope}:${agentId}`;
    const existing = this._recentCache.get(cacheKey) || [];
    const merged = new Map<string, MemoryEntry>();
    for (const e of [...existing, ...entries]) merged.set(e.name, e);
    const maxEntries = scope === MemoryScope.Session ? 20 : 50;
    this._recentCache.set(cacheKey, [...merged.values()].slice(0, maxEntries));
    while (this._recentCache.size > MemoryManager._MAX_CACHE_ENTRIES) {
      const oldest = this._recentCache.keys().next().value as string;
      if (oldest) this._recentCache.delete(oldest);
    }
    // Emit event for StatsCollector to track memory retrieval
    try {
      TypedEventBus.emit('memory:retrieved', {
        agentId,
        scope: String(scope),
        query,
        memoryNames: entries.map(e => e.name),
      });
    } catch { /* non-critical */ }

    return entries.slice(0, 100);
  }

  /** Try MemoryDatabase v2. Returns [] if not available, letting caller fall back to filesystem. */
  private async _searchV2(
    scope: MemoryScope, targetId: string, query: string,
    sessionId?: string, subScope?: 'team' | 'personal',
  ): Promise<MemoryEntry[]> {
    try {
      const { MemoryDatabase } = await import('./storage/MemoryDatabase.js');
      const db = MemoryDatabase.getInstance();
      if (!db.isReady) return [];

      // Map MemoryScope to scope string
      const scopeStr = scope === MemoryScope.Team ? 'team' : scope === MemoryScope.Session ? 'session' : 'agent';
      const scopeId = scope === MemoryScope.Session ? (sessionId || targetId) : targetId;

      const docs = await db.getAllDocuments({ scope: scopeStr, scopeId });
      const entries = docs.map(d => ({
        name: d.id,
        type: mapType(d.memoryType),
        description: d.content.slice(0, 100),
        content: d.content,
        scope,
        updatedAt: new Date(d.updatedAt).getTime(),
      }));

      if (query) {
        const { scoreEntries } = await import('./MemorySearchScorer.js');
        return (await scoreEntries(entries as any, query, { threshold: 0.1 })).map(r => r.entry);
      }

      return entries;
    } catch { /* MemoryDatabase unavailable — caller falls back to filesystem */ }
    return [];
  }

  /**
   * Search across all scopes (team + personal).
   */
  async searchAll(agentId: string, query: string): Promise<MemoryEntry[]> {
    const teamEntries = await this.search(agentId, MemoryScope.Team, query);
    const agentEntries = await this.search(agentId, MemoryScope.Agent, query);
    return [...teamEntries, ...agentEntries];
  }

  /**
   * Search across all scopes (team, agent, and session).
   *
   * @param agentId    The agent performing the search
   * @param query      Search query (empty = return all entries)
   * @param sessionId  Session ID to include session-scoped memories
   * @returns          Matching MemoryEntry objects from all scopes
   */
  async searchAllScopes(
    agentId: string,
    query: string,
    sessionId?: string,
  ): Promise<MemoryEntry[]> {
    const teamEntries = await this.search(agentId, MemoryScope.Team, query);
    const agentEntries = await this.search(agentId, MemoryScope.Agent, query);
    let sessionEntries: MemoryEntry[] = [];
    if (sessionId) {
      const personalEntries = await this.search(agentId, MemoryScope.Session, query, sessionId, 'personal');
      const teamSessionEntries = await this.search(agentId, MemoryScope.Session, query, sessionId, 'team');
      sessionEntries = [...personalEntries, ...teamSessionEntries];
    }
    return [...teamEntries, ...agentEntries, ...sessionEntries];
  }

  // ─── Save ────────────────────────────────────────────────────

  /**
   * Save a memory entry. Writes the .md file and updates the MEMORY.md index.
   *
   * @param agentId    The agent owning this memory
   * @param scope      Where to save (team, agent, or session)
   * @param entry      The memory content to persist
   * @param sessionId  Session ID (required for Session scope)
   */
  async save(
    agentId: string,
    scope: MemoryScope,
    entry: MemoryEntry,
    sessionId?: string,
  ): Promise<void> {
    // Check for plugin override via ExtensionPoints
    if (this._extPoints) {
      const pluginOverride = this._extPoints.get('memoryStore');
      if (pluginOverride) {
        // Delegate to plugin handler: it receives a {save, entry, scope, agentId, sessionId} object
        try {
          await pluginOverride({ action: 'save', entry, scope, agentId, sessionId, manager: this });
          return;
        } catch (err) {
          throw err; // Plugin override handles errors itself
        }
      }
    }

    // B1: Session scope requires sessionId
    if (scope === MemoryScope.Session && !sessionId) {
      throw new Error('sessionId is required for MemoryScope.Session');
    }

    // B10: Create new object instead of mutating the passed-in entry
    const savedEntry: MemoryEntry = { ...entry, scope };
    if (sessionId) savedEntry.sessionId = sessionId;

    let handledByPlugin = false;
    if (this._extPoints) {
      const pluginOverride = this._extPoints.get('memoryStore');
      if (pluginOverride) {
        try {
          await pluginOverride({ action: 'save', entry: savedEntry, scope, agentId, sessionId, manager: this });
          handledByPlugin = true;
        } catch (err) {
          throw err;
        }
      }
    }

    if (!handledByPlugin) {
      let targetId: string;
      if (scope === MemoryScope.Team) { targetId = 'team'; }
      else if (scope === MemoryScope.Session) { targetId = sessionId || path.basename(agentId); }
      else { targetId = path.basename(agentId); }

      // Primary: write to SQLite database
      try {
        await this._saveToDatabaseSync(savedEntry, targetId);
      } catch (err) {
        log.warn('MemoryDatabase save failed, falling back to filesystem', { error: (err as Error).message });
      }

      // Backup: write to filesystem (fire-and-forget, don't error if it fails)
      saveMemory(savedEntry, targetId, sessionId).catch(() => { /* non-critical */ });
    }

    // Invalidate the prompt cache for this agent (Memory section)
    try {
      const { PromptAssembler } = await import('../prompt/PromptAssembler.js');
      PromptAssembler.getInstance().onMemoryWritten(agentId);
    } catch {
      // B6: Log the error instead of swallowing silently
      console.warn('[MemoryManager] PromptAssembler not available for cache invalidation');
    }

    this.emit('memorySaved', agentId, scope, savedEntry.name);
  }

  /**
   * Save a memory from raw tool parameters (used by MemorySaveTool).
   */
  async saveFromParams(
    agentId: string,
    params: {
      scope: string;
      type: string;
      name: string;
      content: string;
      description?: string;
    },
  ): Promise<MemoryEntry> {
    const { scope: memScope, agentId: targetId, sessionId, subScope } = parseScopeParameter(
      params.scope,
      agentId,
    );

    // Map type string to MemoryType enum
    const type = mapType(params.type);

    // B3: Validate name is non-empty before saving
    if (!params.name || !params.name.trim()) {
      throw new Error('Memory name must not be empty');
    }

    const entry: MemoryEntry = {
      name: sanitizeName(params.name),
      type,
      description: params.description || params.name,
      content: params.content,
      scope: memScope,
      sessionId,
      subScope,
    };

    await this.save(targetId, memScope, entry, sessionId);
    return entry;
  }

  // ─── Remove ──────────────────────────────────────────────────

  /**
   * Remove a memory entry by name from the given scope.
   *
   * @returns true if the memory was found and removed, false otherwise
   */
  async remove(
    agentId: string,
    scope: MemoryScope,
    name: string,
    sessionId?: string,
    subScope?: 'team' | 'personal',
  ): Promise<boolean> {
    // B1: Session scope requires sessionId
    if (scope === MemoryScope.Session && !sessionId) {
      throw new Error('sessionId is required for MemoryScope.Session');
    }

    let targetId: string;
    if (scope === MemoryScope.Team) {
      targetId = 'team';
    } else if (scope === MemoryScope.Session) {
      targetId = sessionId || path.basename(agentId);
    } else {
      targetId = path.basename(agentId);
    }
    const deleted = await removeMemory(scope, targetId, name, sessionId, subScope);

    // Also delete from SQLite database
    try {
      const { MemoryDatabase } = await import('./storage/MemoryDatabase.js');
      const db = MemoryDatabase.getInstance();
      if (db.isReady) {
        const docId = `${scope}:${targetId}:${name}`;
        await db.deleteDocument(docId);
      }
    } catch { /* DB deletion is best-effort */ }

    if (deleted) {
      // Invalidate the prompt cache
      try {
        const { PromptAssembler } = await import('../prompt/PromptAssembler.js');
        PromptAssembler.getInstance().onMemoryWritten(agentId);
      } catch {
        // B6: Log the error instead of swallowing silently
        console.warn('[MemoryManager] PromptAssembler not available for cache invalidation');
      }

      this.emit('memoryRemoved', agentId, scope, name);
    }

    return deleted;
  }

  // ─── Index ───────────────────────────────────────────────────

  /**
   * Load the MEMORY.md index content for a given scope.
   * Creates a default index file if none exists.
   */
  async loadIndexContent(
    agentId: string,
    scope: MemoryScope,
    agentName?: string,
    sessionId?: string,
    subScope?: 'team' | 'personal',
  ): Promise<string> {
    let targetId: string;
    if (scope === MemoryScope.Team) {
      targetId = 'team';
    } else if (scope === MemoryScope.Session) {
      targetId = sessionId || path.basename(agentId);
    } else {
      targetId = path.basename(agentId);
    }
    return loadIndex(scope, targetId, agentName, sessionId, subScope);
  }

  /**
   * Parse the index into structured link entries.
   */
  async loadIndexLinks(
    agentId: string,
    scope: MemoryScope,
    sessionId?: string,
  ): Promise<Array<{ name: string; file: string; description: string }>> {
    const content = await this.loadIndexContent(agentId, scope, undefined, sessionId);
    return parseIndexLinks(content);
  }

  // ─── Auto-Extraction ─────────────────────────────────────────

  /**
   * Scan recent messages for patterns like "remember: X", "learned: X",
   * "decided: X", "know that: X" and auto-save them as memories.
   *
   * @param agentId   The agent whose conversation is being analyzed
   * @param messages  Recent messages from the conversation
   * @returns         Number of facts auto-extracted and saved
   */
  async autoExtract(
    agentId: string,
    messages: Array<{ role: string; content: string | unknown }>,
  ): Promise<number> {
    if (!messages || messages.length === 0) return 0;

    // Load existing memories once before scanning messages
    const existing = await this.search(agentId, MemoryScope.Agent, '');
    const existingLower = existing.map((e) =>
      (e.content + e.description).toLowerCase(),
    );

    let extracted = 0;

    for (const msg of messages) {
      // Only scan assistant messages
      if (msg.role !== 'assistant') continue;

      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ text?: string }>)
              .map((c) => c.text || '')
              .join(' ')
          : String(msg.content);

      if (!text) continue;

      for (const pattern of AUTO_EXTRACT_PATTERNS) {
        const match = text.match(pattern.regex);
        if (match) {
          const fact = match[1].trim().slice(0, 200);
          if (fact.length < 5) continue;

          // Check for duplicates against existing memories
          const existingLower = existing.map((e) =>
            (e.content + e.description).toLowerCase(),
          );

          const factLower = fact.toLowerCase();
          const tooSimilar = existingLower.some((e) => {
            const factWords = new Set(factLower.split(/\s+/));
            const eWords = new Set(e.split(/\s+/));
            if (factWords.size === 0 || eWords.size === 0) return false;
            const intersection = [...factWords].filter((w) => eWords.has(w)).length;
            return intersection / Math.min(factWords.size, eWords.size) > 0.7;
          });

          if (tooSimilar) continue;

          const entry: MemoryEntry = {
            name: sanitizeName(`${pattern.prefix.toLowerCase().replace(/[:\s]/g, '-')}-${fact.slice(0, 40).replace(/\s+/g, '-')}`),
            type: pattern.type,
            description: `${pattern.prefix} ${fact.slice(0, 100)}`,
            content: `${pattern.prefix} ${fact}`,
            scope: MemoryScope.Agent,
          };

          await this.save(agentId, MemoryScope.Agent, entry);
          extracted++;
          break; // One extraction per message
        }
      }
    }

    return extracted;
  }
  /** Write to MemoryDatabase v2 with embedding. Awaited — caller handles errors. */
  private async _saveToDatabaseSync(entry: MemoryEntry, targetId: string): Promise<void> {
    const [{ MemoryDatabase }] = await Promise.all([
      import('./storage/MemoryDatabase.js'),
    ]);
    const db = MemoryDatabase.getInstance();
    if (!db.isReady) return;
    const id = `${entry.scope}:${targetId}:${entry.name}`;
    await db.insertDocument({
      id, content: entry.content, memoryType: entry.type,
      scope: entry.scope, scopeId: targetId, tags: [], metadata: {},
      category: entry.category || defaultCategory(entry.type),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      accessCount: 0, lastAccessedAt: undefined, importance: 0.5,
    } as any);
    // Generate embedding asynchronously (fire-and-forget)
    this._embedDocument(id, entry.content).catch(() => { /* embedding optional */ });
  }

  /** Fire-and-forget embedding generation for a document. */
  private async _embedDocument(id: string, content: string): Promise<void> {
    try {
      const [{ MemoryDatabase }, { EmbeddingService }] = await Promise.all([
        import('./storage/MemoryDatabase.js'),
        import('./embedding/EmbeddingService.js'),
      ]);
      const db = MemoryDatabase.getInstance();
      const es = EmbeddingService.getInstance();
      if (db.isReady && es.isReady()) {
        const vec = await es.embed(content);
        await db.upsertEmbedding(id, vec, 'all-MiniLM-L6-v2');
      }
    } catch { /* embedding is optional, not critical */ }
  }

  /** One-time migration: import filesystem memories into SQLite. */
  private async _migrateToDatabase(
    scope: MemoryScope, targetId: string,
    sessionId?: string, subScope?: 'team' | 'personal',
  ): Promise<void> {
    try {
      const [{ MemoryDatabase }] = await Promise.all([
        import('./storage/MemoryDatabase.js'),
      ]);
      const db = MemoryDatabase.getInstance();
      if (!db.isReady) return;

      const filesystemEntries = await loadAllMemoryFiles(scope, targetId, sessionId, subScope);
      if (!filesystemEntries.length) return;

      let migrated = 0;
      for (const entry of filesystemEntries) {
        const id = `${entry.scope}:${targetId}:${entry.name}`;
        // Check if already in DB before inserting
        const existing = await db.getDocument(id);
        if (existing) continue;

        await db.insertDocument({
          id,
          content: entry.content,
          memoryType: entry.type,
          scope: entry.scope,
          scopeId: targetId,
          category: entry.category || defaultCategory(entry.type),
          tags: [],
          metadata: {},
          createdAt: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any);
        migrated++;
      }

      if (migrated > 0) {
        log.info('Migrated filesystem memories to database', {
          scope, targetId, migrated, total: filesystemEntries.length,
        });
      }
    } catch (err) {
      log.warn('Memory migration failed (non-critical)', { error: (err as Error).message });
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Sanitize a filename-safe name — preserves Unicode (Chinese, Japanese, etc.) */
function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-]+|[-]+$/g, '')
    .slice(0, 80);
  return sanitized || `untitled-${Date.now().toString(36)}`;
}
