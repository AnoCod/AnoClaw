/**
 * PlanIndicator — inline annotation line for plan mode enter/exit.
 * Matches ThinkDelegate visual style: pulse dot · label · description.
 */

import type { PlanEvent } from '../types.js';

export class PlanIndicator {
  element: HTMLElement;

  constructor(event: PlanEvent) {
    this.element = this.render(event);
  }

  render(event: PlanEvent): HTMLElement {
    const isEnter = event.type === 'plan_enter';
    const wrapper = document.createElement('div');

    const indicator = document.createElement('div');
    indicator.style.cssText = `
      font-size: 9px; letter-spacing: 1px;
      display: flex; gap: 6px; align-items: center;
      user-select: none; margin-bottom: 12px;
      color: ${isEnter ? 'rgba(167,139,250,0.3)' : 'var(--cinema-text-muted)'};
    `;

    // Pulse dot
    const dot = document.createElement('span');
    dot.style.cssText = `
      width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0;
      background: ${isEnter ? 'rgba(167,139,250,0.4)' : 'var(--cinema-text-muted)'};
    `;
    indicator.appendChild(dot);

    // Label
    const label = document.createElement('span');
    label.textContent = isEnter ? 'PLAN MODE' : 'PLAN ENDED';
    label.style.cssText = `color: ${isEnter ? 'rgba(167,139,250,0.25)' : 'var(--cinema-text-edge)'};`;
    indicator.appendChild(label);

    // Separator
    const sep = document.createElement('span');
    sep.textContent = '·';
    sep.style.cssText = 'opacity: 0.3;';
    indicator.appendChild(sep);

    // Description
    const desc = document.createElement('span');
    desc.textContent = isEnter
      ? (event.description || event.title || 'Exploring before editing')
      : 'Returning to execution';
    desc.style.cssText = 'letter-spacing: 0;';
    indicator.appendChild(desc);

    wrapper.appendChild(indicator);
    return wrapper;
  }
}
