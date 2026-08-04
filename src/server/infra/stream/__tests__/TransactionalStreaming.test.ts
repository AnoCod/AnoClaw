import { describe, expect, it, vi } from 'vitest';
import type { Transport } from '../../network/Transport.js';
import { StreamConsumer } from '../StreamConsumer.js';

function makeTransport(onSend: (event: Record<string, unknown>) => void): Transport {
  return {
    send: (_sessionId, event) => { onSend(event); return true; },
    broadcast: () => {},
    isConnected: () => true,
    activeSessions: () => ['session-1'],
    shutdown: async () => {},
    on: () => {},
  };
}

describe('StreamConsumer transactional streaming', () => {
  it('sends live text before committing persistence', async () => {
    const order: string[] = [];
    const persister = {
      bufferDelta: vi.fn(() => order.push('persist-buffer')),
      flushDeltas: vi.fn(async () => {}),
      beginAttempt: vi.fn(async () => {}),
      commitAttempt: vi.fn(async () => { order.push('persist-commit'); }),
      rollbackAttempt: vi.fn(),
      finalize: vi.fn(async () => {}),
    };
    const consumer = new StreamConsumer(
      makeTransport(event => order.push(String(event.type))),
      'session-1',
      persister,
      { bufferThreshold: 1 },
    );

    await consumer.beginAttempt({ type: 'llm_attempt_start', attemptId: 'attempt-1' });
    consumer.onDelta('text', 'live');

    expect(order).toEqual(['llm_attempt_start', 'text', 'persist-buffer']);

    await consumer.commitAttempt({ type: 'llm_attempt_commit', attemptId: 'attempt-1' });
    expect(order).toEqual([
      'llm_attempt_start',
      'text',
      'persist-buffer',
      'persist-commit',
      'llm_attempt_commit',
    ]);
  });

  it('drops unsent fragments and signals rollback', async () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const persister = {
      bufferDelta: vi.fn(),
      flushDeltas: vi.fn(async () => {}),
      beginAttempt: vi.fn(async () => {}),
      commitAttempt: vi.fn(async () => {}),
      rollbackAttempt: vi.fn(),
    };
    const consumer = new StreamConsumer(makeTransport(event => sent.push(event)), 'session-1', persister, {
      bufferThreshold: 100,
      editIntervalMs: 1000,
    });

    await consumer.beginAttempt({ type: 'llm_attempt_start', attemptId: 'attempt-1' });
    consumer.onDelta('think', 'never-send-this');
    await consumer.rollbackAttempt({ type: 'llm_attempt_rollback', attemptId: 'attempt-1' });
    await vi.runAllTimersAsync();

    expect(sent.map(event => event.type)).toEqual(['llm_attempt_start', 'llm_attempt_rollback']);
    expect(persister.bufferDelta).not.toHaveBeenCalled();
    expect(persister.rollbackAttempt).toHaveBeenCalledWith('attempt-1');
    vi.useRealTimers();
  });
});
