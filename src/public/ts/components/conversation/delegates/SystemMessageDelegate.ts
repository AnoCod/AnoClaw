// AnoClaw Cinema — SystemMessageDelegate: centered annotation line
// Matches cinema style: no border, no background, just low-opacity text

import type { SystemMessageEvent } from '../types.js';

export class SystemMessageDelegate {
  element: HTMLElement;

  constructor(event: SystemMessageEvent) {
    this.element = this.render(event);
  }

  render(event: SystemMessageEvent): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      display: flex; justify-content: center; margin-bottom: 12px;
    `;

    const level = event.level || 'info';
    const colors: Record<string, string> = {
      info:    'var(--cinema-text-muted)',
      warning: 'rgba(251,191,36,0.3)',
      error:   'rgba(248,113,113,0.3)',
    };

    const msg = document.createElement('span');
    msg.textContent = event.content;
    msg.style.cssText = `
      font-size: 10px; color: ${colors[level] || colors.info};
      text-align: center; line-height: 1.6;
      max-width: 80%;
    `;

    wrapper.appendChild(msg);
    return wrapper;
  }
}
