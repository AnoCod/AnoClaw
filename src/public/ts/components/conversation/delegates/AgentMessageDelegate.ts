// AnoClaw Cinema — AgentMessageDelegate: editorial AI reply block
// Left 1px bar, full markdown body with syntax highlighting + images.
// Footer includes StarRating widget for quality feedback.
// Star ratings are suppressed for system notifications — interrupt messages,
// halt markers ("Halted."), and ultra-short content — to avoid prompting
// the user to rate non-substantive system output.

import type { Message } from '../types.js';
import { renderMarkdown } from '../../../MarkdownRenderer.js';
import { StarRating } from '../../evolution/StarRating.js';
import { App } from '../../../app.js';

export class AgentMessageDelegate {
  element: HTMLElement;
  private _msg: Message;

  constructor(msg: Message) {
    this._msg = msg;
    this.element = this.render();
  }

  /** Build the editorial block: agent label → markdown body → star rating footer. */
  render(): HTMLElement {
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
    body.innerHTML = renderMarkdown(this._msg.content || '');
    block.appendChild(body);

    // Star rating footer — skip for system notifications and trivial content
    // to avoid asking the user to rate "Halted." or interrupt messages
    const content = this._msg.content || '';
    const isSystemNotification = content.includes('[Request interrupted') || content === 'Halted.' || content.length < 10;
    if (!isSystemNotification) {
      const footer = document.createElement('div');
      footer.className = 'star-rating__footer';
      const app = App.getInstance();
      const starRating = new StarRating(footer, {
        messageId: this._msg.id || `msg-${Date.now()}`,
        sessionId: app.sessionVM.activeSession?.id || '',
        agentId: this._msg.agentId || '',
        turnNumber: 0,
      });
      // Wire star-click → quality-score WS message
      starRating.on('rate', (data: Record<string, unknown>) => {
        app.sendQualityScore({
          messageId: data.messageId as string,
          sessionId: data.sessionId as string,
          agentId: data.agentId as string,
          turnNumber: data.turnNumber as number,
          score: data.score as number,
          comment: data.comment as string,
        });
      });
      starRating.render();
      block.appendChild(footer);
    }

    return block;
  }
}
