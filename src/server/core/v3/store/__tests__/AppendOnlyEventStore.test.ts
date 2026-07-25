import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Work, WorkEvent } from '../../../../../shared/types/v3/index.js';
import { V3DomainError } from '../../domain/DomainError.js';
import { AppendOnlyEventStore } from '../AppendOnlyEventStore.js';

describe('AppendOnlyEventStore', () => {
  let tempRoot = '';
  let store: AppendOnlyEventStore;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-events-'));
    store = new AppendOnlyEventStore(tempRoot);
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('serializes a scope, assigns monotonic revisions and deduplicates eventId retries', async () => {
    const first = await store.appendWorkEvent(
      'work-1',
      draft('event-1', { type: 'work.created', work: makeWork('work-1') }),
      0,
    );
    const retry = await store.appendWorkEvent(
      'work-1',
      draft('event-1', {
        type: 'work.updated',
        work: { ...makeWork('work-1'), title: 'retry payload is not appended' },
      }),
      0,
    );
    const second = await store.appendWorkEvent(
      'work-1',
      draft('event-2', {
        type: 'work.updated',
        work: { ...makeWork('work-1'), title: 'Updated' },
      }),
      1,
    );

    expect(first.revision).toBe(1);
    expect(retry).toEqual(first);
    expect(second.revision).toBe(2);
    expect(await store.readWorkEvents('work-1')).toHaveLength(2);
  });

  it('uses a sequential per-scope lock so competing expected revisions cannot both commit', async () => {
    const results = await Promise.allSettled([
      store.appendWorkEvent(
        'contended',
        draft('event-a', { type: 'work.created', work: makeWork('contended') }),
        0,
      ),
      store.appendWorkEvent(
        'contended',
        draft('event-b', { type: 'work.created', work: makeWork('contended') }),
        0,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'REVISION_CONFLICT' }),
    });
    expect(await store.readWorkEvents('contended')).toHaveLength(1);
  });

  it('tolerates and repairs only an incomplete final record', async () => {
    await store.appendWorkEvent(
      'tail',
      draft('event-1', { type: 'work.created', work: makeWork('tail') }),
      0,
    );
    const streamPath = path.join(tempRoot, 'work', 'tail', 'events.jsonl');
    await fsp.appendFile(streamPath, '{"schemaVersion":3,"eventId":"torn', 'utf-8');

    expect(await store.readWorkEvents('tail')).toHaveLength(1);
    await store.appendWorkEvent(
      'tail',
      draft('event-2', {
        type: 'work.updated',
        work: { ...makeWork('tail'), title: 'After repair' },
      }),
      1,
    );

    const repaired = await fsp.readFile(streamPath, 'utf-8');
    expect(repaired).not.toContain('"eventId":"torn');
    expect(await store.readWorkEvents('tail')).toHaveLength(2);
  });

  it('rejects middle corruption and revision gaps', async () => {
    await store.appendWorkEvent(
      'middle',
      draft('event-1', { type: 'work.created', work: makeWork('middle') }),
      0,
    );
    const middlePath = path.join(tempRoot, 'work', 'middle', 'events.jsonl');
    await fsp.appendFile(middlePath, 'not-json\n{}\n', 'utf-8');
    await expect(store.readWorkEvents('middle')).rejects.toMatchObject({
      code: 'CORRUPT_EVENT_STREAM',
      details: expect.objectContaining({ line: 2 }),
    });

    await store.appendWorkEvent(
      'gap',
      draft('event-1', { type: 'work.created', work: makeWork('gap') }),
      0,
    );
    const gapPath = path.join(tempRoot, 'work', 'gap', 'events.jsonl');
    const gapEnvelope = {
      schemaVersion: 3,
      eventId: 'event-3',
      scopeType: 'work',
      scopeId: 'gap',
      revision: 3,
      occurredAt: '2026-01-01T00:00:00.000Z',
      event: {
        type: 'work.updated',
        work: { ...makeWork('gap'), title: 'Gap' },
      },
    };
    await fsp.appendFile(gapPath, `${JSON.stringify(gapEnvelope)}\n`, 'utf-8');
    await expect(store.readWorkEvents('gap')).rejects.toMatchObject({
      code: 'CORRUPT_EVENT_STREAM',
      details: expect.objectContaining({ line: 2 }),
    });
  });

  it('rejects sensitive keys anywhere in an event payload', async () => {
    const unsafeEvent = {
      type: 'work.created',
      work: {
        ...makeWork('unsafe'),
        providerSettings: { apiKey: 'must-never-persist' },
      },
    } as unknown as WorkEvent;

    await expect(
      store.appendWorkEvent('unsafe', draft('unsafe-event', unsafeEvent), 0),
    ).rejects.toMatchObject({
      code: 'SENSITIVE_FIELD',
    });
    await expect(fsp.access(path.join(tempRoot, 'work', 'unsafe', 'events.jsonl')))
      .rejects.toBeTruthy();
  });
});

function draft(eventId: string, event: WorkEvent) {
  return {
    eventId,
    occurredAt: '2026-01-01T00:00:00.000Z',
    event,
  };
}

function makeWork(id: string): Work {
  return {
    id,
    companyId: 'company-1',
    primarySessionId: `session-${id}`,
    title: 'Work',
    objective: 'Test persistence',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function expectDomainError(error: unknown): asserts error is V3DomainError {
  expect(error).toBeInstanceOf(V3DomainError);
}
