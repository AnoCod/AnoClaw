// Shared UI: ToolCardResult — structured list card for search/query tools.
// Status dot + tool name + title + bullet list of results.

import { ToolCard, type ToolCardState } from './ToolCard.js';

export class ToolCardResult extends ToolCard {
  private _items: string[];

  constructor(state: ToolCardState) {
    super(state);
    this._items = this._extractItems(state.result || '');
  }

  private _extractItems(raw: string): string[] {
    const lines = raw.split('\n').filter(Boolean);
    // Extract markdown list items or numbered results
    return lines.filter(l => l.trim().startsWith('-') || l.trim().match(/^\d+\./)).map(l => l.replace(/^[\s-]*/, '').slice(0, 200));
  }

  protected render(s: ToolCardState): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ui-toolcard ui-toolcard-result';

    wrapper.appendChild(this._buildIndicator(s));

    if (this._items.length > 0) {
      const list = document.createElement('ul');
      list.className = 'ui-toolcard-result-list';
      for (const item of this._items.slice(0, 15)) {
        const li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
      }
      if (this._items.length > 15) {
        const more = document.createElement('li');
        more.className = 'ui-toolcard-result-more';
        more.textContent = `+ ${this._items.length - 15} more results`;
        list.appendChild(more);
      }
      wrapper.appendChild(list);
    }

    if (this._fullResult) {
      wrapper.appendChild(this._buildBody());
    }

    return wrapper;
  }
}
