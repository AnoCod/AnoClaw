// Shared UI: ToolCardDiff — compact diff card for Edit/Write tools.
// Shows the file path and a split-view old/new comparison.

import { ToolCard, type ToolCardState } from './ToolCard.js';

export class ToolCardDiff extends ToolCard {
  constructor(state: ToolCardState) {
    super(state);
  }

  protected render(s: ToolCardState): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ui-toolcard ui-toolcard-diff';

    wrapper.appendChild(this._buildIndicator(s));

    const filePath = ((s.toolInput.file_path || s.toolInput.path || '') as string);
    if (filePath) {
      const pathEl = document.createElement('div');
      pathEl.className = 'ui-toolcard-diff-path';
      pathEl.textContent = filePath.replace(/\\/g, '/');
      wrapper.appendChild(pathEl);
    }

    const oldStr = (s.toolInput.old_string || '') as string;
    const newStr = (s.toolInput.new_string || '') as string;
    if (oldStr || newStr) {
      const split = document.createElement('div');
      split.className = 'ui-toolcard-diff-split';

      const oldBox = document.createElement('pre');
      oldBox.className = 'ui-toolcard-diff-old';
      oldBox.textContent = oldStr.slice(0, 300) || '(deleted)';
      split.appendChild(oldBox);

      const newBox = document.createElement('pre');
      newBox.className = 'ui-toolcard-diff-new';
      newBox.textContent = newStr.slice(0, 300) || '(inserted)';
      split.appendChild(newBox);

      wrapper.appendChild(split);
    }

    return wrapper;
  }
}
