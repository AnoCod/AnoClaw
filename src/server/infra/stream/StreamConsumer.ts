// StreamConsumer — sits between the agent loop and WebSocket transport
// Buffers text/think deltas, flushes on timer or on buffer threshold (default 1 = per-token).
// Fresh-final signal after 30s continuous streaming to prevent stale cursor.
//
// Agent loop yield event → StreamConsumer → buffer + flush timer → Transport.send()

import type { Transport } from '../network/Transport.js';

export interface StreamConsumerOptions {
  /** Max interval between flushes (ms). Default 20 — fast enough for per-token feel. */
  editIntervalMs?: number;
  /** Char threshold to trigger immediate flush. Default 1 = flush every token. */
  bufferThreshold?: number;
  /** After this many ms of continuous streaming, signal a fresh-final message. Default 30000. */
  freshFinalAfterMs?: number;
}

export class StreamConsumer {
  private _textBuffer = '';
  private _thinkBuffer = '';
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _firstTokenAt = 0;
  private _freshFinalSent = false;
  private _options: Required<StreamConsumerOptions>;
  private _persister: { bufferDelta: (type: 'text' | 'think', content: string) => void; flushDeltas: () => Promise<void> };

  constructor(
    private _transport: Transport,
    private _sessionId: string,
    persister: { bufferDelta: (type: 'text' | 'think', content: string) => void; flushDeltas: () => Promise<void> },
    options?: StreamConsumerOptions,
  ) {
    this._options = {
      editIntervalMs: options?.editIntervalMs ?? 20,
      bufferThreshold: options?.bufferThreshold ?? 1,
      freshFinalAfterMs: options?.freshFinalAfterMs ?? 30000,
    };
    this._persister = persister;
  }

  /** Called on each text/think delta from the agent loop. */
  onDelta(type: 'text' | 'think', content: string): void {
    if (type === 'text') this._textBuffer += content;
    else this._thinkBuffer += content;

    // Track start for fresh-final detection
    if (this._firstTokenAt === 0) this._firstTokenAt = Date.now();

    // Trigger flush: either buffer exceeded threshold, or schedule timer
    if (this._textBuffer.length >= this._options.bufferThreshold) {
      this._flush();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flush(), this._options.editIntervalMs);
    }
  }

  /** Flush buffered text/think to transport + persister. */
  private _flush(): void {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }

    // Fresh-final check: if streaming for too long, signal frontend to start a new message
    const elapsed = this._firstTokenAt > 0 ? Date.now() - this._firstTokenAt : 0;
    const isFreshFinal = elapsed >= this._options.freshFinalAfterMs && !this._freshFinalSent;

    // Send text
    if (this._textBuffer) {
      this._transport.send(this._sessionId, {
        type: 'text',
        content: this._textBuffer,
        ...(isFreshFinal ? { freshFinal: true } : {}),
      });
      this._persister.bufferDelta('text', this._textBuffer);
      this._textBuffer = '';
    }

    // Send think
    if (this._thinkBuffer) {
      this._transport.send(this._sessionId, {
        type: 'think',
        content: this._thinkBuffer,
      });
      this._persister.bufferDelta('think', this._thinkBuffer);
      this._thinkBuffer = '';
    }

    if (isFreshFinal) {
      this._freshFinalSent = true;
      // Next tokens start a new message cycle
    }
  }

  /** Called before tool events — flush deltas so tool events arrive after the text. */
  async beforeToolEvent(): Promise<void> {
    this._flush();
    await this._persister.flushDeltas();
  }

  /** Send a non-delta event directly (tool_call, tool_result, done, error, etc.). */
  sendDirect(event: Record<string, unknown>): void {
    this._flush();
    this._transport.send(this._sessionId, event);
  }

  /** Flush everything on turn end and persist remaining deltas. */
  async flushAndFinalize(): Promise<void> {
    this._flush();
    await this._persister.flushDeltas();
  }
}
