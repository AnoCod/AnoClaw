import { afterEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinationStore } from '../CoordinationStore.js';
import type { CoordinationEvent } from '../../../../shared/types/coordination.js';

function event(revision: number): CoordinationEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    rootSessionId: 'root-1',
    revision,
    type: 'task_updated',
    timestamp: new Date().toISOString(),
    payload: { revision },
  };
}

describe('CoordinationStore crash recovery', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  it('quarantines an incomplete JSONL tail before appending the next event', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-coordination-'));
    tempDirs.push(root);
    const first = new CoordinationStore();
    await first.initialize(root);
    await first.append(event(1));

    const scopeDir = path.join(root, 'root-1');
    const shardPath = path.join(scopeDir, 'shard_000000.jsonl');
    await fsp.appendFile(shardPath, '{"schemaVersion":1,"eventId":"partial"', 'utf8');

    const restarted = new CoordinationStore();
    await restarted.initialize(root);
    await restarted.append(event(2));

    expect((await restarted.readEvents('root-1')).map((item) => item.revision)).toEqual([1, 2]);
    const shard = await fsp.readFile(shardPath, 'utf8');
    expect(shard).not.toContain('partial');
    expect((await fsp.readdir(scopeDir)).some((name) => name.includes('.corrupt-tail-'))).toBe(true);
  });
});
