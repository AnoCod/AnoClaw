// JsonlStore — Append-only JSONL store with sharding and archival
// Each session's events are stored in sharded JSONL files under data/sessions/{sessionId}/

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import type { JsonlEvent, SessionMeta, TokenBreakdown } from '../../../shared/types/session.js';
import { SHARD_MAX_LINES, SHARD_MAX_BYTES, ARCHIVE_AGE_DAYS, DEFAULT_CONTEXT_WINDOW } from '../../../shared/constants.js';
import { jsonlEventsToMessages } from '../../../shared/serialization/jsonl-converters.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHARD_INDEX_FILE = 'shards.json';
const META_FILE = 'meta.json';
const SHARD_PREFIX = 'shard_';
const SHARD_SUFFIX = '.jsonl';
const GZ_SUFFIX = '.gz';
const ACTIVE_HISTORY_FILE = 'active-history.json';
const HISTORY_ROOT = '.history';
const APPEND_TRANSACTION_FILE = 'append-transaction.json';

interface AppendTransaction {
  schemaVersion: 1;
  state: 'pending' | 'committed';
  historyDir: string;
  originalShards: number[];
  originalPlainSizes: Record<string, number>;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shardFilename(index: number): string {
  return `${SHARD_PREFIX}${String(index).padStart(6, '0')}${SHARD_SUFFIX}`;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_.-]+$/;

function validateSessionId(sessionId: string): string {
  if (!sessionId || !SESSION_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  return sessionId;
}

// ---------------------------------------------------------------------------
// JsonlStore
// ---------------------------------------------------------------------------

export class JsonlStore extends EventEmitter {
  private static _instance: JsonlStore;

  /** In-memory cache for shard index lookups (sessionId → number[]) */
  private shardIndexCache: Map<string, number[]> = new Map();

  /** In-memory cache for session meta */
  private metaCache: Map<string, SessionMeta> = new Map();

  /** Track the current open shard info per session to avoid re-reading on every append */
  private currentShard: Map<string, { index: number; lineCount: number; byteSize: number }> = new Map();

  /** Per-session sequential locks — prevent concurrent meta read-modify-write races */
  private _metaLocks: Map<string, Promise<void>> = new Map();

  /** Explicit storage root. Never derive persistence paths from process.cwd(). */
  private sessionsDir = '';

  /** Active history directory cache (legacy session root or generation directory). */
  private historyDirCache: Map<string, string> = new Map();

  /** Authoritative in-process event head. Rebuilt from the JSONL tail on cold start. */
  private headCache: Map<string, string | null> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): JsonlStore {
    if (!JsonlStore._instance) {
      JsonlStore._instance = new JsonlStore();
    }
    return JsonlStore._instance;
  }

  static resetInstance(): void {
    JsonlStore._instance = undefined as unknown as JsonlStore;
  }

  /** Bind the store to one absolute sessions root. */
  async initialize(sessionsDir: string): Promise<void> {
    const resolved = path.resolve(sessionsDir);
    if (this.sessionsDir && this.sessionsDir !== resolved) {
      this.shardIndexCache.clear();
      this.metaCache.clear();
      this.currentShard.clear();
      this.historyDirCache.clear();
      this.headCache.clear();
    }
    this.sessionsDir = resolved;
    await fsp.mkdir(this.sessionsDir, { recursive: true });
  }

  getSessionsDir(): string {
    this.assertInitialized();
    return this.sessionsDir;
  }

  private assertInitialized(): void {
    if (!this.sessionsDir) {
      throw new Error('JsonlStore is not initialized');
    }
  }

  private sessionDir(sessionId: string): string {
    this.assertInitialized();
    return path.join(this.sessionsDir, validateSessionId(sessionId));
  }

  private async historyDir(sessionId: string): Promise<string> {
    const cached = this.historyDirCache.get(sessionId);
    if (cached) return cached;
    const dir = this.sessionDir(sessionId);
    const manifestPath = path.join(dir, ACTIVE_HISTORY_FILE);
    try {
      const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as { generation?: unknown };
      if (typeof parsed.generation === 'string' && SESSION_ID_RE.test(parsed.generation)) {
        const generationDir = path.join(dir, HISTORY_ROOT, parsed.generation);
        this.historyDirCache.set(sessionId, generationDir);
        return generationDir;
      }
    } catch {
      // Legacy layout: shard files live directly in the session directory.
    }
    this.historyDirCache.set(sessionId, dir);
    return dir;
  }

  private async shardPath(sessionId: string, index: number): Promise<string> {
    return path.join(await this.historyDir(sessionId), shardFilename(index));
  }

  /** Execute fn under a per-session sequential lock for meta writes.
   *  Prevents lost messageCount increments and overwritten meta fields
   *  when concurrent calls read-modify-write the same meta.json. */
  private async _withMetaLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._metaLocks.get(sessionId) || Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    const chainTail = prev.then(() => next);
    this._metaLocks.set(sessionId, chainTail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this._metaLocks.get(sessionId) === chainTail) {
        this._metaLocks.delete(sessionId);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Event append
  // -----------------------------------------------------------------------

  async appendEvent(
    sessionId: string,
    event: JsonlEvent,
    opts?: { skipMetaUpdate?: boolean; messageDelta?: number; sync?: boolean },
  ): Promise<string | null> {
    const messageDelta = opts?.messageDelta
      ?? (opts?.skipMetaUpdate ? 0 : this.inferLogicalMessageDelta(event));
    return this.appendEvents(sessionId, [event], { messageDelta, sync: opts?.sync });
  }

  /**
   * Append a complete event batch under one per-session lock. The store
   * re-chains every event against the authoritative on-disk tail, writes each
   * shard batch with one file handle, then updates derived metadata.
   */
  async appendEvents(
    sessionId: string,
    events: JsonlEvent[],
    opts: { messageDelta?: number; sync?: boolean } = {},
  ): Promise<string | null> {
    validateSessionId(sessionId);
    if (events.length === 0) return this.getHeadEventUuid(sessionId);

    return this._withMetaLock(sessionId, async () => {
      await this.reconcileAppendTransaction(sessionId);
      const dir = this.sessionDir(sessionId);
      const historyDir = await this.historyDir(sessionId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.mkdir(historyDir, { recursive: true });

      let shards = this.shardIndexCache.get(sessionId);
      if (!shards) {
        shards = await this.loadShardIndex(sessionId);
        this.shardIndexCache.set(sessionId, shards);
      }
      const originalShards = [...shards];
      const originalPlainSizes: Record<string, number> = {};
      for (const shardIdx of originalShards) {
        const filePath = await this.shardPath(sessionId, shardIdx);
        try {
          originalPlainSizes[String(shardIdx)] = (await fsp.stat(filePath)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }

      let currentIdx: number;
      let lineCount: number;
      let byteSize: number;
      if (shards.length === 0) {
        currentIdx = 0;
        shards.push(currentIdx);
        lineCount = 0;
        byteSize = 0;
      } else {
        currentIdx = shards[shards.length - 1];
        const currentPath = await this.shardPath(sessionId, currentIdx);
        const currentIsCompressed = !fs.existsSync(currentPath) && fs.existsSync(`${currentPath}${GZ_SUFFIX}`);
        if (currentIsCompressed) {
          currentIdx += 1;
          shards.push(currentIdx);
          lineCount = 0;
          byteSize = 0;
        } else {
          const cached = this.currentShard.get(sessionId);
          if (cached?.index === currentIdx) {
            lineCount = cached.lineCount;
            byteSize = cached.byteSize;
          } else {
            await this.validateOrRepairTailShard(sessionId, currentIdx);
            const stats = await this.shardStats(sessionId, currentIdx);
            lineCount = stats.lineCount;
            byteSize = stats.byteSize;
          }
        }
      }

      let head = this.headCache.has(sessionId)
        ? this.headCache.get(sessionId)!
        : await this.readLastEventUuid(sessionId);
      const prepared: JsonlEvent[] = [];
      for (const event of events) {
        const next = this.prepareEvent(sessionId, event, head);
        prepared.push(next);
        const uuid = (next as Record<string, unknown>).uuid;
        if (typeof uuid === 'string') head = uuid;
      }

      const transactionPath = path.join(dir, APPEND_TRANSACTION_FILE);
      const transaction: AppendTransaction = {
        schemaVersion: 1,
        state: 'pending',
        historyDir: path.relative(dir, historyDir) || '.',
        originalShards,
        originalPlainSizes,
        startedAt: new Date().toISOString(),
      };
      await this.atomicWriteText(transactionPath, JSON.stringify(transaction), false);

      try {
        let pending = '';
        let pendingLines = 0;
        let pendingBytes = 0;
        const flushPending = async (): Promise<void> => {
          if (!pending) return;
          const filePath = await this.shardPath(sessionId, currentIdx);
          const handle = await fsp.open(filePath, 'a');
          try {
            await handle.writeFile(pending, { encoding: 'utf-8' });
            if (opts.sync !== false) await handle.sync();
          } finally {
            await handle.close();
          }
          lineCount += pendingLines;
          byteSize += pendingBytes;
          pending = '';
          pendingLines = 0;
          pendingBytes = 0;
        };

        for (const event of prepared) {
          const line = `${JSON.stringify(event)}\n`;
          const lineBytes = Buffer.byteLength(line, 'utf-8');
          if (
            pendingLines > 0
            && (lineCount + pendingLines >= SHARD_MAX_LINES
              || byteSize + pendingBytes + lineBytes > SHARD_MAX_BYTES)
          ) {
            await flushPending();
            currentIdx = (shards[shards.length - 1] ?? -1) + 1;
            shards.push(currentIdx);
            lineCount = 0;
            byteSize = 0;
            this.emit('shardRotated', sessionId, currentIdx);
          } else if (
            pendingLines === 0
            && (lineCount >= SHARD_MAX_LINES || byteSize + lineBytes > SHARD_MAX_BYTES)
          ) {
            currentIdx = (shards[shards.length - 1] ?? -1) + 1;
            shards.push(currentIdx);
            lineCount = 0;
            byteSize = 0;
            this.emit('shardRotated', sessionId, currentIdx);
          }
          pending += line;
          pendingLines += 1;
          pendingBytes += lineBytes;
        }
        await flushPending();
        await this.saveShardIndex(sessionId, shards);
        await this.atomicWriteText(
          transactionPath,
          JSON.stringify({ ...transaction, state: 'committed' }),
          false,
        );

        this.currentShard.set(sessionId, { index: currentIdx, lineCount, byteSize });
        this.headCache.set(sessionId, head);

        try {
          await this._atomicUpdateMeta(sessionId, (current) => ({
            ...current,
            sessionId: typeof current.sessionId === 'string' ? current.sessionId : sessionId,
            createdAt: typeof current.createdAt === 'string' ? current.createdAt : new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            headEventUuid: head,
            eventCount: Math.max(0, Number(current.eventCount) || 0) + prepared.length,
            messageCount: Math.max(0, Number(current.messageCount) || 0) + Math.max(0, opts.messageDelta || 0),
          }));
        } catch (error) {
          this.metaCache.delete(sessionId);
          this.emit('metaUpdateFailed', sessionId, error);
        }

        await fsp.rm(transactionPath, { force: true });
        await this.fsyncDirectoryBestEffort(dir);
        for (const event of prepared) this.emit('eventAppended', sessionId, event);
        return head;
      } catch (error) {
        this.shardIndexCache.delete(sessionId);
        this.currentShard.delete(sessionId);
        this.headCache.delete(sessionId);
        await this.reconcileAppendTransaction(sessionId).catch(() => {});
        throw error;
      }
    });
  }

  // -----------------------------------------------------------------------
  // Read events
  // -----------------------------------------------------------------------

  async readEvents(sessionId: string, fromShard?: number): Promise<JsonlEvent[]> {
    validateSessionId(sessionId);
    let shards = this.shardIndexCache.get(sessionId);
    if (!shards) {
      shards = await this.loadShardIndex(sessionId);
      this.shardIndexCache.set(sessionId, shards);
    }

    const startIdx = fromShard ?? 0;
    const shardsToRead = shards.filter((s) => s >= startIdx).sort((a, b) => a - b);

    const events: JsonlEvent[] = [];

    for (const shardIdx of shardsToRead) {
      const filePath = await this.shardPath(sessionId, shardIdx);
      const gzPath = filePath + GZ_SUFFIX;

      let stream: NodeJS.ReadableStream;

      if (fs.existsSync(gzPath)) {
        // Read from gzip-compressed shard
        stream = fs.createReadStream(gzPath).pipe(zlib.createGunzip());
      } else if (fs.existsSync(filePath)) {
        stream = fs.createReadStream(filePath, 'utf-8');
      } else {
        continue;
      }

      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const line of rl) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const event = JSON.parse(trimmed) as JsonlEvent;
          events.push(event);
        } catch (error) {
          throw new Error(
            `Corrupt JSONL event in session ${sessionId}, shard ${shardIdx}, line ${lineNumber}: ${(error as Error).message}`,
          );
        }
      }
    }

    return events;
  }

  // -----------------------------------------------------------------------
  // Session metadata
  // -----------------------------------------------------------------------

  async getMeta(sessionId: string): Promise<SessionMeta> {
    validateSessionId(sessionId);
    const cached = this.metaCache.get(sessionId);
    if (cached) return cached;

    const metaPath = path.join(this.sessionDir(sessionId), META_FILE);
    try {
      const meta = await this.readJsonWithBackup(metaPath) as unknown as SessionMeta;
      this.metaCache.set(sessionId, meta);
      return meta;
    } catch {
      // Return default meta if file doesn't exist
      const now = new Date().toISOString();
      const defaultMeta: SessionMeta = {
        sessionId,
        createdAt: now,
        lastActiveAt: now,
        messageCount: 0,
        eventCount: 0,
        headEventUuid: null,
        tokenBreakdown: { systemPrompt: 0, systemTools: 0, skills: 0, messages: 0, freeSpace: DEFAULT_CONTEXT_WINDOW, total: 0 },
      };
      this.metaCache.set(sessionId, defaultMeta);
      return defaultMeta;
    }
  }

  async updateMeta(sessionId: string, updates: Partial<SessionMeta>): Promise<void> {
    await this._withMetaLock(sessionId, async () => {
      await this._atomicUpdateMeta(sessionId, (current) => ({ ...current, ...updates }));
    });
  }

  /** Merge lifecycle metadata into the shared session meta document without
   * dropping derived statistics maintained by JsonlStore. */
  async mergeMetaDocument(
    sessionId: string,
    updates: Record<string, unknown>,
    targetPath?: string,
  ): Promise<void> {
    await this._withMetaLock(sessionId, async () => {
      await this._atomicUpdateMeta(sessionId, (current) => ({ ...current, ...updates }), targetPath);
    });
  }

  /** Public: increment message count with its own lock (for callers outside appendEvent). */
  async incrementMetaMessageCount(sessionId: string): Promise<void> {
    await this._withMetaLock(sessionId, async () => {
      await this._doIncrementMetaMessageCount(sessionId);
    });
  }

  /** Internal: increment message count. Caller must hold _withMetaLock. */
  private async _doIncrementMetaMessageCount(sessionId: string): Promise<void> {
    try {
      await this._atomicUpdateMeta(sessionId, (current) => {
        current.messageCount = ((current.messageCount as number) || 0) + 1;
        current.lastActiveAt = new Date().toISOString();
        if (!current.sessionId) current.sessionId = sessionId;
        if (!current.createdAt) current.createdAt = new Date().toISOString();
        return current;
      });
    } catch {
      // Non-critical — allow append to succeed even if meta update fails
    }
  }

  /** Read-modify-write meta.json with a transform function. Caller must hold _withMetaLock. */
  private async _atomicUpdateMeta(
    sessionId: string,
    transform: (current: Record<string, unknown>) => Record<string, unknown>,
    targetPath?: string,
  ): Promise<void> {
    const metaPath = targetPath || path.join(this.sessionDir(sessionId), META_FILE);
    let current: Record<string, unknown>;
    try {
      current = await this.readJsonWithBackup(metaPath);
    } catch {
      current = {};
    }
    const updated = transform(current);
    await this.atomicWriteText(metaPath, JSON.stringify(updated, null, 2), true);
    this.metaCache.set(sessionId, updated as unknown as SessionMeta);
  }

  /** Invalidate the meta cache for a session (called after writeSessionMeta) */
  invalidateMetaCache(sessionId: string): void {
    this.metaCache.delete(sessionId);
  }

  /** Drop all cached state for a session (called after hard delete) */
  dropSession(sessionId: string): void {
    this.shardIndexCache.delete(sessionId);
    this.currentShard.delete(sessionId);
    this.metaCache.delete(sessionId);
    this.historyDirCache.delete(sessionId);
    this.headCache.delete(sessionId);
  }

  // -----------------------------------------------------------------------
  // Truncate
  // -----------------------------------------------------------------------

  /**
   * Atomically replace a transcript by writing a new immutable generation and
   * switching one small manifest. A crash can expose the old or new history,
   * never a half-rewritten mixture.
   */
  async replaceEvents(
    sessionId: string,
    events: JsonlEvent[],
    opts: { messageCount: number },
  ): Promise<string | null> {
    validateSessionId(sessionId);
    return this._withMetaLock(sessionId, async () => {
      const sessionRoot = this.sessionDir(sessionId);
      const previousHistoryDir = await this.historyDir(sessionId);
      const generation = `gen-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const generationDir = path.join(sessionRoot, HISTORY_ROOT, generation);
      await fsp.mkdir(generationDir, { recursive: true });

      let head: string | null = null;
      const prepared = events.map((event) => {
        const next = this.prepareEvent(sessionId, event, head);
        const uuid = (next as Record<string, unknown>).uuid;
        if (typeof uuid === 'string') head = uuid;
        return next;
      });

      const shards: number[] = [];
      let shardIdx = 0;
      let lineCount = 0;
      let byteSize = 0;
      let content = '';
      const flushShard = async (): Promise<void> => {
        if (!content) return;
        const filePath = path.join(generationDir, shardFilename(shardIdx));
        const handle = await fsp.open(filePath, 'wx');
        try {
          await handle.writeFile(content, { encoding: 'utf-8' });
          await handle.sync();
        } finally {
          await handle.close();
        }
        shards.push(shardIdx);
        shardIdx += 1;
        lineCount = 0;
        byteSize = 0;
        content = '';
      };

      for (const event of prepared) {
        const line = `${JSON.stringify(event)}\n`;
        const bytes = Buffer.byteLength(line, 'utf-8');
        if (lineCount > 0 && (lineCount >= SHARD_MAX_LINES || byteSize + bytes > SHARD_MAX_BYTES)) {
          await flushShard();
        }
        content += line;
        lineCount += 1;
        byteSize += bytes;
      }
      await flushShard();
      await this.atomicWriteText(path.join(generationDir, SHARD_INDEX_FILE), JSON.stringify(shards), true);
      await this.atomicWriteText(
        path.join(sessionRoot, ACTIVE_HISTORY_FILE),
        JSON.stringify({ generation }),
        true,
      );

      this.shardIndexCache.set(sessionId, shards);
      this.currentShard.delete(sessionId);
      this.historyDirCache.set(sessionId, generationDir);
      this.headCache.set(sessionId, head);
      await this._atomicUpdateMeta(sessionId, (current) => ({
        ...current,
        headEventUuid: head,
        eventCount: prepared.length,
        messageCount: Math.max(0, opts.messageCount),
        lastActiveAt: new Date().toISOString(),
      }));

      await this.removeSupersededHistory(sessionId, previousHistoryDir, generationDir).catch(() => {});
      return head;
    });
  }

  /** Switch to an empty transcript generation without deleting the old history first. */
  async truncateSession(sessionId: string): Promise<void> {
    await this.replaceEvents(sessionId, [], { messageCount: 0 });
  }

  // -----------------------------------------------------------------------
  // Archive
  // -----------------------------------------------------------------------

  async archiveSession(sessionId: string): Promise<void> {
    const shards = await this.loadShardIndex(sessionId);
    const now = Date.now();
    const archiveThreshold = now - ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const shardIdx of shards) {
      const filePath = await this.shardPath(sessionId, shardIdx);
      const gzPath = filePath + GZ_SUFFIX;

      // Skip if already compressed
      if (fs.existsSync(gzPath)) continue;
      if (!fs.existsSync(filePath)) continue;

      const stats = await fsp.stat(filePath);

      // Only compress shards older than ARCHIVE_AGE_DAYS
      if (stats.mtimeMs >= archiveThreshold) continue;

      await this.gzipFile(filePath, gzPath);

      // Remove original after successful compression
      await fsp.unlink(filePath);
    }

    // Read meta before clearing caches
    const meta = await this.getMeta(sessionId);

    // Clear caches for this session
    this.dropSession(sessionId);

    // Update meta status to archived
    meta.lastActiveAt = new Date().toISOString();
    await this.updateMeta(sessionId, meta);

    this.emit('sessionArchived', sessionId);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async loadShardIndex(sessionId: string): Promise<number[]> {
    const indexPath = path.join(await this.historyDir(sessionId), SHARD_INDEX_FILE);
    for (const candidate of [indexPath, `${indexPath}.bak`]) {
      try {
        const parsed = JSON.parse(await fsp.readFile(candidate, 'utf-8'));
        if (
          Array.isArray(parsed)
          && parsed.every((index) => Number.isInteger(index) && index >= 0)
        ) {
          return [...new Set(parsed as number[])].sort((a, b) => a - b);
        }
      } catch {
        // Try the backup before scanning immutable shard files.
      }
    }
    return this.scanShards(sessionId);
  }

  private async saveShardIndex(sessionId: string, shards: number[]): Promise<void> {
    const historyDir = await this.historyDir(sessionId);
    const indexPath = path.join(historyDir, SHARD_INDEX_FILE);
    await fsp.mkdir(historyDir, { recursive: true });
    await this.atomicWriteText(indexPath, JSON.stringify(shards), true);
    this.shardIndexCache.set(sessionId, [...shards]);
  }

  /** Scan the session directory for shard_*.jsonl and shard_*.jsonl.gz files */
  private async scanShards(sessionId: string): Promise<number[]> {
    const dir = await this.historyDir(sessionId);
    try {
      const entries = await fsp.readdir(dir);
      const indices = new Set<number>();

      for (const entry of entries) {
        // Match shard_NNNNNN.jsonl or shard_NNNNNN.jsonl.gz
        let name = entry;
        let isGz = false;
        if (name.endsWith(GZ_SUFFIX)) {
          name = name.slice(0, -GZ_SUFFIX.length);
          isGz = true;
        }
        if (!name.startsWith(SHARD_PREFIX) || !name.endsWith(SHARD_SUFFIX)) continue;

        const numStr = name.slice(SHARD_PREFIX.length, -SHARD_SUFFIX.length);
        const num = parseInt(numStr, 10);
        if (!isNaN(num)) indices.add(num);
      }

      const result = Array.from(indices).sort((a, b) => a - b);
      return result;
    } catch {
      return [];
    }
  }

  /** Get line count and byte size of a shard file (uncompressed only) */
  private async shardStats(sessionId: string, shardIdx: number): Promise<{ lineCount: number; byteSize: number }> {
    const filePath = await this.shardPath(sessionId, shardIdx);
    try {
      const stat = await fsp.stat(filePath);
      // Fast path: small files — read buffer and count \n bytes
      if (stat.size <= 16 * 1024 * 1024) {
        const buf = await fsp.readFile(filePath);
        let lineCount = 0;
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 10) lineCount++; // '\n' === 10
        }
        return { lineCount, byteSize: stat.size };
      }
      // Fallback for very large files: streaming read with buffer counting
      let lineCount = 0;
      const fd = await fsp.open(filePath, 'r');
      try {
        const chunkSize = 64 * 1024;
        const buf = Buffer.alloc(chunkSize);
        let bytesRead: number;
        do {
          const result = await fd.read(buf, 0, chunkSize, null);
          bytesRead = result.bytesRead;
          for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 10) lineCount++;
          }
        } while (bytesRead > 0);
      } finally {
        await fd.close();
      }
      return { lineCount, byteSize: stat.size };
    } catch {
      return { lineCount: 0, byteSize: 0 };
    }
  }

  /** Validate every committed line and repair only an incomplete final tail. */
  async recoverSession(
    sessionId: string,
  ): Promise<{ headEventUuid: string | null; eventCount: number; messageCount: number }> {
    validateSessionId(sessionId);
    await this.reconcileAppendTransaction(sessionId);
    this.shardIndexCache.delete(sessionId);
    this.currentShard.delete(sessionId);
    this.headCache.delete(sessionId);
    const shards = await this.loadShardIndex(sessionId);
    this.shardIndexCache.set(sessionId, shards);

    for (let index = 0; index < shards.length; index++) {
      await this.validateOrRepairTailShard(
        sessionId,
        shards[index],
        index === shards.length - 1,
      );
    }

    const events = await this.readEvents(sessionId);
    const last = events[events.length - 1] as Record<string, unknown> | undefined;
    const headEventUuid = typeof last?.uuid === 'string' ? last.uuid : null;
    this.headCache.set(sessionId, headEventUuid);
    return {
      headEventUuid,
      eventCount: events.length,
      messageCount: jsonlEventsToMessages(events).length,
    };
  }

  /**
   * Resolve an interrupted append before exposing the transcript. Pending
   * batches are rolled back to their recorded shard sizes; committed batches
   * are retained and metadata is corrected by normal recovery.
   */
  private async reconcileAppendTransaction(sessionId: string): Promise<void> {
    const sessionRoot = this.sessionDir(sessionId);
    const transactionPath = path.join(sessionRoot, APPEND_TRANSACTION_FILE);
    let transaction: AppendTransaction;
    try {
      transaction = JSON.parse(await fsp.readFile(transactionPath, 'utf-8')) as AppendTransaction;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Invalid append transaction for session ${sessionId}: ${(error as Error).message}`);
    }
    if (
      transaction.schemaVersion !== 1
      || !['pending', 'committed'].includes(transaction.state)
      || typeof transaction.historyDir !== 'string'
      || !Array.isArray(transaction.originalShards)
      || !transaction.originalShards.every((index) => Number.isInteger(index) && index >= 0)
      || !transaction.originalPlainSizes
      || typeof transaction.originalPlainSizes !== 'object'
    ) {
      throw new Error(`Invalid append transaction schema for session ${sessionId}`);
    }

    const historyDir = path.resolve(sessionRoot, transaction.historyDir);
    const rootResolved = path.resolve(sessionRoot);
    if (historyDir !== rootResolved && !historyDir.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error(`Append transaction escapes session root for ${sessionId}`);
    }

    if (transaction.state === 'pending') {
      await fsp.mkdir(historyDir, { recursive: true });
      const entries = await fsp.readdir(historyDir).catch(() => []);
      for (const entry of entries) {
        if (!entry.startsWith(SHARD_PREFIX) || !entry.endsWith(SHARD_SUFFIX)) continue;
        const shardIndex = Number.parseInt(
          entry.slice(SHARD_PREFIX.length, -SHARD_SUFFIX.length),
          10,
        );
        if (!Number.isInteger(shardIndex)) continue;
        const filePath = path.join(historyDir, entry);
        const originalSize = transaction.originalPlainSizes[String(shardIndex)];
        if (typeof originalSize === 'number' && originalSize >= 0) {
          const handle = await fsp.open(filePath, 'r+');
          try {
            await handle.truncate(originalSize);
            await handle.sync();
          } finally {
            await handle.close();
          }
        } else {
          await fsp.rm(filePath, { force: true });
        }
      }
      await this.atomicWriteText(
        path.join(historyDir, SHARD_INDEX_FILE),
        JSON.stringify(transaction.originalShards),
        true,
      );
      this.emit('appendBatchRolledBack', sessionId);
    }

    await fsp.rm(transactionPath, { force: true });
    await this.fsyncDirectoryBestEffort(sessionRoot);
    this.shardIndexCache.delete(sessionId);
    this.currentShard.delete(sessionId);
    this.headCache.delete(sessionId);
  }

  async getHeadEventUuid(sessionId: string): Promise<string | null> {
    validateSessionId(sessionId);
    if (this.headCache.has(sessionId)) return this.headCache.get(sessionId)!;
    const head = await this.readLastEventUuid(sessionId);
    this.headCache.set(sessionId, head);
    return head;
  }

  /** Wait for all queued writes. Append calls sync their file handles before resolving. */
  async drain(): Promise<void> {
    while (this._metaLocks.size > 0) {
      await Promise.all([...this._metaLocks.values()]);
    }
  }

  private async readLastEventUuid(sessionId: string): Promise<string | null> {
    const events = await this.readEvents(sessionId);
    const last = events[events.length - 1] as Record<string, unknown> | undefined;
    return typeof last?.uuid === 'string' ? last.uuid : null;
  }

  private prepareEvent(
    sessionId: string,
    event: JsonlEvent,
    parentUuid: string | null,
  ): JsonlEvent {
    if (!event || typeof event !== 'object') {
      throw new Error(`Invalid JSONL event for session ${sessionId}`);
    }
    const record = event as unknown as Record<string, unknown>;
    if (typeof record.type !== 'string' || !record.type) {
      throw new Error(`JSONL event is missing type for session ${sessionId}`);
    }
    if (typeof record.sessionId === 'string' && record.sessionId !== sessionId) {
      throw new Error(`JSONL event session mismatch: ${record.sessionId} != ${sessionId}`);
    }
    const uuid = typeof record.uuid === 'string' && record.uuid
      ? record.uuid
      : `ev-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const timestamp = typeof record.timestamp === 'string' && record.timestamp
      ? record.timestamp
      : new Date().toISOString();
    return {
      ...record,
      uuid,
      parentUuid,
      sessionId,
      timestamp,
    } as unknown as JsonlEvent;
  }

  private inferLogicalMessageDelta(event: JsonlEvent): number {
    return ['user', 'system', 'assistant', 'message'].includes(event.type) ? 1 : 0;
  }

  private async validateOrRepairTailShard(
    sessionId: string,
    shardIdx: number,
    allowTailRepair = true,
  ): Promise<void> {
    const filePath = await this.shardPath(sessionId, shardIdx);
    const gzPath = `${filePath}${GZ_SUFFIX}`;
    if (!fs.existsSync(filePath)) {
      if (fs.existsSync(gzPath)) return;
      throw new Error(`Missing shard ${shardIdx} for session ${sessionId}`);
    }

    const buffer = await fsp.readFile(filePath);
    if (buffer.length === 0) return;
    const text = buffer.toString('utf-8');
    const endsWithNewline = text.endsWith('\n');
    const lines = text.split('\n');
    const committedLines = endsWithNewline ? lines.slice(0, -1) : lines.slice(0, -1);

    for (let lineIndex = 0; lineIndex < committedLines.length; lineIndex++) {
      const line = committedLines[lineIndex].trim();
      if (!line) continue;
      try {
        JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Corrupt committed JSONL in session ${sessionId}, shard ${shardIdx}, line ${lineIndex + 1}: ${(error as Error).message}`,
        );
      }
    }

