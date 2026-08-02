/**
 * AgentMessageDelegate — editorial AI reply block.
 * Left 1px bar, full markdown body with syntax highlighting + images.
 */

import type { ConversationMessage } from '../types.js';
import { renderMarkdown } from '../../../MarkdownRenderer.js';
import { parseInterruptNotice } from '../CoordinationPresentation.js';
import { InterruptNoticeDelegate } from './CoordinationMessageDelegate.js';

export class AgentMessageDelegate {
  element: HTMLElement;
  private _msg: ConversationMessage;

  constructor(msg: ConversationMessage) {
    this._msg = msg;
    this.element = this.render();
  }

  /** Build the editorial block: agent label followed by the markdown body. */
  render(): HTMLElement {
    const interrupt = parseInterruptNotice(this._msg.content || '');
    if (interrupt) {
      return new InterruptNoticeDelegate(this._msg, interrupt).element;
    }

    const block = document.createElement('div');
    block.className = 'cinema-agent-block';

    // Agent label — left-aligned, caps, muted colour
    if (this._msg.agentName) {
      const label = document.createElement('div');
      label.className = 'cinema-label';
      label.textContent = this._msg.agentName;
      label.style.marginBottom = '12px';
      block.appendChild(label);
    }

    // Markdown body — full render with code highlighting and image support
    const body = document.createElement('div');
    body.className = 'cinema-message-body';
    body.innerHTML = renderMarkdown(this._msg.content || '', { sessionId: this._msg.sessionId });
    block.appendChild(body);

    return block;
  }
}
