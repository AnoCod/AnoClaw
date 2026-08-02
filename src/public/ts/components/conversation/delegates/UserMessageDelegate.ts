/**
 * UserMessageDelegate — large editorial user message.
 * 18px, -0.2px letter-spacing, markdown body, minimal label below.
 */

import type { ConversationMessage } from '../types.js';
import { renderMarkdown } from '../../../MarkdownRenderer.js';
import { parseCoordinationEnvelope } from '../CoordinationPresentation.js';
import { CoordinationMessageDelegate } from './CoordinationMessageDelegate.js';
import { getLocale, onLocaleChange, t, type TranslationKey } from '../../../i18n/index.js';

function formatUserMessageTime(timestamp: string | number | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function refreshUserMessageLocale(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-user-message-author-key]').forEach((element) => {
    element.textContent = t(element.dataset.userMessageAuthorKey as TranslationKey);
  });
  root.querySelectorAll<HTMLElement>('[data-user-message-timestamp]').forEach((element) => {
    element.textContent = formatUserMessageTime(element.dataset.userMessageTimestamp);
  });
}

onLocaleChange(() => {
  if (typeof document !== 'undefined') refreshUserMessageLocale(document);
});

export class UserMessageDelegate {
  element: HTMLElement;
  private _msg: ConversationMessage;

  constructor(msg: ConversationMessage) {
    this._msg = msg;
    this.element = this.render();
  }

  render(): HTMLElement {
    const coordination = parseCoordinationEnvelope(this._msg.content);
    if (coordination) {
      return new CoordinationMessageDelegate(this._msg, coordination).element;
    }

    const isSystem = this._msg.role === 'system' || (this._msg as any).agentName?.startsWith('System');

    const block = document.createElement('div');
    block.className = isSystem ? 'cinema-system-block' : 'cinema-user-block';

    const text = document.createElement('div');
    text.className = isSystem ? 'cinema-system-text' : 'cinema-user-text';
    text.innerHTML = renderMarkdown(this._msg.content, { sessionId: this._msg.sessionId });
    block.appendChild(text);

    const label = document.createElement('div');
    label.className = 'cinema-label';
    const time = formatUserMessageTime(this._msg.timestamp);
    const author = document.createElement('span');
    const authorKey = isSystem ? 'message.system' : 'message.you';
    author.textContent = t(authorKey);
    author.setAttribute('data-i18n-key', authorKey);
    author.setAttribute('data-user-message-author-key', authorKey);
    label.appendChild(author);
    if (time) {
      label.append(' · ');
      const timeElement = document.createElement('span');
      timeElement.textContent = time;
      timeElement.setAttribute('data-user-message-timestamp', String(this._msg.timestamp));
      label.appendChild(timeElement);
    }
    block.appendChild(label);

    return block;
  }
}
