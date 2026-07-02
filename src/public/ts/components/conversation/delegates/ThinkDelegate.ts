// AnoClaw Cinema — ThinkDelegate: pulse indicator, click to expand/collapse
// Shows "THINKING · X.Xs" with an animated dot while the agent is reasoning.
// While running (status 'pending' or _running flag), the body starts expanded so
// the user sees live thought output. When done, it collapses — click the header
// line to toggle the think body content on/off.

import type { ThinkEvent } from '../types.js';

export class ThinkDelegate {
  element: HTMLElement;
  private _msg: ThinkEvent;
  private _expanded = false;       // current toggle state
  private _bodyEl: HTMLElement | null = null;
  private _running: boolean;

  constructor(msg: ThinkEvent) {
    this._msg = msg;
    // Still running if pending or flagged as _running by the VM
    this._running = (msg as any).status === 'pending' || (msg as any)._running === true;
    this._expanded = this._running;   // auto-expand while thinking
    this.element = this.render();
  }

  /** Build the think card: indicator header line + collapsible body. */
  render(): HTMLElement {
    const wrapper = document.createElement('div');

    // ── Header: pulse dot + "THINKING · X.Xs" label ──
    const indicator = document.createElement('div');
    indicator.className = 'cinema-think-indicator';

    const dot = document.createElement('span');
    dot.className = 'cinema-pulse-dot';
    // Freeze the pulse animation when thinking is complete
    if (!this._running) {
      dot.style.animation = 'none';
      dot.style.opacity = '0.3';
    }
    indicator.appendChild(dot);

    const label = document.createElement('span');
    const durationMs = (this._msg as any).durationMs as number | undefined;
    const durText = durationMs
      ? `${(durationMs / 1000).toFixed(1)}s`
      : '';
    label.textContent = durText ? `THINKING · ${durText}` : 'THINKING';
    indicator.appendChild(label);

    // Click header to toggle body visibility
    indicator.addEventListener('click', () => {
      this._expanded = !this._expanded;
      if (this._bodyEl) {
        this._bodyEl.hidden = !this._expanded;
      }
    });

    wrapper.appendChild(indicator);

    // ── Body: think content, visible only when expanded ──
    this._bodyEl = document.createElement('div');
    this._bodyEl.className = 'cinema-think-body';
    this._bodyEl.hidden = !this._expanded;
    this._bodyEl.textContent = this._msg.content;
    wrapper.appendChild(this._bodyEl);

    return wrapper;
  }
}
