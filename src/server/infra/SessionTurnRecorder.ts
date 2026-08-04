import type { SSEEvent } from '../../shared/types/events.js';
import { SSEEventType } from '../../shared/types/events.js';
import { SessionStore } from '../core/session/SessionStore.js';
import { AttemptEventBuffer } from '../core/agent/AttemptEventBuffer.js';
import { StreamPersister } from './StreamPersister.js';

/**
 * Transport-independent persistence for one assistant turn. Callers forward
 * SSE events however they want, while this recorder guarantees the transcript
 * receives the same semantic event sequence exactly once.
 */
export class SessionTurnRecorder {
  private static readonly activeRecorders = new Set<SessionTurnRecorder>();
  private readonly persister: StreamPersister;
  private readonly attemptBuffer = new AttemptEventBuffer();

  constructor(sessionId: string, agentId: string, turnMessageId?: string) {
    this.persister = new StreamPersister(
      SessionStore.getInstance(),
      sessionId,
      turnMessageId || `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      '00000000-0000-0000-0000-000000000000',
      agentId,
    );
    SessionTurnRecorder.activeRecorders.add(this);
  }

  /** Flush every in-flight recorder during graceful shutdown. */
  static async drainAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...SessionTurnRecorder.activeRecorders].map((recorder) => recorder.finalize()),
    );
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  get headEventUuid(): string {
    return this.persister.prevUuid;
  }

  /** StreamConsumer-compatible delta input. */
  bufferDelta(type: 'text' | 'think', content: string): void {
    const committed = this.attemptBuffer.append({ type, content });
    for (const event of committed) {
      this.persister.bufferDelta(type, String(event.content || ''));
    }
  }

  /** Force buffered text/thinking to disk before an ordered non-delta event. */
  async flushDeltas(): Promise<void> {
    await this.persister.flushDeltas();
  }

  /** Start a provider attempt after all preceding committed deltas are durable. */
  async beginAttempt(attemptId: string): Promise<void> {
    if (!attemptId) return;
    await this.persister.flushDeltas();
    this.attemptBuffer.begin(attemptId);
  }

  /** Persist a successful attempt exactly once, in its original event order. */
  async commitAttempt(attemptId: string): Promise<void> {
    const committed = this.attemptBuffer.commit(attemptId);
    for (const event of committed) {
      await this.persistCommittedEvent(event);
    }
    await this.persister.flushDeltas();
  }

  /** Drop every provisional event from a failed provider attempt. */
  rollbackAttempt(attemptId: string): void {
    this.attemptBuffer.rollback(attemptId);
  }

  async record(event: SSEEvent, errorSource = 'agent_runtime'): Promise<void> {
    const attemptId = String(event.attemptId || '');
    if (event.type === SSEEventType.LlmAttemptStart) {
      await this.beginAttempt(attemptId);
      return;
    }
    if (event.type === SSEEventType.LlmAttemptCommit) {
      await this.commitAttempt(attemptId);
      return;
    }
    if (event.type === SSEEventType.LlmAttemptRollback) {
      this.rollbackAttempt(attemptId);
      return;
    }

    const committed = this.attemptBuffer.append(event);
    for (const committedEvent of committed) {
      await this.persistCommittedEvent(committedEvent, errorSource);
    }
  }

  private async persistCommittedEvent(event: SSEEvent, errorSource = 'agent_runtime'): Promise<void> {
    const raw = event as Record<string, unknown>;
    switch (event.type) {
      case 'text':
        this.persister.bufferDelta('text', String(event.content || ''));
        break;
      case 'think':
        this.persister.bufferDelta('think', String(event.content || ''));
        break;
      case 'tool_call':
        await this.persister.flushDeltas();
        await this.persister.persistEvent('tool_call', {
          id: event.toolCallId || raw.id || event.toolId || '',
          name: event.toolName || raw.name || '',
          input: event.params || raw.args || raw.input || {},
        });
        break;
      case 'tool_result': {
        await this.persister.flushDeltas();
        const structured = raw.structured as Record<string, unknown> | undefined;
        const todos = structured?.todos;
        await this.persister.persistEvent('tool_result', {
          toolCallId: event.toolCallId || event.toolId || '',
          is_error: event.success === false,
          content: event.result || event.content || '',
        });
        if (Array.isArray(todos)) {
          await this.persister.persistEvent('todo_write', { todos });
        }
        break;
      }
      case 'error':
        await this.persister.flushDeltas();
        await this.persister.persistEvent('error', {
          error: event.errorMessage || raw.message || event.content || 'Unknown error',
          source: errorSource,
        });
        break;
      case 'plan_enter':
        await this.persister.flushDeltas();
        await this.persister.persistEvent('plan_enter', {});
        break;
      case 'plan_exit':
        await this.persister.flushDeltas();
        await this.persister.persistEvent('plan_exit', {});
        break;
      default:
        break;
    }
  }

  async recordError(error: string, source: string): Promise<void> {
    this.attemptBuffer.discard();
    await this.persister.flushDeltas();
    await this.persister.persistEvent('error', { error, source });
  }

  async finalize(): Promise<void> {
    this.attemptBuffer.discard();
    await this.persister.finalize();
    SessionTurnRecorder.activeRecorders.delete(this);
  }
}
