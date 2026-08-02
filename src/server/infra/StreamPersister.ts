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
  private agentId: string;
  private logger: MinimalLogger;
  private _initialized = false;
  private _hasAssistantContent = false;
  private _finalized = false;
  private _finalizePromise: Promise<void> | null = null;

  constructor(
    store: SessionStore,
    sessionId: string,
    turnMsgId: string,
    initialPrevUuid: string,
    agentId: string = '',
    logger?: MinimalLogger,
  ) {
    this.store = store;
    this.sessionId = sessionId;
    this.turnMsgId = turnMsgId;
    this.agentId = agentId;
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
    evType: 'text' | 'think' | 'tool_call' | 'tool_result' | 'todo_write' | 'compacted' | 'error' | 'plan_enter' | 'plan_exit',
    payload: Record<string, unknown>,
  ): Promise<string> {
    await this.ensureInitialized();
    const evUuid = this.mkUuid();
    let jsonlEvent: Record<string, unknown>;

    if (evType === 'text') {
      this._hasAssistantContent = true;
      jsonlEvent = {
        type: 'assistant', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        message: { id: this.turnMsgId, role: 'assistant', content: [{ type: 'text', text: payload.content }] },
        agentId: this.agentId || undefined,
      };
    } else if (evType === 'think') {
      this._hasAssistantContent = true;
      jsonlEvent = {
        type: 'assistant', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        message: { id: this.turnMsgId, role: 'assistant', content: [{ type: 'thinking', thinking: payload.content }] },
        agentId: this.agentId || undefined,
      };
    } else if (evType === 'tool_call') {
      this._hasAssistantContent = true;
      jsonlEvent = {
        type: 'assistant', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        message: { id: this.turnMsgId, role: 'assistant', content: [{ type: 'tool_use', id: payload.id, name: payload.name, input: payload.input || {} }] },
        agentId: this.agentId || undefined,
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
        type: 'compaction', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        summary: payload.summary || '',
        prunedCount: payload.prunedCount || 0,
      };
    } else if (evType === 'error') {
      jsonlEvent = {
        type: 'error', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
        error: payload.error || payload.errorMessage || payload.message || payload.content || 'unknown',
        source: payload.source || 'stream',
      };
    } else if (evType === 'plan_enter') {
      jsonlEvent = {
        type: 'plan_enter', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
      };
    } else if (evType === 'plan_exit') {
      jsonlEvent = {
        type: 'plan_exit', uuid: evUuid, parentUuid: this._prevUuid,
        sessionId: this.sessionId, timestamp: this.ts(),
      };
    } else {
      return this._prevUuid; // unknown event — skip persistence
    }

    try {
      const persistedHead = await this.store.persistEvent(
        this.sessionId,
        jsonlEvent,
        { skipMetaUpdate: true, sync: true },
      );
      this._prevUuid = persistedHead || evUuid;
    } catch (err) {
      this.logger.error('Failed to persist stream event', { sid: this.sessionId, error: (err as Error).message });
      throw err;
    }

    return this._prevUuid;
  }

  private async ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    const durableHead = await this.store.loadHeadEventUuid(this.sessionId);
    if (durableHead) this._prevUuid = durableHead;
    this._initialized = true;
  }

  // ── Delta buffering (think/text only — tool events flush immediately) ──

  private _textBuffer = '';
  private _thinkBuffer = '';
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes timer/tool/final drains so overlapping flushes cannot race. */
  private _flushChain: Promise<void> = Promise.resolve();

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
    const flush = this._flushChain.then(() => this._drainDeltaBuffers());
    // Keep the internal chain usable after a failed write while returning the
    // original promise so explicit callers still observe the failure.
    this._flushChain = flush.catch(() => {});
    return flush;
  }

  /** Finalize one streamed assistant turn and update its logical message count once. */
  async finalize(): Promise<void> {
    if (this._finalized) return;
    if (this._finalizePromise) return this._finalizePromise;
    const attempt = (async () => {
      await this.flushDeltas();
      if (this._hasAssistantContent) {
        await this.store.incrementMessageCount(this.sessionId);
      }
      this._finalized = true;
    })();
    this._finalizePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this._finalizePromise === attempt) this._finalizePromise = null;
      throw error;
    }
  }

  /** Snapshot buffers before awaiting I/O; requeue failed chunks ahead of newer deltas. */
  private async _drainDeltaBuffers(): Promise<void> {
    const think = this._thinkBuffer;
    const text = this._textBuffer;
    this._thinkBuffer = '';
    this._textBuffer = '';

    if (think) {
      try {
        await this.persistEvent('think', { content: think });
      } catch (err) {
        this._thinkBuffer = think + this._thinkBuffer;
        this._textBuffer = text + this._textBuffer;
        throw err;
      }
    }
    if (text) {
      try {
        await this.persistEvent('text', { content: text });
      } catch (err) {
        this._textBuffer = text + this._textBuffer;
        throw err;
      }
    }
  }

  private _scheduleFlush(immediate: boolean): void {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (immediate) {
      this.flushDeltas().catch((err) => {
        this.logger.error('Failed to flush stream deltas', { sid: this.sessionId, error: (err as Error).message });
      });
    } else {
      this._flushTimer = setTimeout(() => {
        this.flushDeltas().catch((err) => {
          this.logger.error('Failed to flush stream deltas', { sid: this.sessionId, error: (err as Error).message });
        });
      }, 250);
    }
  }
}
