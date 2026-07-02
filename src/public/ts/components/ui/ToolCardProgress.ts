// Shared UI: ToolCardProgress — progress bar card for long-running tools.
// Shows a determinate or indeterminate progress bar + percentage.

import { ToolCard, type ToolCardState } from './ToolCard.js';

export class ToolCardProgress extends ToolCard {
  private _percent: number;

  constructor(state: ToolCardState) {
    super(state);
    this._percent = this._extractPercent(state.result || '');
  }

  private _extractPercent(raw: string): number {
    const pct = raw.match(/(\d{1,3})%/);
    return pct ? Math.min(100, Math.max(0, parseInt(pct[1], 10))) : -1; // -1 = indeterminate
  }

  protected render(s: ToolCardState): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ui-toolcard ui-toolcard-progress';

    wrapper.appendChild(this._buildIndicator(s));

    const barOuter = document.createElement('div');
    barOuter.className = 'ui-toolcard-progress-track';

    const barInner = document.createElement('div');
    barInner.className = `ui-toolcard-progress-fill ${this._percent < 0 ? 'indeterminate' : ''}`;
    if (this._percent >= 0) barInner.style.width = `${this._percent}%`;
    barOuter.appendChild(barInner);

    wrapper.appendChild(barOuter);

    if (this._percent >= 0) {
      const label = document.createElement('div');
      label.className = 'ui-toolcard-progress-label';
      label.textContent = `${this._percent}%`;
      wrapper.appendChild(label);
    }

    return wrapper;
  }
}
