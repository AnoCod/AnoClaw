/**
 * DelegationActivityDelegate — inline annotation line for delegation activity.
 * Matches ThinkDelegate visual style: spinner · DELEGATE · activity text.
 */

import { injectStyle } from '../../../utils/domUtils.js';

export interface DelegationActivityEvent {
  id: string;
  type: 'delegation_activity';
  content: string;
  subAgentId?: string;
  subSessionId?: string;
  timestamp: number;
}

export class DelegationActivityDelegate {
  element: HTMLDivElement;
  private _contentEl: HTMLElement;

  constructor(event: DelegationActivityEvent) {
    this.element = document.createElement('div');

    const indicator = document.createElement('div');
    indicator.style.cssText = `
      font-size: 9px; color: var(--cinema-text-muted); letter-spacing: 1px;
      display: flex; gap: 6px; align-items: center;
      user-select: none; margin-bottom: 12px;
    `;

    // Spinner — tiny, inline
    const spinner = document.createElement('span');
    spinner.style.cssText = `
      width: 10px; height: 10px; border: 1.5px solid rgba(167,139,250,0.25);
      border-top-color: rgba(167,139,250,0.5);
      border-radius: 50%; flex-shrink: 0;
      animation: da-spin 1s linear infinite;
    `;
    indicator.appendChild(spinner);

    // Label
    const label = document.createElement('span');
    label.textContent = 'DELEGATE';
    label.style.cssText = 'color: rgba(167,139,250,0.2);';
    indicator.appendChild(label);

    // Separator
    const sep = document.createElement('span');
    sep.textContent = '·';
    sep.style.cssText = 'opacity: 0.3;';
    indicator.appendChild(sep);

    // Content
    this._contentEl = document.createElement('span');
    this._contentEl.textContent = event.content;
    this._contentEl.style.cssText = 'letter-spacing: 0;';
    indicator.appendChild(this._contentEl);

    this.element.appendChild(indicator);
    this._injectStyles();
  }

  update(content: string): void {
    if (this._contentEl.textContent === content) return;
    this._contentEl.textContent = content;
  }

  fadeOut(): void {
    this.element.style.opacity = '0';
    this.element.style.transition = 'opacity 0.3s ease';
    setTimeout(() => this.element.remove(), 300);
  }

  private _injectStyles(): void {
    injectStyle('da-styles', `
      @keyframes da-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    `);
  }
}
