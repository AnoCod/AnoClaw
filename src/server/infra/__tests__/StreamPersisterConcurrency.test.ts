import { describe, expect, it, vi } from 'vitest';
import { StreamPersister } from '../StreamPersister.js';
import type { SessionStore } from '../../core/session/SessionStore.js';

function textFromEvent(event: Record<string, unknown>): string {
  const message = event.message as { content?: Array<{ text?: string }> } | undefined;
  return message?.content?.[0]?.text || '';
}

describe('StreamPersister concurrency', () => {
  it('serializes overlapping flushes without losing deltas', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const persisted: Record<string, unknown>[] = [];

    const store = {
      persistEvent: vi.fn(async (_sessionId: string, event: Record<string, unknown>) => {
        persisted.push(event);
        if (persisted.length === 1) {
          markFirstStarted();
          await firstGate;
        }
      }),
    } as unknown as SessionStore;
    const persister = new StreamPersister(store, 'session-1', 'turn-1', 'root');

    persister.bufferDelta('text', 'first');
    const firstFlush = persister.flushDeltas();
    await firstStarted;

    persister.bufferDelta('text', 'second');
    const secondFlush = persister.flushDeltas();
    releaseFirst();

    await Promise.all([firstFlush, secondFlush]);

    expect(persisted.map(textFromEvent)).toEqual(['first', 'second']);
    expect(persisted[0]?.parentUuid).toBe('root');
    expect(persisted[1]?.parentUuid).toBe(persisted[0]?.uuid);
  });

  it('requeues a failed delta and advances the UUID chain only after success', async () => {
    let attempt = 0;
    const persisted: Record<string, unknown>[] = [];
    const store = {
      persistEvent: vi.fn(async (_sessionId: string, event: Record<string, unknown>) => {
        attempt++;
        persisted.push(event);
        if (attempt === 1) throw new Error('disk unavailable');
      }),
    } as unknown as SessionStore;
    const logger = { error: vi.fn() };
    const persister = new StreamPersister(store, 'session-1', 'turn-1', 'root', '', logger);

    persister.bufferDelta('text', 'retry-me');
    await expect(persister.flushDeltas()).rejects.toThrow('disk unavailable');
    expect(persister.prevUuid).toBe('root');

    await persister.flushDeltas();

    expect(persisted.map(textFromEvent)).toEqual(['retry-me', 'retry-me']);
    expect(persister.prevUuid).toBe(persisted[1]?.uuid);
    expect(logger.error).toHaveBeenCalled();
  });
});
