import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CoordinationEvent,
  CoordinationSnapshot,
} from '../../../shared/types/coordination.js';

const MAX_SHARD_LINES = 10_000;
const MAX_SHARD_BYTES = 10 * 1024 * 1024;
const ROOT_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

interface ShardState {
  index: number;
  lines: number;
  bytes: number;
}

export class CoordinationStore {
  private rootDir = '';
  private readonly shardState = new Map<string, ShardState>();
  private readonly locks = new Map<string, Promise<void>>();

  async initialize(rootDir: string): Promise<void> {
    this.rootDir = path.resolve(rootDir);
    await fsp.mkdir(this.rootDir, { recursive: true });
    const schemaPath = path.join(this.rootDir, 'schema.json');
    try {
      await fsp.access(schemaPath);
    } catch {
      await fsp.writeFile(
        schemaPath,
        JSON.stringify({
          schemaVersion: 1,
          domain: 'anoclaw-coordination',
          createdAt: new Date().toISOString(),
        }, null, 2),
        'utf-8',
      );
    }
  }

  async listRootSessionIds(): Promise<string[]> {
    this.assertInitialized();
    const entries = await fsp.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const roots: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(
          await fsp.readFile(path.join(this.rootDir, entry.name, 'scope.json'), 'utf-8'),
        ) as { rootSessionId?: unknown };
        if (typeof meta.rootSessionId === 'string') roots.push(meta.rootSessionId);
      } catch {
        // Ignore incomplete scopes; their data remains available for diagnostics.
      }
    }
    return roots;
  }

  async append(event: CoordinationEvent): Promise<void> {
    this.assertRootId(event.rootSessionId);
    await this.withLock(event.rootSessionId, async () => {
      const dir = await this.ensureScope(event.rootSessionId);
      let state = this.shardState.get(event.rootSessionId);
      if (!state) {
        state = await this.inspectLatestShard(dir);
      }

      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line, 'utf-8');
      if (
        state.lines >= MAX_SHARD_LINES
        || (state.bytes > 0 && state.bytes + bytes > MAX_SHARD_BYTES)
      ) {
        state = { index: state.index + 1, lines: 0, bytes: 0 };
      }

      const shardPath = path.join(dir, shardName(state.index));
      const handle = await fsp.open(shardPath, 'a');
      try {
        await handle.writeFile(line, { encoding: 'utf-8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      state.lines += 1;
      state.bytes += bytes;
      this.shardState.set(event.rootSessionId, state);
    });
  }

  async readEvents(rootSessionId: string, afterRevision = 0): Promise<CoordinationEvent[]> {
    this.assertRootId(rootSessionId);
    return this.withLock(rootSessionId, async () => {
      const dir = this.scopeDir(rootSessionId);
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const shards = entries
        .filter((entry) => entry.isFile() && /^shard_\d{6}\.jsonl$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      if (shards.length > 0) {
        const latestState = await this.inspectLatestShard(dir);
        this.shardState.set(rootSessionId, latestState);
      }
      const result: CoordinationEvent[] = [];
      for (const shard of shards) {
        const raw = await fsp.readFile(path.join(dir, shard), 'utf-8');
        const lines = raw.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as CoordinationEvent;
            if (event.revision > afterRevision) result.push(event);
          } catch (error) {
            throw new Error(`Corrupt coordination event in ${shard} at line ${index + 1}`, {
              cause: error,
            });
          }
        }
      }
      return result.sort((a, b) => a.revision - b.revision);
    });
  }

  async readSnapshot(rootSessionId: string): Promise<CoordinationSnapshot | null> {
    this.assertRootId(rootSessionId);
    try {
      return JSON.parse(
        await fsp.readFile(path.join(this.scopeDir(rootSessionId), 'projection.json'), 'utf-8'),
      ) as CoordinationSnapshot;
    } catch {
      return null;
    }
  }

  async writeSnapshot(snapshot: CoordinationSnapshot): Promise<void> {
    this.assertRootId(snapshot.rootSessionId);
    const dir = await this.ensureScope(snapshot.rootSessionId);
    const target = path.join(dir, 'projection.json');
    const temp = path.join(dir, `.projection.${randomUUID()}.tmp`);
    const handle = await fsp.open(temp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2), { encoding: 'utf-8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, target);
  }

  private async ensureScope(rootSessionId: string): Promise<string> {
    const dir = this.scopeDir(rootSessionId);
    await fsp.mkdir(dir, { recursive: true });
    const scopePath = path.join(dir, 'scope.json');
    try {
      await fsp.access(scopePath);
    } catch {
      await fsp.writeFile(
        scopePath,
        JSON.stringify({ schemaVersion: 1, rootSessionId }, null, 2),
        'utf-8',
      );
    }
    return dir;
  }

  private async inspectLatestShard(dir: string): Promise<ShardState> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const indexes = entries
      .filter((entry) => entry.isFile() && /^shard_\d{6}\.jsonl$/.test(entry.name))
      .map((entry) => Number(entry.name.slice(6, 12)))
      .sort((a, b) => a - b);
    const index = indexes.at(-1) ?? 0;
    const file = path.join(dir, shardName(index));
    try {
      const repaired = await this.repairTrailingRecord(file);
      const raw = repaired.toString('utf-8');
      return {
        index,
        lines: raw.split(/\r?\n/).filter(Boolean).length,
        bytes: Buffer.byteLength(raw, 'utf-8'),
      };
    } catch {
      return { index, lines: 0, bytes: 0 };
    }
  }

  private async repairTrailingRecord(file: string): Promise<Buffer> {
    const raw = await fsp.readFile(file);
    if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return raw;

    const lastNewline = raw.lastIndexOf(0x0a);
    const tailOffset = lastNewline + 1;
    const tail = raw.subarray(tailOffset);
    try {
      JSON.parse(tail.toString('utf-8'));
      const handle = await fsp.open(file, 'a');
      try {
        await handle.writeFile('\n', 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return Buffer.concat([raw, Buffer.from('\n')]);
    } catch {
      const diagnostic = `${file}.corrupt-tail-${Date.now()}-${randomUUID()}.bin`;
      await fsp.writeFile(diagnostic, tail);
      const handle = await fsp.open(file, 'r+');
      try {
        await handle.truncate(tailOffset);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return raw.subarray(0, tailOffset);
    }
  }

  private scopeDir(rootSessionId: string): string {
    this.assertInitialized();
    this.assertRootId(rootSessionId);
    return path.join(this.rootDir, rootSessionId);
  }

  private assertInitialized(): void {
    if (!this.rootDir) throw new Error('CoordinationStore is not initialized');
  }

  private assertRootId(rootSessionId: string): void {
    if (!ROOT_ID_PATTERN.test(rootSessionId) || rootSessionId === '.' || rootSessionId === '..') {
      throw new Error(`Invalid coordination root session id: ${rootSessionId}`);
    }
  }

  private async withLock<T>(rootSessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(rootSessionId) || Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => next);
    this.locks.set(rootSessionId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(rootSessionId) === tail) this.locks.delete(rootSessionId);
    }
  }
}

function shardName(index: number): string {
  return `shard_${String(index).padStart(6, '0')}.jsonl`;
}
