

import type { ThinkEvent } from '../types.js';
import { t } from '../../../i18n/index.js';

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
    const labelKey = durText ? 'message.thinkingDuration' : 'message.thinking';
    label.textContent = t(labelKey, { duration: durText });
    label.setAttribute('data-i18n-key', labelKey);
    if (durText) label.setAttribute('data-i18n-params', JSON.stringify({ duration: durText }));
    indicator.appendChild(label);

    // Click header to toggle body visibility
    indicator.addEventListener('click', () => {
      this._expanded = !this._expanded;
      if (this._bodyEl) {
        this._bodyEl.hidden = !this._expanded;
      }
    });

    wrapper.appendChild(indicator);


    this._bodyEl = document.createElement('div');
    this._bodyEl.className = 'cinema-think-body';
    this._bodyEl.hidden = !this._expanded;
    this._bodyEl.textContent = this._msg.content;
    wrapper.appendChild(this._bodyEl);

    return wrapper;
  }

  /** Update in-place: refresh content text, duration label, and dot animation. */
  update(msg: any): void {
    this._msg = msg;
    this._running = msg.status === 'pending' || msg._running === true;
    // Update body content
    if (this._bodyEl) {
      this._bodyEl.textContent = msg.content || '';
    }
    // Update duration label
    const labelEl = this.element.querySelector('.cinema-think-indicator span:last-child') as HTMLElement | null;
    if (labelEl && msg.durationMs) {
      const duration = `${((msg.durationMs as number) / 1000).toFixed(1)}s`;
      labelEl.textContent = t('message.thinkingDuration', { duration });
      labelEl.setAttribute('data-i18n-key', 'message.thinkingDuration');
      labelEl.setAttribute('data-i18n-params', JSON.stringify({ duration }));
    }
    // Freeze dot when done
    if (!this._running) {
      this._expanded = false;
      if (this._bodyEl) this._bodyEl.hidden = true;
      const dot = this.element.querySelector('.cinema-pulse-dot') as HTMLElement | null;
      if (dot) { dot.style.animation = 'none'; dot.style.opacity = '0.3'; }
    } else {
      this._expanded = true;
      if (this._bodyEl) this._bodyEl.hidden = false;
    }
  }
  collapse(): void {
    this._expanded = false;
    if (this._bodyEl) this._bodyEl.hidden = true;
  }

  expand(): void {
    this._expanded = true;
    if (this._bodyEl) this._bodyEl.hidden = false;
  }
}

