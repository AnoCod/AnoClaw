// StarRating — reusable star rating widget (1-5 stars + optional comment)
// Renders clickable star icons, emits on 'rate' when user submits a score.
// Communicates with the backend via WS to persist quality scores.
//
// Usage:
//   const rating = new StarRating(container, { messageId, sessionId, agentId });
//   rating.render();

import { EventEmitter } from '../../EventEmitter.js';
import { ClientLogger } from '../../ClientLogger.js';

export interface StarRatingConfig {
  messageId: string;
  sessionId?: string;
  agentId?: string;
  turnNumber?: number;
  existingScore?: number;
  existingComment?: string;
}

export interface StarRatingData {
  messageId: string;
  sessionId: string;
  agentId: string;
  turnNumber: number;
  score: number;
  comment: string;
}

export class StarRating extends EventEmitter {
  private container: HTMLElement;
  private config: StarRatingConfig;
  private _selectedScore = 0;
  private _comment = '';
  private _submitted = false;
  private _el: HTMLElement | null = null;

  constructor(container: HTMLElement, config: StarRatingConfig) {
    super();
    this.container = container;
    this.config = config;
    this._selectedScore = config.existingScore || 0;
    this._comment = config.existingComment || '';
    this._submitted = !!config.existingScore;
  }

  render(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'star-rating';

    // Star icons
    for (let i = 1; i <= 5; i++) {
      const star = document.createElement('span');
      const isSelected = i <= this._selectedScore;
      star.className = 'star-rating__star' + (isSelected ? ' star-rating__star--selected' : '') + (this._submitted ? ' is-submitted' : '');
      star.textContent = isSelected ? '★' : '☆';
      star.dataset.value = String(i);

      if (!this._submitted) {
        star.addEventListener('mouseenter', () => {
          for (let j = 1; j <= i; j++) {
            const s = el.querySelector(`[data-value="${j}"]`) as HTMLElement;
            if (s) s.classList.add('star-rating__star--hovered');
          }
        });
        star.addEventListener('mouseleave', () => {
          for (let j = 1; j <= 5; j++) {
            const s = el.querySelector(`[data-value="${j}"]`) as HTMLElement;
            if (s) s.classList.remove('star-rating__star--hovered');
          }
        });
        star.addEventListener('click', () => {
          this._selectedScore = i;
          for (let j = 1; j <= 5; j++) {
            const s = el.querySelector(`[data-value="${j}"]`) as HTMLElement;
            if (!s) continue;
            const sel = j <= i;
            s.textContent = sel ? '★' : '☆';
            s.classList.toggle('star-rating__star--selected', sel);
            s.classList.remove('star-rating__star--hovered');
          }
          // Show comment input after star selection
          commentArea.style.display = 'block';
          submitBtn.style.display = this._comment.trim() ? 'inline-block' : 'none';
        });
      }

      el.appendChild(star);
    }

    // Score label
    const label = document.createElement('span');
    label.className = 'star-rating__label';
    label.textContent = this._selectedScore > 0 ? `${this._selectedScore}/5` : 'Rate';
    el.appendChild(label);

    // Comment area (hidden by default, shown after star click)
    const commentArea = document.createElement('div');
    commentArea.className = 'star-rating__comment-area';
    const commentInput = document.createElement('input');
    commentInput.type = 'text';
    commentInput.placeholder = 'Optional comment...';
    commentInput.value = this._comment;
    commentInput.className = 'star-rating__input';
    commentInput.addEventListener('input', () => {
      this._comment = commentInput.value;
      submitBtn.style.display = this._selectedScore > 0 ? 'inline-block' : 'none';
    });
    commentArea.appendChild(commentInput);

    // Submit button
    const submitBtn = document.createElement('button');
    submitBtn.className = 'star-rating__submit';
    submitBtn.textContent = 'Submit';
    submitBtn.addEventListener('click', () => {
      this._submit();
    });
    commentArea.appendChild(submitBtn);

    el.appendChild(commentArea);

    this.container.appendChild(el);
    this._el = el;
    return el;
  }

  private _submit(): void {
    if (this._submitted || this._selectedScore === 0) return;
    this._submitted = true;

    const data: StarRatingData = {
      messageId: this.config.messageId,
      sessionId: this.config.sessionId || '',
      agentId: this.config.agentId || '',
      turnNumber: this.config.turnNumber || 0,
      score: this._selectedScore,
      comment: this._comment,
    };

    this.emit('rate', data as any);

    // Update UI to show submitted state
    if (this._el) {
      const stars = this._el.querySelectorAll('.star-rating__star');
      stars.forEach(s => s.classList.add('is-submitted'));
      const submitBtns = this._el.querySelectorAll('.star-rating__submit');
      submitBtns.forEach(b => { b.classList.add('is-saved'); b.textContent = '✓ Saved'; });
      const inputs = this._el.querySelectorAll('.star-rating__input');
      inputs.forEach(i => (i as HTMLInputElement).disabled = true);
    }

    ClientLogger.ui.info('Rating submitted', data as unknown as Record<string, unknown>);
  }

  destroy(): void {
    if (this._el) {
      this._el.remove();
      this._el = null;
    }
    this.removeAllListeners();
  }
}
