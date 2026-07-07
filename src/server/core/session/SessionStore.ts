// SessionStore — persistence coordinator between SessionManager and JsonlStore
// Handles directory management, recovery on startup, garbage collection
// Part of the AnoClaw v2.0 rewrite: Session system (SA-4)

import { EventEmitter } from 'events';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Dirent } from 'fs';
import { Session } from './Session.js';
import { JsonlStore } from '../../infra/storage/JsonlStore.js';
import { selectRunnableAgent } from '../agent/AgentSelection.js';
import { createLogger } from '../logger.js';
import type {
  SessionNode,
  SessionType,
  SessionStatus,
  SessionMeta,
  JsonlEvent,
} from '../../../shared/types/session.js';
import { FILE_HISTORY_MAX_SNAPSHOTS } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_FILE = 'meta.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prevent path traversal in session IDs */
function sanitise(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

function fallbackAgentId(): string {
  return selectRunnableAgent().agentId || '';
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore extends EventEmitter {
  private static _instance: SessionStore;

  private jsonlStore: JsonlStore;
  private sessionsDir: string = '';
  private _extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null } | null = null;

  setExtensionPoints(extPoints: { get(point: string): ((...args: unknown[]) => unknown) | null }): void {
    this._extPoints = extPoints;
  }

  private constructor() {
    super();
    this.jsonlStore = JsonlStore.getInstance();
  }

  static getInstance(): SessionStore {
    if (!SessionStore._instance) {
      SessionStore._instance = new SessionStore();
    }
    return SessionStore._instance;
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  /**
   * Initialize the store with the sessions directory path.
   * Creates the directory if it does not exist.
   */
  async initialize(sessionsDir: string): Promise<void> {
    this.sessionsDir = path.resolve(sessionsDir);
    await fsp.mkdir(this.sessionsDir, { recursive: true });
    await fsp.mkdir(this.fileHistoryDir(), { recursive: true });
    createLogger('anochat.system').debug('SessionStore initialized', { dir: this.sessionsDir });
  }

  /** Return the root sessions directory */
  getSessionsDir(): string {
    return this.sessionsDir;
  }

  // -----------------------------------------------------------------------
  // Recovery (startup scan)
  // -----------------------------------------------------------------------

  /**
   * Scan the sessions directory and rebuild Session instances from
   * persisted meta.json files. Filters out archived sessions.
   *
   * Repairs partially-written sessions (missing meta.json, empty dirs).
   */
  async recoverSessions(): Promise<Session[]> {
    const sessions: Session[] = [];
    const dir = this.sessionsDir;

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or can't be read — return empty
      return sessions;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionId = sanitise(entry.name);
      const metaPath = path.join(dir, sessionId, META_FILE);

      let node: SessionNode | null = null;

      try {
        const raw = await fsp.readFile(metaPath, 'utf-8');
        node = JSON.parse(raw) as SessionNode;
      } catch {
        // Missing or corrupt meta.json — attempt repair from events
        node = await this.repairMetaFromEvents(sessionId);
      }

      if (!node) {
        // Cannot recover — skip this directory
        continue;
      }

      // Skip archived sessions
      if (node.status === 'Archived') {
        continue;
      }

      const session = new Session(node);
      sessions.push(session);
    }

    this.emit('recoveryComplete', sessions.length);
    createLogger('anochat.system').info('Session recovery complete', { recovered: sessions.length });
    return sessions;
  }

  /**
   * Attempt to reconstruct a SessionNode from stored events when meta.json
   * is missing or corrupt.
   */
  private async repairMetaFromEvents(
    sessionId: string,
  ): Promise<SessionNode | null> {
    try {
      const events = await this.jsonlStore.readEvents(sessionId);
      if (events.length === 0) return null;

      // The first event should be session_created
      const first = events[0];
      if (first.type !== 'session_created') return null;

      // Use timestamps from events
      const lastEvent = events[events.length - 1];
      const lastTimestamp =
        'timestamp' in lastEvent
          ? (lastEvent as { timestamp: string }).timestamp
          : first.timestamp;

      // ── Reconstruct subSessionIds ──
      // Scan 1: check all events for subsession_created events
      const subSessionIds = new Set<string>();
      for (const ev of events) {
        if (ev.type === 'subsession_created' && ev.subSessionId) {
          subSessionIds.add(ev.subSessionId);
        }
      }
      // Scan 2: check sibling sessions whose parentSessionId points to this session
      // (catches sub-sessions whose creation events may no longer be in this session's JSONL)
      try {
        const dirs = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory() || d.name === sanitise(sessionId)) continue;
          try {
            const otherMetaPath = path.join(this.sessionsDir, d.name, META_FILE);
            const raw = await fsp.readFile(otherMetaPath, 'utf-8');
            const other = JSON.parse(raw) as SessionNode;
            if (other.parentSessionId === sessionId) {
              subSessionIds.add(other.sessionId);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* non-critical — directory scan failed */ }

      const node: SessionNode = {
        sessionId,
        parentSessionId: first.parentSessionId,
        level: first.parentSessionId ? 1 : 0,
        agentId: first.agentId || fallbackAgentId(),
        type: (first.parentSessionId ? 'Sub' : 'Main') as SessionType,
        status: 'Idle' as SessionStatus, // Conservative — assume idle
        title: `Recovered session ${sessionId}`,
        workspace: '',
        createdAt: first.timestamp,
        lastActiveAt: lastTimestamp,
        subSessionIds: [...subSessionIds],
        metadata: { repaired: true },
      };

      // Persist the repaired meta
      await this.writeSessionMeta(sessionId, node);

      return node;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Session metadata (meta.json)
  // -----------------------------------------------------------------------

  /** Read session metadata from meta.json */
  async readSessionMeta(sessionId: string): Promise<SessionNode | null> {
    const metaPath = path.join(
      this.sessionsDir,
      sanitise(sessionId),
      META_FILE,
    );
    try {
      const raw = await fsp.readFile(metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Provide defaults for meta.json missing fields (backward compat)
      return {
        sessionId: parsed.sessionId || sessionId,
        parentSessionId: parsed.parentSessionId || null,
        level: parsed.level ?? 0,
        agentId: parsed.agentId || fallbackAgentId(),
        type: parsed.type || 'Main',
        status: parsed.status || 'Active',
        title: parsed.title || 'Untitled',
        workspace: parsed.workspace || '',
        createdAt: parsed.createdAt || new Date().toISOString(),
        lastActiveAt: parsed.lastActiveAt || new Date().toISOString(),
        subSessionIds: parsed.subSessionIds || [],
        metadata: parsed.metadata || {},
      } as SessionNode;
    } catch {
      return null;
    }
  }

  /** Write session metadata to meta.json */
  async writeSessionMeta(
    sessionId: string,
    node: SessionNode,
  ): Promise<void> {
    const dir = path.join(this.sessionsDir, sanitise(sessionId));
    await fsp.mkdir(dir, { recursive: true });
    const metaPath = path.join(dir, META_FILE);
    await fsp.writeFile(metaPath, JSON.stringify(node, null, 2), 'utf-8');
    // Invalidate JsonlStore's cache so next read picks up the updated meta
    this.jsonlStore.invalidateMetaCache(sessionId);
    createLogger('anochat.system').debug('Session meta written', { sid: sessionId });
  }

  /** Update session metadata fields (delegates to JsonlStore) */
  async updateMeta(
    sessionId: string,
    updates: Partial<SessionMeta>,
  ): Promise<void> {
    await this.jsonlStore.updateMeta(sessionId, updates);
    createLogger('anochat.system').debug('Session meta updated', { sid: sessionId, fields: Object.keys(updates) });
  }

  /** Read messageCount from persisted meta (fast — no full history load). */
  async loadMessageCount(sessionId: string): Promise<number> {
    const meta = await this.jsonlStore.getMeta(sessionId);
    return meta.messageCount ?? 0;
  }

  // -----------------------------------------------------------------------
  // Event persistence (delegates to JsonlStore)
  // -----------------------------------------------------------------------

  /** Persist a single event to the session's JSONL transcript */
  async persistEvent(
    sessionId: string,
    event: unknown,
    opts?: { skipMetaUpdate?: boolean },
  ): Promise<void> {
    if (this._extPoints) {
      const override = this._extPoints.get('sessionStore');
      if (override) {
        await override({ action: 'persistEvent', sessionId, event, opts });
        return;
      }
    }
    const dir = path.join(this.sessionsDir, sanitise(sessionId));
    await fsp.mkdir(dir, { recursive: true });

    // Write to JSONL via JsonlStore
    await this.jsonlStore.appendEvent(sessionId, event as JsonlEvent, opts);
    createLogger('anochat.system').debug('Event persisted', { sid: sessionId, type: (event as JsonlEvent).type });
  }

  /** Load all transcript events for a session */
  async loadHistory(sessionId: string): Promise<unknown[]> {
    if (this._extPoints) {
      const override = this._extPoints.get('sessionStore');
      if (override) {
        const result = await override({ action: 'loadHistory', sessionId });
        return (result as { events: unknown[] }).events || [];
      }
    }
    const events = await this.jsonlStore.readEvents(sessionId);
    createLogger('anochat.system').debug('Session history loaded', { sid: sessionId, eventCount: events.length });
    return events;
  }

  /** Delete all shard files for a session (used before rewriting compacted history). */
  async truncateSession(sessionId: string): Promise<void> {
    await this.jsonlStore.truncateSession(sessionId);
  }

  // -----------------------------------------------------------------------
  // Hard delete
  // -----------------------------------------------------------------------

  /**
   * Permanently delete a session directory from disk.
   * Removes the entire session dir and its JSONL shards.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const dir = path.join(this.sessionsDir, sanitise(sessionId));
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      this.jsonlStore.dropSession(sessionId);
      createLogger('anochat.system').info('Session deleted from disk', { sid: sessionId });
    } catch {
      // Directory may not exist — that's fine
    }
  }

  /**
   * Permanently delete all sessions from disk.
   * Clears the entire sessions directory.
   */
  async deleteAllSessions(): Promise<number> {
    let count = 0;
    const dir = this.sessionsDir;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await fsp.rm(path.join(dir, entry.name), { recursive: true, force: true });
      count++;
    }
    createLogger('anochat.system').info('All sessions deleted', { count });
    return count;
  }

  // -----------------------------------------------------------------------
  // Archive / garbage collection
  // -----------------------------------------------------------------------

  /**
   * Archive a session: gzip-compress old shards and update meta.json
   * to status "Archived".
   */
  async archiveSession(sessionId: string): Promise<void> {
    const meta = await this.readSessionMeta(sessionId);
    if (meta) {
      meta.status = 'Archived' as SessionStatus;
      meta.lastActiveAt = new Date().toISOString();
      await this.writeSessionMeta(sessionId, meta);
    }

    // Let JsonlStore handle shard compression
    await this.jsonlStore.archiveSession(sessionId);

    // Prune old file history snapshots
    await this.pruneFileHistory(sessionId);

    createLogger('anochat.system').info('Session archived', { sid: sessionId });
  }

  /**
   * Run garbage collection: mark sessions idle > 90 days for archival,
   * compress old shards.
   */
  async garbageCollect(): Promise<number> {
    let archived = 0;
    const dir = this.sessionsDir;

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return archived;
    }

    const now = Date.now();
    const threshold = 90 * 24 * 60 * 60 * 1000; // 90 days

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionId = sanitise(entry.name);
      const meta = await this.readSessionMeta(sessionId);
      if (!meta || meta.status === 'Archived') continue;

      const lastActive = new Date(meta.lastActiveAt).getTime();
      if (now - lastActive > threshold) {
        await this.archiveSession(sessionId);
        archived++;
      }
    }

    createLogger('anochat.system').info('Garbage collection complete', { archived });
    return archived;
  }

  // -----------------------------------------------------------------------
  // File history (backups directory management)
  // -----------------------------------------------------------------------

  /** Get the file history root directory */
  private fileHistoryDir(): string {
    return path.join(this.sessionsDir, '_file-history');
  }

  /** Get the file history directory for a specific session */
  getSessionFileHistoryDir(sessionId: string): string {
    return path.join(this.fileHistoryDir(), sanitise(sessionId));
  }

  /** Ensure the file history directory for a session exists */
  async ensureFileHistoryDir(sessionId: string): Promise<string> {
    const dir = this.getSessionFileHistoryDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    createLogger('anochat.system').debug('File history dir ensured', { sid: sessionId });
    return dir;
  }

  /** Get the max snapshots per session */
  getMaxSnapshots(): number {
    return FILE_HISTORY_MAX_SNAPSHOTS;
  }

  /** Clean up old file history snapshots beyond the limit */
  async pruneFileHistory(sessionId: string): Promise<number> {
    const dir = this.getSessionFileHistoryDir(sessionId);
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }

    const files = entries
      .filter((e) => e.isFile())
      .map((e) => ({
        name: e.name,
        // Parse version from filename pattern: {hash}@v{version}
        version: parseInt(e.name.split('@v')[1] ?? '0', 10) || 0,
      }))
      .sort((a, b) => b.version - a.version); // Newest first

    const max = this.getMaxSnapshots();
    let pruned = 0;

    // Files beyond the limit, grouped by file hash
    const keep = new Set<string>();
    const byHash = new Map<string, typeof files>();

    for (const f of files) {
      const hash = f.name.split('@v')[0];
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash)!.push(f);
    }

    // For each file hash, keep only the most recent MAX_SNAPSHOTS versions
    // TODO: implement per-file max snapshot pruning (for now, simple total pruning)

    // Simple approach: if total files exceed 2 * MAX_SNAPSHOTS, prune oldest
    if (files.length > max * 2) {
      const toDelete = files.slice(max * 2);
      for (const f of toDelete) {
        try {
          await fsp.unlink(path.join(dir, f.name));
          pruned++;
        } catch {
          // Skip files that can't be deleted
        }
      }
    }

    createLogger('anochat.system').debug('File history pruned', { sid: sessionId, pruned });
    return pruned;
  }
}
