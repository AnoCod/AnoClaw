// AnoClaw Cinema — UserMessageDelegate: large editorial user message
// 18px, -0.2px letter-spacing, markdown body, minimal label below.

import type { Message } from '../types.js';
import { renderMarkdown } from '../../../MarkdownRenderer.js';

export class UserMessageDelegate {
  element: HTMLElement;
  private _msg: Message;

  constructor(msg: Message) {
    this._msg = msg;
    this.element = this.render();
  }

  render(): HTMLElement {
    const isSystem = (this._msg as any).agentName?.startsWith('System');

    const block = document.createElement('div');
    block.className = isSystem ? 'cinema-system-block' : 'cinema-user-block';

    const text = document.createElement('div');
    text.className = isSystem ? 'cinema-system-text' : 'cinema-user-text';
    text.innerHTML = renderMarkdown(this._msg.content);
    block.appendChild(text);

    const label = document.createElement('div');
    label.className = 'cinema-label';
    const time = this._msg.timestamp
      ? new Date(this._msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    label.textContent = isSystem ? `SYSTEM${time ? ` · ${time}` : ''}` : `YOU${time ? ` · ${time}` : ''}`;
    block.appendChild(label);

    return block;
  }
}
