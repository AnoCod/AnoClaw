// StreamPersister — unified per-event immediate stream persistence
// Writes text_delta / think / tool_call / tool_result events to JSONL
// as independent events as soon as they arrive from the LLM.
// All events in a turn share a single turnMsgId so jsonlEventsToMessages
// accumulates them back into one Message on read.

import { SessionStore } from '../core/session/SessionStore.js';
import { LogManager } from './logging/LogManager.js';

/** Minimal logger interface — only the methods StreamPersister uses */
interface MinimalLogger {
  error(msg: string, data?: Record<string, unknown>): void;
}

export class StreamPersister {
  private _prevUuid: string;
  private store: SessionStore;
  private sessionId: string;
  private turnMsgId: string;
  private logger: MinimalLogger;

  constructor(
    store: SessionStore,
    sessionId: string,
    turnMsgId: string,
    initialPrevUuid: string,
    logger?: MinimalLogger,
  ) {
    this.store = store;
    this.sessionId = sessionId;
    this.turnMsgId = turnMsgId;
    this._prevUuid = initialPrevUuid;
    this.logger = logger || LogManager.getInstance().logger('anochat.core');
  }

  /** The UUID of the most recently persisted event. */
  get prevUuid(): string {
    return this._prevUuid;
  }

  private mkUuid(): string {
    return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private ts(): string {
    return new Date().toISOString();
  }

  /**
   * Persist a single stream event to JSONL immediately — no debounce, no batching.
   *
   * @param evType — 'text' | 'think' | 'tool_call' | 'tool_result'
   * @param payload — extracted fields from the SSE event:
   *   - text/think: { content: string }
   *   - tool_call:  { id: string, name: string, input: Record<string,unknown> }
   *   - tool_result: { toolCallId: string, is_error: boolean, content: string }
   * @returns the new UUID if persisted, or the unchanged prevUuid if evType is unknown
   */
  async persistEvent(
    evType: 'text' | 'think' | 'tool_call' | 'tool_result' | 'todo_write' | 'compacted',
    payload: Record<string, unknown>,
  ): Promise<string> {
    const evUuid = this.mkUuid();
    let jsonlEvent: Record<string, unknown>;

    if (evType === 'text') {
      jsonlEvent = {
        type: 'assistant', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        message: { id: this.turnMsgId, role: 'assistant', content: [{ type: 'text', text: payload.content }] },
      };
    } else if (evType === 'think') {
      jsonlEvent = {
        type: 'assistant', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        message: { id: this.turnMsgId, role: 'assistant', content: [{ type: 'thinking', thinking: payload.content }] },
      };
    } else if (evType === 'tool_call') {
      jsonlEvent = {
        type: 'assistant', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        message: { id: this.turnMsgId, role: 'assistant', content: [{ type: 'tool_use', id: payload.id, name: payload.name, input: payload.input || {} }] },
      };
    } else if (evType === 'tool_result') {
      jsonlEvent = {
        type: 'user', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: payload.toolCallId, content: payload.content, is_error: payload.is_error }] },
      };
    } else if (evType === 'todo_write') {
      jsonlEvent = {
        type: 'todo_write', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        todos: payload.todos || [],
      };
    } else if (evType === 'compacted') {
      jsonlEvent = {
        type: 'compacted', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        summary: payload.summary || '',
        prunedCount: payload.prunedCount || 0,
      };
    } else {
      return this._prevUuid; // unknown event — skip persistence
    }

    await this.store.persistEvent(this.sessionId, jsonlEvent, { skipMetaUpdate: true }).catch(err => {
      this.logger.error('Failed to persist stream event', { sid: this.sessionId, error: (err as Error).message });
    });

    this._prevUuid = evUuid;
    return evUuid;
  }

  // ── Delta buffering (think/text only — tool events flush immediately) ──

  private _textBuffer = '';
  private _thinkBuffer = '';
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Buffer a think/text delta. Flushed on timer or when tool event arrives. */
  bufferDelta(type: 'text' | 'think', content: string): void {
    if (type === 'text') this._textBuffer += content;
    else this._thinkBuffer += content;

    if (this._textBuffer.length + this._thinkBuffer.length >= 500) {
      this._scheduleFlush(true);
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._scheduleFlush(true), 500);
    }
  }

  /** Flush buffered think/text deltas to JSONL. Called before tool events and on turn end. */
  async flushDeltas(): Promise<void> {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._thinkBuffer) {
      await this.persistEvent('think', { content: this._thinkBuffer });
      this._thinkBuffer = '';
    }
    if (this._textBuffer) {
      await this.persistEvent('text', { content: this._textBuffer });
      this._textBuffer = '';
    }
  }

  private _scheduleFlush(immediate: boolean): void {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (immediate) {
      this.flushDeltas().catch(() => {});
    } else {
      this._flushTimer = setTimeout(() => { this.flushDeltas().catch(() => {}); }, 250);
    }
  }
}
