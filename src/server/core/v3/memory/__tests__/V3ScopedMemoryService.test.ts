import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { V3ScopedMemoryService } from '../V3ScopedMemoryService.js';

let rootDir = '';
let service: V3ScopedMemoryService;

beforeEach(async () => {
  rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-memory-'));
  service = new V3ScopedMemoryService(rootDir);
  await service.initialize();
});

afterEach(async () => {
  await fsp.rm(rootDir, { recursive: true, force: true });
});

describe('V3ScopedMemoryService', () => {
  it('isolates agent, team, and work targets', async () => {
    await Promise.all([
      save('agent', 'agent-a', 'agent-note', 'private alpha'),
      save('agent', 'agent-b', 'agent-note', 'private beta'),
      save('team', 'team-a', 'team-note', 'shared alpha'),
      save('team', 'team-b', 'team-note', 'shared beta'),
      save('work', 'work-a', 'work-note', 'work alpha'),
      save('work', 'work-b', 'work-note', 'work beta'),
    ]);

    await expectContent('agent', 'agent-a', 'private alpha');
    await expectContent('agent', 'agent-b', 'private beta');
    await expectContent('team', 'team-a', 'shared alpha');
    await expectContent('team', 'team-b', 'shared beta');
    await expectContent('work', 'work-a', 'work alpha');
    await expectContent('work', 'work-b', 'work beta');

    expect(await service.search({
      scope: 'agent',
      targetId: 'agent-a',
      query: 'beta',
    })).toEqual([]);
    expect(await service.search({
      scope: 'team',
      targetId: 'team-a',
      query: 'beta',
    })).toEqual([]);
    expect(await service.search({
      scope: 'work',
      targetId: 'work-a',
      query: 'beta',
    })).toEqual([]);
  });

  it('recovers active entries after restart', async () => {
    const saved = await save('mission', 'mission-a', 'decision', 'Persist this decision.');

    const restarted = new V3ScopedMemoryService(rootDir);
    const recovered = await restarted.get(
      { scope: 'mission', targetId: 'mission-a' },
      saved.id,
    );

    expect(recovered).toEqual(saved);
  });

  it('uses append-only tombstones and does not return deleted entries', async () => {
    await save('workspace', 'workspace-a', 'obsolete', 'Remove this later.');

    await expect(service.delete({
      scope: 'workspace',
      targetId: 'workspace-a',
      idOrName: 'obsolete',
      idempotencyKey: 'delete-obsolete',
    })).resolves.toBe(true);
    await expect(service.get(
      { scope: 'workspace', targetId: 'workspace-a' },
      'obsolete',
    )).resolves.toBeNull();

    const raw = await fsp.readFile(
      path.join(rootDir, 'workspace', 'workspace-a', 'events.jsonl'),
      'utf-8',
    );
    expect(raw).toContain('"type":"memory_saved"');
    expect(raw).toContain('"type":"memory_deleted"');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('replays matching idempotency keys without appending duplicates', async () => {
    const input = {
      scope: 'company' as const,
      targetId: 'company-a',
      type: 'reference' as const,
      name: 'policy',
      content: 'Stable policy.',
      idempotencyKey: 'save-policy-once',
    };

    const first = await service.save(input);
    const replay = await service.save(input);

    expect(replay).toEqual(first);
    const raw = await fsp.readFile(
      path.join(rootDir, 'company', 'company-a', 'events.jsonl'),
      'utf-8',
    );
    expect(raw.trim().split('\n')).toHaveLength(1);
    await expect(service.save({ ...input, content: 'Conflicting retry.' }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it.each([
    '../agent-a',
    '..',
    '.',
    'agent/a',
    'agent\\a',
    'C:\\outside',
  ])('rejects unsafe target ID %s', async (targetId) => {
    await expect(service.save({
      scope: 'agent',
      targetId,
      type: 'reference',
      name: 'unsafe',
      content: 'Must not be written.',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects credential material', async () => {
    await expect(service.save({
      scope: 'agent',
      targetId: 'agent-a',
      type: 'reference',
      name: 'credential',
      content: 'api_key = sk-abcdefghijklmnopqrstuvwxyz',
    })).rejects.toMatchObject({ code: 'SENSITIVE_FIELD' });
  });
});

async function save(
  scope: 'company' | 'team' | 'agent' | 'workspace' | 'work' | 'mission',
  targetId: string,
  name: string,
  content: string,
) {
  return service.save({
    scope,
    targetId,
    type: 'reference',
    name,
    content,
  });
}

async function expectContent(
  scope: 'company' | 'team' | 'agent' | 'workspace' | 'work' | 'mission',
  targetId: string,
  content: string,
): Promise<void> {
  const entries = await service.search({ scope, targetId, query: '' });
  expect(entries).toHaveLength(1);
  expect(entries[0].content).toBe(content);
}
