// Shared UI: ToolCardError — compact error card for failed tools.
// Red-accent border + error message with traceback collapsed.

import { ToolCard, type ToolCardState } from './ToolCard.js';

export class ToolCardError extends ToolCard {
  constructor(state: ToolCardState) {
    super(state);
  }

  protected render(s: ToolCardState): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ui-toolcard ui-toolcard-error';

    wrapper.appendChild(this._buildIndicator(s));

    if (s.result) {
      const msg = document.createElement('div');
      msg.className = 'ui-toolcard-error-msg';
      msg.textContent = s.result.slice(0, 300);
      wrapper.appendChild(msg);
    }

    return wrapper;
  }
}
