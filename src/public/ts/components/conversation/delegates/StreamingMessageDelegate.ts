/**
 * StreamingMessageDelegate — live-updating markdown agent block.
 * Same 1px bar layout as AgentMessageDelegate, re-renders markdown on each token.
 * Token-by-token rendering: on each streamed token an rAF-gated scheduleRender()
 * batches at most one render per frame to avoid spamming the DOM at LLM output speeds.
 * On stream end, complete() cancels any pending rAF and does a final synchronous render.
 */

import { renderMarkdown } from '../../../MarkdownRenderer.js';

interface StreamingMessage {
  id?: string;
  content?: string;
  agentName?: string;
}

interface StreamingCallbacks {
  onRender?: () => void;
}

export class StreamingMessageDelegate {
  element: HTMLElement;
  private _msg: StreamingMessage;
  private _content: string = '';
  private _body: HTMLElement | null = null;
  private _pending = false;   // true while an rAF render is scheduled
  private _rafId = 0;        // ID for the pending AnimationFrame, 0 if none
  private _lastRenderAt = 0;
  private _callbacks: StreamingCallbacks;
  private static readonly MIN_RENDER_INTERVAL_MS = 33;

  constructor(msg: string | StreamingMessage, callbacks: StreamingCallbacks = {}) {
    // Accept raw string or structured message
    if (typeof msg === 'string') {
      this._msg = { content: msg };
    } else {
      this._msg = msg;
    }
    this._content = this._msg.content || '';
    this._callbacks = callbacks;
    this.element = this.render();
  }

  /** Build the initial block — agent label + markdown body — with data-streaming flag. */
  render(): HTMLElement {
    const block = document.createElement('div');
    block.className = 'cinema-agent-block';
    block.setAttribute('data-streaming', 'true');

    if (this._msg.agentName) {
      const label = document.createElement('div');
      label.className = 'cinema-label';
      label.textContent = this._msg.agentName;
      label.style.marginBottom = '12px';
      block.appendChild(label);
    }

    const body = document.createElement('div');
    body.className = 'cinema-message-body streaming';
    body.innerHTML = renderMarkdown(this._content);
    this._body = body;
    block.appendChild(body);

    return block;
  }

  /** Append a token to the streaming content; throttle markdown re-render to about 30fps. */
  appendToken(token: string): void {
    this._content += token;
    if (this._body) {
      this._scheduleRender();
    }
  }

  /** rAF-gated render: coalesces rapid appends into a single frame update.
   *  Skips the DOM update if the user has an active text selection within
   *  the streaming body — preserves their selection for copy/paste. */
  private _scheduleRender(): void {
    if (this._pending) return;      // already scheduled — skip
    this._pending = true;
    this._rafId = requestAnimationFrame(() => {
      this._pending = false;
      if (!this._body) return;
      const now = performance.now();
      if (now - this._lastRenderAt < StreamingMessageDelegate.MIN_RENDER_INTERVAL_MS) {
        this._scheduleRender();
        return;
      }
      // If user is selecting text within the streaming body, skip this
      // frame to preserve their selection. Content accumulates in _content
      // and renders on the next frame after selection is cleared.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && this._body.contains(sel.anchorNode)) {
        // Re-schedule: try again next frame
        this._scheduleRender();
        return;
      }
      this._lastRenderAt = now;
      this._body.innerHTML = renderMarkdown(this._content);
      this._callbacks.onRender?.();
    });
  }

  /** Replace entire streaming text immediately (no rAF throttle) — used for compact mode restore. */
  replaceContent(container: HTMLElement, text: string): void {
    this._content = text;
    if (this._body) {
      this._body.innerHTML = renderMarkdown(this._content);
      this._callbacks.onRender?.();
    }
  }

  /** Set fresh content, re-render synchronously — used when a new text segment starts. */
  setContent(text: string): void {
    this._content = text;
    if (this._body) {
      this._body.innerHTML = renderMarkdown(this._content);
      this._callbacks.onRender?.();
    }
  }

  /** Stream ended — cancel any pending rAF and do one final synchronous markdown render. */
  complete(): void {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
      this._pending = false;
    }
    if (this._body) {
      this._lastRenderAt = performance.now();
      this._body.innerHTML = renderMarkdown(this._content);
      this._callbacks.onRender?.();
    }
  }
}
