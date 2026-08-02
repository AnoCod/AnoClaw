/**
 * PlanIndicator — inline annotation line for plan mode enter/exit.
 * Matches ThinkDelegate visual style: pulse dot · label · description.
 */

import type { PlanEvent } from '../types.js';
import { t } from '../../../i18n/index.js';

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
      color: ${isEnter ? 'var(--cinema-text-muted)' : 'var(--cinema-text-muted)'};
    `;

    // Pulse dot
    const dot = document.createElement('span');
    dot.style.cssText = `
      width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0;
      background: ${isEnter ? '#fff' : 'var(--cinema-text-muted)'};
    `;
    indicator.appendChild(dot);

    // Label
    const label = document.createElement('span');
    const labelKey = isEnter ? 'message.planMode' : 'message.planEnded';
    label.textContent = t(labelKey);
    label.setAttribute('data-i18n-key', labelKey);
    label.style.cssText = `color: ${isEnter ? 'var(--cinema-text-edge)' : 'var(--cinema-text-edge)'};`;
    indicator.appendChild(label);

    // Separator
    const sep = document.createElement('span');
    sep.textContent = '·';
    sep.style.cssText = 'opacity: 0.3;';
    indicator.appendChild(sep);

    // Description
    const desc = document.createElement('span');
    desc.textContent = isEnter
      ? (event.description || event.title || t('message.planExploring'))
      : t('message.planReturning');
    if (!(isEnter && (event.description || event.title))) {
      desc.setAttribute('data-i18n-key', isEnter ? 'message.planExploring' : 'message.planReturning');
    }
    desc.style.cssText = 'letter-spacing: 0;';
    indicator.appendChild(desc);

    wrapper.appendChild(indicator);
    return wrapper;
  }
}