    if (endsWithNewline) return;
    const tail = lines[lines.length - 1]?.trim() || '';
    if (!allowTailRepair) {
      throw new Error(`Unterminated non-final shard ${shardIdx} in session ${sessionId}`);
    }

    let validTail = false;
    try {
      if (tail) JSON.parse(tail);
      validTail = true;
    } catch {
      validTail = false;
    }
    if (validTail) {
      const handle = await fsp.open(filePath, 'a');
      try {
        await handle.writeFile('\n', { encoding: 'utf-8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      const lastNewline = buffer.lastIndexOf(0x0a);
      const validLength = lastNewline >= 0 ? lastNewline + 1 : 0;
      const handle = await fsp.open(filePath, 'r+');
      try {
        await handle.truncate(validLength);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.emit('tailRepaired', sessionId, shardIdx, buffer.length - validLength);
    }
  }

  private async removeSupersededHistory(
    sessionId: string,
    previousHistoryDir: string,
    activeHistoryDir: string,
  ): Promise<void> {
    if (path.resolve(previousHistoryDir) === path.resolve(activeHistoryDir)) return;
    const sessionRoot = this.sessionDir(sessionId);
    const historyRoot = path.join(sessionRoot, HISTORY_ROOT);
    if (path.resolve(previousHistoryDir).startsWith(`${path.resolve(historyRoot)}${path.sep}`)) {
      await fsp.rm(previousHistoryDir, { recursive: true, force: true });
      return;
    }

    const entries = await fsp.readdir(sessionRoot).catch(() => []);
    for (const entry of entries) {
      if (
        entry === SHARD_INDEX_FILE
        || (entry.startsWith(SHARD_PREFIX)
          && (entry.endsWith(SHARD_SUFFIX) || entry.endsWith(`${SHARD_SUFFIX}${GZ_SUFFIX}`)))
      ) {
        await fsp.rm(path.join(sessionRoot, entry), { force: true }).catch(() => {});
      }
    }
  }

  private async readJsonWithBackup(filePath: string): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await fsp.readFile(filePath, 'utf-8')) as Record<string, unknown>;
    } catch (primaryError) {
      try {
        return JSON.parse(await fsp.readFile(`${filePath}.bak`, 'utf-8')) as Record<string, unknown>;
      } catch {
        throw primaryError;
      }
    }
  }

  private async atomicWriteText(
    filePath: string,
    content: string,
    keepBackup: boolean,
  ): Promise<void> {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    if (keepBackup) {
      try {
        const previous = await fsp.readFile(filePath);
        await this.atomicReplace(`${filePath}.bak`, previous);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await this.atomicReplace(filePath, Buffer.from(content, 'utf-8'));
  }

  private async atomicReplace(filePath: string, content: Buffer): Promise<void> {
    const dir = path.dirname(filePath);
    const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(tempPath, 'wx');
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.rename(tempPath, filePath);
      await this.fsyncDirectoryBestEffort(dir);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async fsyncDirectoryBestEffort(dir: string): Promise<void> {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(dir, 'r');
      await handle.sync();
    } catch {
      // Directory fsync is not supported by every Windows filesystem.
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  /** Gzip a file using streaming */
  private gzipFile(srcPath: string, destPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const readStream = fs.createReadStream(srcPath);
      const writeStream = fs.createWriteStream(destPath);
      const gzip = zlib.createGzip();

      readStream
        .pipe(gzip)
        .pipe(writeStream)
        .on('finish', resolve)
        .on('error', (err) => {
          // Clean up partial output on error
          fs.unlink(destPath, () => {});
          reject(err);
        });
    });
  }
}
