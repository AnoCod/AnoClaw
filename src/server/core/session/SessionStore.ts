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
  PersistedSessionMeta,
  TokenBreakdown,
  JsonlEvent,
} from '../../../shared/types/session.js';
import { DEFAULT_CONTEXT_WINDOW, FILE_HISTORY_MAX_SNAPSHOTS } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_FILE = 'meta.json';
const META_SCHEMA_VERSION = 1;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_.-]+$/;

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

function defaultTokenBreakdown(): TokenBreakdown {
  return {
    systemPrompt: 0,
    systemTools: 0,
    skills: 0,
    messages: 0,
    freeSpace: DEFAULT_CONTEXT_WINDOW,
    total: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePersistedMeta(
  raw: unknown,
  expectedSessionId: string,
): PersistedSessionMeta | null {
  if (!isRecord(raw) || raw.sessionId !== expectedSessionId) return null;
  if (raw.type !== 'Main' && raw.type !== 'Sub') return null;
  if (!['Active', 'Idle', 'Archived'].includes(String(raw.status))) return null;
  if (typeof raw.title !== 'string' || typeof raw.workspace !== 'string') return null;
  if (typeof raw.createdAt !== 'string' || typeof raw.lastActiveAt !== 'string') return null;
  if (!Array.isArray(raw.subSessionIds) || !raw.subSessionIds.every((id) => typeof id === 'string')) return null;
  if (!isRecord(raw.metadata)) return null;
  if (!(raw.parentSessionId === null || typeof raw.parentSessionId === 'string')) return null;
  if (!Number.isInteger(raw.level) || Number(raw.level) < 0) return null;

  const tokenBreakdown = isRecord(raw.tokenBreakdown)
    ? raw.tokenBreakdown as unknown as TokenBreakdown
    : defaultTokenBreakdown();
  return {
    schemaVersion: META_SCHEMA_VERSION,
    sessionId: expectedSessionId,
    parentSessionId: raw.parentSessionId as string | null,
    level: Number(raw.level),
    agentId: typeof raw.agentId === 'string' && raw.agentId ? raw.agentId : fallbackAgentId(),
    type: raw.type as SessionType,
    status: raw.status as SessionStatus,
    title: raw.title,
    workspace: raw.workspace,
    createdAt: raw.createdAt,
    lastActiveAt: raw.lastActiveAt,
    subSessionIds: [...raw.subSessionIds] as string[],
    metadata: { ...raw.metadata },
    messageCount: Math.max(0, Number(raw.messageCount) || 0),
    eventCount: Math.max(0, Number(raw.eventCount) || 0),
    headEventUuid: typeof raw.headEventUuid === 'string' ? raw.headEventUuid : null,
    tokenBreakdown,
  };
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore extends EventEmitter {
  private static _instance: SessionStore;

  private jsonlStore: JsonlStore;
  private sessionsDir: string = '';
  private recoveryQuarantineDir: string = '';
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

  /** Test/restart hook. Call only after draining pending writes. */
  static resetInstance(): void {
    SessionStore._instance = undefined as unknown as SessionStore;
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
    await this.jsonlStore.initialize(this.sessionsDir);
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
   * persisted meta.json files. Invalid bytes are quarantined for manual
   * inspection; recovery never fabricates lifecycle metadata.
   */
  async recoverSessions(): Promise<Session[]> {
    const dir = this.sessionsDir;
    this.recoveryQuarantineDir = path.join(
      this.sessionsDir,
      '_quarantine',
      new Date().toISOString().replace(/[:.]/g, '-'),
    );
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or can't be read — return empty
      return [];
    }

    const recoveredMeta = new Map<string, PersistedSessionMeta>();
    let quarantinedCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      if (!SAFE_SESSION_ID.test(entry.name) || entry.name === '.' || entry.name === '..') {
        await this.quarantineSession(entry.name, 'unsafe_session_directory');
        quarantinedCount += 1;
        continue;
      }

      const sessionId = entry.name;
      const meta = await this.readPersistedSessionMeta(sessionId);
      if (!meta) {
        await this.quarantineSession(sessionId, 'invalid_or_incomplete_meta');
        quarantinedCount += 1;
        continue;
      }

      try {
        const transcript = await this.jsonlStore.recoverSession(sessionId);
        meta.headEventUuid = transcript.headEventUuid;
        meta.eventCount = transcript.eventCount;
        meta.messageCount = transcript.messageCount;
        recoveredMeta.set(sessionId, meta);
      } catch (error) {
        await this.quarantineSession(
          sessionId,
          `transcript_corruption:${(error as Error).message}`,
        );
        quarantinedCount += 1;
      }
    }

    // Validate and rebuild the session tree from child parentSessionId fields.
    const invalidGraph = new Map<string, string>();
    for (const meta of recoveredMeta.values()) {
      if (meta.type === 'Main' && meta.parentSessionId !== null) {
        invalidGraph.set(meta.sessionId, 'main_session_has_parent');
      } else if (meta.type === 'Sub') {
        if (!meta.parentSessionId || !recoveredMeta.has(meta.parentSessionId)) {
          invalidGraph.set(meta.sessionId, 'subsession_parent_missing');
        }
      }
    }

    const resolving = new Set<string>();
    const resolved = new Set<string>();
    const resolveLevel = (sessionId: string): number | null => {
      if (invalidGraph.has(sessionId)) return null;
      const meta = recoveredMeta.get(sessionId);
      if (!meta) return null;
      if (resolved.has(sessionId)) return meta.level;
      if (resolving.has(sessionId)) {
        invalidGraph.set(sessionId, 'session_parent_cycle');
        return null;
      }
      resolving.add(sessionId);
      if (meta.parentSessionId === null) {
        meta.level = 0;
      } else {
        const parentLevel = resolveLevel(meta.parentSessionId);
        if (parentLevel === null) {
          invalidGraph.set(sessionId, 'invalid_parent_chain');
          resolving.delete(sessionId);
          return null;
        }
        meta.level = parentLevel + 1;
      }
      resolving.delete(sessionId);
      resolved.add(sessionId);
      return meta.level;
    };
    for (const sessionId of recoveredMeta.keys()) resolveLevel(sessionId);

    for (const [sessionId, reason] of invalidGraph) {
      recoveredMeta.delete(sessionId);
      await this.quarantineSession(sessionId, reason);
      quarantinedCount += 1;
    }

    const children = new Map<string, string[]>();
    for (const meta of recoveredMeta.values()) {
      if (!meta.parentSessionId) continue;
      const list = children.get(meta.parentSessionId) || [];
      list.push(meta.sessionId);
      children.set(meta.parentSessionId, list);
    }

    const sessions: Session[] = [];
    for (const meta of recoveredMeta.values()) {
      meta.subSessionIds = [...(children.get(meta.sessionId) || [])].sort();
      await this.jsonlStore.mergeMetaDocument(
        meta.sessionId,
        meta as unknown as Record<string, unknown>,
        path.join(this.sessionsDir, meta.sessionId, META_FILE),
      );
      if (meta.status === 'Archived') continue;
      const session = new Session(meta);
      session.lastEventUuid = meta.headEventUuid;
      sessions.push(session);
    }

    this.emit('recoveryComplete', sessions.length);
    createLogger('anochat.system').info('Session recovery complete', {
      recovered: sessions.length,
      quarantined: quarantinedCount,
    });
    return sessions;
  }

  /** Preserve invalid session bytes outside the active scan instead of deleting them. */
  private async quarantineSession(sessionId: string, reason: string): Promise<void> {
    const source = path.join(this.sessionsDir, sessionId);
    try {
      const stat = await fsp.stat(source);
      if (!stat.isDirectory()) return;
    } catch {
      return;
    }

    const quarantineRoot = this.recoveryQuarantineDir || path.join(
      this.sessionsDir,
      '_quarantine',
      new Date().toISOString().replace(/[:.]/g, '-'),
    );
    await fsp.mkdir(quarantineRoot, { recursive: true });
    let destination = path.join(quarantineRoot, sanitise(sessionId));
    try {
      await fsp.rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      destination = `${destination}-${Math.random().toString(36).slice(2, 8)}`;
      await fsp.rename(source, destination);
    }

    const auditPath = path.join(this.sessionsDir, '_quarantine', 'audit.jsonl');
    const auditLine = `${JSON.stringify({
      sessionId,
      reason,
      source,
      destination,
      quarantinedAt: new Date().toISOString(),
    })}\n`;
    const handle = await fsp.open(auditPath, 'a');
    try {
      await handle.writeFile(auditLine, { encoding: 'utf-8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.jsonlStore.dropSession(sessionId);
    createLogger('anochat.system').warn('Session quarantined during recovery', {
      sid: sessionId,
      reason,
      destination,
    });
  }

  // -----------------------------------------------------------------------
  // Session metadata (meta.json)
  // -----------------------------------------------------------------------

  /** Read session metadata from meta.json */
  async readSessionMeta(sessionId: string): Promise<SessionNode | null> {
    const meta = await this.readPersistedSessionMeta(sessionId);
    if (!meta) return null;
    return {
      sessionId: meta.sessionId,
      parentSessionId: meta.parentSessionId,
      level: meta.level,
      agentId: meta.agentId,
      type: meta.type,
      status: meta.status,
      title: meta.title,
      workspace: meta.workspace,
      createdAt: meta.createdAt,
      lastActiveAt: meta.lastActiveAt,
      subSessionIds: [...meta.subSessionIds],
      metadata: { ...meta.metadata },
    };
  }

  private async readPersistedSessionMeta(sessionId: string): Promise<PersistedSessionMeta | null> {
    if (!SAFE_SESSION_ID.test(sessionId)) return null;
    const metaPath = path.join(this.sessionsDir, sessionId, META_FILE);
    for (const candidate of [metaPath, `${metaPath}.bak`]) {
      try {
        const parsed = JSON.parse(await fsp.readFile(candidate, 'utf-8'));
        const normalized = normalizePersistedMeta(parsed, sessionId);
        if (normalized) return normalized;
      } catch {
        // Try the backup before declaring the session invalid.
      }
    }
    return null;
  }

  /** Write session metadata to meta.json */
  async writeSessionMeta(
    sessionId: string,
    node: SessionNode,
  ): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
    const current = await this.jsonlStore.getMeta(sessionId);
    await this.jsonlStore.mergeMetaDocument(
      sessionId,
      {
        schemaVersion: META_SCHEMA_VERSION,
        messageCount: Math.max(0, Number(current.messageCount) || 0),
        eventCount: Math.max(0, Number(current.eventCount) || 0),
        headEventUuid: current.headEventUuid ?? await this.jsonlStore.getHeadEventUuid(sessionId),
        tokenBreakdown: current.tokenBreakdown || defaultTokenBreakdown(),
        ...(node as unknown as Record<string, unknown>),
      },
      path.join(this.sessionsDir, sessionId, META_FILE),
    );
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

  async incrementMessageCount(sessionId: string): Promise<void> {
    await this.jsonlStore.incrementMetaMessageCount(sessionId);
  }

  // -----------------------------------------------------------------------
  // Event persistence (delegates to JsonlStore)
  // -----------------------------------------------------------------------

  /** Persist a single event to the session's JSONL transcript */
  async persistEvent(
    sessionId: string,
    event: unknown,
    opts?: { skipMetaUpdate?: boolean; messageDelta?: number; sync?: boolean },
  ): Promise<string | null> {
    if (this._extPoints) {
      const override = this._extPoints.get('sessionStore');
      if (override) {
        const result = await override({ action: 'persistEvent', sessionId, event, opts });
        return isRecord(result) && typeof result.headEventUuid === 'string'
          ? result.headEventUuid
          : null;
      }
    }
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
    const dir = path.join(this.sessionsDir, sessionId);
    await fsp.mkdir(dir, { recursive: true });

    // Write to JSONL via JsonlStore
    const head = await this.jsonlStore.appendEvent(sessionId, event as JsonlEvent, opts);
    createLogger('anochat.system').debug('Event persisted', { sid: sessionId, type: (event as JsonlEvent).type });
    return head;
  }

  async appendEvents(
    sessionId: string,
    events: JsonlEvent[],
    opts: { messageDelta?: number; sync?: boolean } = {},
  ): Promise<string | null> {
    if (this._extPoints) {
      const override = this._extPoints.get('sessionStore');
      if (override) {
        let head: string | null = null;
        for (const event of events) {
          const result = await override({
            action: 'persistEvent',
            sessionId,
            event,
            opts: { ...opts, skipMetaUpdate: opts.messageDelta === 0 },
          });
          if (isRecord(result) && typeof result.headEventUuid === 'string') {
            head = result.headEventUuid;
          }
        }
        return head;
      }
    }
    return this.jsonlStore.appendEvents(sessionId, events, opts);
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

  async replaceHistory(
    sessionId: string,
    events: JsonlEvent[],
    messageCount: number,
  ): Promise<string | null> {
    return this.jsonlStore.replaceEvents(sessionId, events, { messageCount });
  }

  async loadHeadEventUuid(sessionId: string): Promise<string | null> {
    return this.jsonlStore.getHeadEventUuid(sessionId);
  }

  async drain(): Promise<void> {
    await this.jsonlStore.drain();
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
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      await fsp.rm(path.join(dir, entry.name), { recursive: true, force: true });
      this.jsonlStore.dropSession(entry.name);
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
