// JsonlStore — Append-only JSONL store with sharding and archival
// Each session's events are stored in sharded JSONL files under data/sessions/{sessionId}/

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';
import type { JsonlEvent, SessionMeta, TokenBreakdown } from '../../../shared/types/session.js';
import { SHARD_MAX_LINES, SHARD_MAX_BYTES, ARCHIVE_AGE_DAYS, PATHS, DEFAULT_CONTEXT_WINDOW } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHARD_INDEX_FILE = 'shards.json';
const META_FILE = 'meta.json';
const SHARD_PREFIX = 'shard_';
const SHARD_SUFFIX = '.jsonl';
const GZ_SUFFIX = '.gz';
const SESSIONS_DIR = PATHS.sessions; // 'data/sessions'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectRoot(): string {
  // Resolve from the location of this module, or use cwd
  return process.cwd();
}

function sessionDir(sessionId: string): string {
  return path.join(projectRoot(), SESSIONS_DIR, sanitise(sessionId));
}

/** Prevent path traversal in session IDs */
function sanitise(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

function shardFilename(index: number): string {
  return `${SHARD_PREFIX}${String(index).padStart(6, '0')}${SHARD_SUFFIX}`;
}

function shardPath(sessionId: string, index: number): string {
  return path.join(sessionDir(sessionId), shardFilename(index));
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

  private constructor() {
    super();
  }

  static getInstance(): JsonlStore {
    if (!JsonlStore._instance) {
      JsonlStore._instance = new JsonlStore();
    }
    return JsonlStore._instance;
  }

  /** Execute fn under a per-session sequential lock for meta writes.
   *  Prevents lost messageCount increments and overwritten meta fields
   *  when concurrent calls read-modify-write the same meta.json. */
  private async _withMetaLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._metaLocks.get(sessionId) || Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    this._metaLocks.set(sessionId, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // -----------------------------------------------------------------------
  // Event append
  // -----------------------------------------------------------------------

  async appendEvent(
    sessionId: string,
    event: JsonlEvent,
    opts?: { skipMetaUpdate?: boolean },
  ): Promise<void> {
    await this._withMetaLock(sessionId, async () => {
    const dir = sessionDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });

    // Load or initialise shard index
    let shards = this.shardIndexCache.get(sessionId);
    if (!shards) {
      shards = await this.loadShardIndex(sessionId);
      this.shardIndexCache.set(sessionId, shards);
    }

    // Determine current shard
    let currentIdx: number;
    let lineCount: number;
    let byteSize: number;

    if (shards.length === 0) {
      // No shards yet — create shard 0
      currentIdx = 0;
      shards.push(currentIdx);
      lineCount = 0;
      byteSize = 0;
    } else {
      const cached = this.currentShard.get(sessionId);
      if (cached !== undefined) {
        currentIdx = cached.index;
        lineCount = cached.lineCount;
        byteSize = cached.byteSize;
      } else {
        // Read the last shard to get its current size
        currentIdx = shards[shards.length - 1];
        const stats = await this.shardStats(sessionId, currentIdx);
        lineCount = stats.lineCount;
        byteSize = stats.byteSize;
      }
    }

    const line = JSON.stringify(event) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf-8');

    // Check if we need to rotate to a new shard
    if (lineCount >= SHARD_MAX_LINES || byteSize + lineBytes > SHARD_MAX_BYTES) {
      currentIdx = shards.length; // next index is len (0-based)
      shards.push(currentIdx);
      lineCount = 0;
      byteSize = 0;
      await this.saveShardIndex(sessionId, shards);

      this.emit('shardRotated', sessionId, currentIdx);
    }

    const filePath = shardPath(sessionId, currentIdx);
    await fsp.appendFile(filePath, line, 'utf-8');

    // Update current shard tracking
    this.currentShard.set(sessionId, { index: currentIdx, lineCount: lineCount + 1, byteSize: byteSize + lineBytes });

    // Update meta (increment message count) — skip for high-frequency stream events
    if (!opts?.skipMetaUpdate) {
      await this._doIncrementMetaMessageCount(sessionId);
    }

    this.emit('eventAppended', sessionId, event);
    });
  }

  // -----------------------------------------------------------------------
  // Read events
  // -----------------------------------------------------------------------

  async readEvents(sessionId: string, fromShard?: number): Promise<JsonlEvent[]> {
    let shards = this.shardIndexCache.get(sessionId);
    if (!shards) {
      shards = await this.loadShardIndex(sessionId);
    }

    const startIdx = fromShard ?? 0;
    const shardsToRead = shards.filter((s) => s >= startIdx).sort((a, b) => a - b);

    const events: JsonlEvent[] = [];

    for (const shardIdx of shardsToRead) {
      const filePath = shardPath(sessionId, shardIdx);
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

      for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const event = JSON.parse(trimmed) as JsonlEvent;
          events.push(event);
        } catch {
          // Skip malformed lines — don't break the entire read
        }
      }
    }

    return events;
  }

  // -----------------------------------------------------------------------
  // Session metadata
  // -----------------------------------------------------------------------

  async getMeta(sessionId: string): Promise<SessionMeta> {
    const cached = this.metaCache.get(sessionId);
    if (cached) return cached;

    const metaPath = path.join(sessionDir(sessionId), META_FILE);
    try {
      const raw = await fsp.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as SessionMeta;
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
  ): Promise<void> {
    const metaPath = path.join(sessionDir(sessionId), META_FILE);
    let current: Record<string, unknown>;
    try {
      const raw = await fsp.readFile(metaPath, 'utf-8');
      current = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const updated = transform(current);
    this.metaCache.set(sessionId, updated as unknown as SessionMeta);
    await fsp.mkdir(sessionDir(sessionId), { recursive: true });
    await fsp.writeFile(metaPath, JSON.stringify(updated, null, 2), 'utf-8');
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
  }

  // -----------------------------------------------------------------------
  // Truncate
  // -----------------------------------------------------------------------

  /** Delete all shard files and clear caches for a session. Used before rewriting compacted history. */
  async truncateSession(sessionId: string): Promise<void> {
    const shards = await this.loadShardIndex(sessionId);
    for (const shardIdx of shards) {
      const filePath = shardPath(sessionId, shardIdx);
      const gzPath = filePath + GZ_SUFFIX;
      try { await fsp.unlink(filePath); } catch { /* may not exist */ }
      try { await fsp.unlink(gzPath); } catch { /* may not exist */ }
    }
    const indexPath = path.join(sessionDir(sessionId), SHARD_INDEX_FILE);
    try { await fsp.unlink(indexPath); } catch { /* may not exist */ }
    this.dropSession(sessionId);
  }

  // -----------------------------------------------------------------------
  // Archive
  // -----------------------------------------------------------------------

  async archiveSession(sessionId: string): Promise<void> {
    const shards = await this.loadShardIndex(sessionId);
    const now = Date.now();
    const archiveThreshold = now - ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const shardIdx of shards) {
      const filePath = shardPath(sessionId, shardIdx);
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
    const indexPath = path.join(sessionDir(sessionId), SHARD_INDEX_FILE);
    try {
      const raw = await fsp.readFile(indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as number[];
    } catch {
      // File doesn't exist or is invalid — scan directory for shard files
      return this.scanShards(sessionId);
    }
    return [];
  }

  private async saveShardIndex(sessionId: string, shards: number[]): Promise<void> {
    const indexPath = path.join(sessionDir(sessionId), SHARD_INDEX_FILE);
    await fsp.mkdir(sessionDir(sessionId), { recursive: true });
    await fsp.writeFile(indexPath, JSON.stringify(shards), 'utf-8');
    this.shardIndexCache.set(sessionId, shards);
  }

  /** Scan the session directory for shard_*.jsonl and shard_*.jsonl.gz files */
  private async scanShards(sessionId: string): Promise<number[]> {
    const dir = sessionDir(sessionId);
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
    const filePath = shardPath(sessionId, shardIdx);
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
