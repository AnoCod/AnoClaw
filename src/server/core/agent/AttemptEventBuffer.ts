import type { SSEEvent } from '../../../shared/types/events.js';
import { SSEEventType } from '../../../shared/types/events.js';

/**
 * Holds provisional events from one LLM provider attempt until the attempt is
 * committed. Live transports may still forward the raw events immediately;
 * durable and aggregate consumers use the committed output returned here.
 */
export class AttemptEventBuffer {
  private activeAttemptId: string | null = null;
  private events: SSEEvent[] = [];

  get activeId(): string | null {
    return this.activeAttemptId;
  }

  begin(attemptId: string): void {
    this.activeAttemptId = attemptId;
    this.events = [];
  }

  append(event: SSEEvent): SSEEvent[] {
    if (!this.activeAttemptId) return [event];
    this.events.push(event);
    return [];
  }

  commit(attemptId: string): SSEEvent[] {
    if (!this.matches(attemptId)) return [];
    const committed = this.events;
    this.clear();
    return committed;
  }

  rollback(attemptId: string): boolean {
    if (!this.matches(attemptId)) return false;
    this.clear();
    return true;
  }

  discard(): void {
    this.clear();
  }

  /** Consume attempt boundaries and return only events safe to aggregate. */
  consume(event: SSEEvent): SSEEvent[] {
    const attemptId = String(event.attemptId || '');
    switch (event.type) {
      case SSEEventType.LlmAttemptStart:
        if (attemptId) this.begin(attemptId);
        return [];
      case SSEEventType.LlmAttemptCommit:
        return attemptId ? this.commit(attemptId) : [];
      case SSEEventType.LlmAttemptRollback:
        if (attemptId) this.rollback(attemptId);
        return [];
      default:
        return this.append(event);
    }
  }

  private matches(attemptId: string): boolean {
    return !!attemptId && this.activeAttemptId === attemptId;
  }

  private clear(): void {
    this.activeAttemptId = null;
    this.events = [];
  }
}
