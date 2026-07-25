export type MessageDeliveryStatus =
  | 'queued'
  | 'delivered'
  | 'consumed'
  | 'acknowledged'
  | 'dead_letter';

export interface MessageDelivery {
  messageId: string;
  sessionId: string;
  sequence: number;
  status: MessageDeliveryStatus;
  attempts: number;
  queuedAt: string;
  deliveredAt?: string;
  consumedAt?: string;
  acknowledgedAt?: string;
  deadLetteredAt?: string;
  lastError?: string;
  turnId?: string;
}
export type MessageDeliveryTransition =
  | {
      ok: true;
      delivery: MessageDelivery;
    }
  | {
      ok: false;
      code: 'invalid_transition' | 'turn_required';
      message: string;
    };

const TRANSITIONS: Readonly<Record<
  MessageDeliveryStatus,
  readonly MessageDeliveryStatus[]
>> = {
  queued: ['delivered', 'dead_letter'],
  delivered: ['consumed', 'dead_letter'],
  consumed: ['acknowledged', 'delivered', 'dead_letter'],
  acknowledged: [],
  dead_letter: [],
};

/**
 * Defines durable inbox/outbox acknowledgement semantics.
 *
 * delivered means the message was persisted to the target Session, consumed
 * means it entered an LLM request, and acknowledged means that turn completed.
 * These meanings intentionally prevent "append succeeded" from masquerading as
 * agent acknowledgement.
 */
export class MessageDeliveryStateMachine {
  transition(
    current: MessageDelivery,
    nextStatus: MessageDeliveryStatus,
    input: {
      now: string;
      turnId?: string;
      error?: string;
    },
  ): MessageDeliveryTransition {
    if (!TRANSITIONS[current.status].includes(nextStatus)) {
      return {
        ok: false,
        code: 'invalid_transition',
        message: `Message delivery cannot transition from ${current.status} to ${nextStatus}.`,
      };
    }
    if (
      (nextStatus === 'consumed' || nextStatus === 'acknowledged')
      && !input.turnId?.trim()
    ) {
      return {
        ok: false,
        code: 'turn_required',
        message: `${nextStatus} requires the LLM turn identifier.`,
      };
    }
    if (
      nextStatus === 'acknowledged'
      && current.turnId != null
      && input.turnId !== current.turnId
    ) {
      return {
        ok: false,
        code: 'turn_required',
        message: 'Only the consuming turn can acknowledge a message.',
      };
    }

    const delivery: MessageDelivery = {
      ...current,
      status: nextStatus,
      attempts: nextStatus === 'delivered' ? current.attempts + 1 : current.attempts,
      ...(input.error ? { lastError: input.error } : {}),
    };
    if (nextStatus === 'delivered') {
      delivery.deliveredAt = input.now;
      delivery.consumedAt = undefined;
      delivery.turnId = undefined;
    } else if (nextStatus === 'consumed') {
      delivery.consumedAt = input.now;
      delivery.turnId = input.turnId;
    } else if (nextStatus === 'acknowledged') {
      delivery.acknowledgedAt = input.now;
      delivery.turnId = input.turnId;
    } else if (nextStatus === 'dead_letter') {
      delivery.deadLetteredAt = input.now;
    }
    return { ok: true, delivery };
  }

  /**
   * A crash after consumed but before turn commit returns to delivered. The
   * persisted Session entry remains authoritative, so it must not be appended
   * again; it may enter a fresh LLM turn with the same message identity.
   */
  recover(current: MessageDelivery, now: string, reason: string): MessageDelivery {
    if (current.status !== 'consumed') return { ...current };
    return {
      ...current,
      status: 'delivered',
      deliveredAt: current.deliveredAt ?? now,
      consumedAt: undefined,
      turnId: undefined,
      lastError: reason,
    };
  }

  deliveryKey(messageId: string, sessionId: string): string {
    return `${messageId}\u0000${sessionId}`;
  }
}
