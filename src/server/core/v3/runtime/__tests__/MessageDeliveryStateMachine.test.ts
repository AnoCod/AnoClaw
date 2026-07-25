import { describe, expect, it } from 'vitest';
import {
  MessageDeliveryStateMachine,
  type MessageDelivery,
} from '../MessageDeliveryStateMachine.js';

describe('MessageDeliveryStateMachine', () => {
  const stateMachine = new MessageDeliveryStateMachine();

  it('does not treat delivery as acknowledgement', () => {
    const delivered = stateMachine.transition(queued(), 'delivered', {
      now: '2026-07-25T00:00:01.000Z',
    });
    expect(delivered).toMatchObject({
      ok: true,
      delivery: {
        status: 'delivered',
        attempts: 1,
      },
    });
    if (delivered.ok) expect(delivered.delivery.acknowledgedAt).toBeUndefined();
  });

  it('requires the consuming turn to acknowledge', () => {
    const consumed = stateMachine.transition({
      ...queued(),
      status: 'delivered',
      attempts: 1,
      deliveredAt: '2026-07-25T00:00:01.000Z',
    }, 'consumed', {
      now: '2026-07-25T00:00:02.000Z',
      turnId: 'turn-a',
    });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(stateMachine.transition(consumed.delivery, 'acknowledged', {
      now: '2026-07-25T00:00:03.000Z',
      turnId: 'turn-b',
    })).toMatchObject({
      ok: false,
      code: 'turn_required',
    });
    expect(stateMachine.transition(consumed.delivery, 'acknowledged', {
      now: '2026-07-25T00:00:03.000Z',
      turnId: 'turn-a',
    })).toMatchObject({
      ok: true,
      delivery: {
        status: 'acknowledged',
        turnId: 'turn-a',
      },
    });
  });

  it('recovers a crashed consuming turn without requesting duplicate append', () => {
    const recovered = stateMachine.recover({
      ...queued(),
      status: 'consumed',
      attempts: 1,
      deliveredAt: '2026-07-25T00:00:01.000Z',
      consumedAt: '2026-07-25T00:00:02.000Z',
      turnId: 'turn-a',
    }, '2026-07-25T00:00:04.000Z', 'process restarted');
    expect(recovered).toMatchObject({
      status: 'delivered',
      attempts: 1,
      deliveredAt: '2026-07-25T00:00:01.000Z',
      consumedAt: undefined,
      turnId: undefined,
      lastError: 'process restarted',
    });
  });

  it('creates a stable per-recipient delivery key', () => {
    expect(stateMachine.deliveryKey('message-a', 'session-a')).not.toBe(
      stateMachine.deliveryKey('message-a', 'session-b'),
    );
  });
});

function queued(): MessageDelivery {
  return {
    messageId: 'message-a',
    sessionId: 'session-a',
    sequence: 1,
    status: 'queued',
    attempts: 0,
    queuedAt: '2026-07-25T00:00:00.000Z',
  };
}
