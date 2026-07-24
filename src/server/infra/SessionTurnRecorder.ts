import type { SSEEvent } from '../../shared/types/events.js';
import { SessionStore } from '../core/session/SessionStore.js';
import { StreamPersister } from './StreamPersister.js';

/**
 * Transport-independent persistence for one assistant turn. Callers forward
 * SSE events however they want, while this recorder guarantees the transcript
 * receives the same semantic event sequence exactly once.
 */
export class SessionTurnRecorder {
  private static readonly activeRecorders = new Set<SessionTurnRecorder>();
  private readonly persister: StreamPersister;

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
    this.persister.bufferDelta(type, content);
  }

  /** Force buffered text/thinking to disk before an ordered non-delta event. */
  async flushDeltas(): Promise<void> {
    await this.persister.flushDeltas();
  }

  async record(event: SSEEvent, errorSource = 'agent_runtime'): Promise<void> {
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
    await this.persister.flushDeltas();
    await this.persister.persistEvent('error', { error, source });
  }

  async finalize(): Promise<void> {
    await this.persister.finalize();
    SessionTurnRecorder.activeRecorders.delete(this);
  }
}
