/**
 * AskUserQuestion interactive card.
 * Noticeable enough for pending questions while matching the workbench skin.
 */
import type { Message } from '../../types.js';
import { t } from '../../i18n/index.js';

export class AskUserQuestionCard {
  static refreshLocale(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>('.aq-title').forEach((el) => { el.textContent = t('askUser.title'); });
    root.querySelectorAll<HTMLElement>('.aq-empty').forEach((el) => { el.textContent = t('askUser.none'); });
    root.querySelectorAll<HTMLButtonElement>('.aq-confirm-btn').forEach((el) => { el.textContent = t('askUser.confirm'); });
    root.querySelectorAll<HTMLInputElement>('.aq-answer-input').forEach((el) => { el.placeholder = t('askUser.answerPlaceholder'); });
    root.querySelectorAll<HTMLButtonElement>('.aq-submit-btn').forEach((el) => { el.textContent = t('askUser.submit'); });
    root.querySelectorAll<HTMLElement>('.aq-badge').forEach((el) => {
      const answered = Number(el.dataset.answered || 0);
      const total = Number(el.dataset.total || 0);
      el.textContent = t(el.dataset.complete === 'true' ? 'askUser.answeredComplete' : 'askUser.answeredPartial', { answered, total });
    });
    root.querySelectorAll<HTMLElement>('.aq-error[data-local-error="send-failed"]').forEach((el) => {
      el.textContent = t('askUser.sendFailed');
    });
  }

  static build(
    msg: Message,
    answeredIndices: Map<string, Set<number>>,
    onSendAnswer: (answer: string) => Promise<boolean>,
  ): HTMLElement {
    const questions = (msg.toolInput as any)?.questions || [];
    if (msg.status !== 'pending' && !answeredIndices.has(msg.id)) {
      answeredIndices.set(msg.id, new Set(questions.map((_: unknown, index: number) => index)));
    }
    const indices = answeredIndices.get(msg.id) || new Set();
    const pendingAnswers = new Map<number, string>();
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      margin-bottom: 12px;
      border: 1px solid var(--color-hairline, #242728);
      border-radius: 8px;
      background: var(--color-surface, #0d0d0d);
      overflow: hidden;
    `;
    wrapper.setAttribute('data-tool-type', 'askuserquestion');
    wrapper.setAttribute('data-ask-msg-id', msg.id);

    AskUserQuestionCard._buildHeader(wrapper, msg, indices);
    AskUserQuestionCard._buildBody(wrapper, msg, indices, answeredIndices, onSendAnswer, pendingAnswers);
    return wrapper;
  }

  private static _buildHeader(
    wrapper: HTMLElement,
    msg: Message,
    indices: Set<number>,
  ): void {
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      font-size: 10px; color: var(--color-text-secondary, #9c9c9d);
      letter-spacing: 0.4px; text-transform: uppercase;
    `;

    // Dot
    const dot = document.createElement('span');
    dot.style.cssText = `width:4px;height:4px;border-radius:50%;flex-shrink:0;background:var(--color-info, #57c1ff);`;
    header.appendChild(dot);

    const title = document.createElement('span');
    title.className = 'aq-title';
    title.textContent = t('askUser.title');
    title.style.cssText = 'flex:1;';
    header.appendChild(title);

    const questions = (msg.toolInput as any)?.questions || [];
    if (questions.length > 0 && indices.size >= questions.length) {
      header.appendChild(AskUserQuestionCard._badge(indices.size, questions.length, true));
    } else if (indices.size > 0) {
      header.appendChild(AskUserQuestionCard._badge(indices.size, questions.length, false));
    }
    wrapper.appendChild(header);
  }

  private static _buildBody(
    wrapper: HTMLElement,
    msg: Message,
    indices: Set<number>,
    answeredIndices: Map<string, Set<number>>,
    onSendAnswer: (answer: string) => Promise<boolean>,
    pendingAnswers: Map<number, string>,
  ): void {
    const body = document.createElement('div');
    body.style.cssText = 'padding: 6px 14px 14px;';

    const questions: any[] = (msg.toolInput as any)?.questions || [];
    if (questions.length === 0) {
      const p = document.createElement('p');
      p.className = 'aq-empty';
      p.textContent = t('askUser.none');
      p.style.cssText = 'color: rgba(255,255,255,0.2); font-size: 12px; margin: 0;';
      body.appendChild(p);
      wrapper.appendChild(body);
      return;
    }

    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const qAnswered = indices.has(qi);
      const qBlock = document.createElement('div');
      qBlock.setAttribute('data-ask-qi', String(qi));
      if (qi > 0) qBlock.style.marginTop = '16px';
      if (qAnswered) qBlock.style.opacity = '0.45';

      if (q.header) {
        const hdr = document.createElement('div');
        hdr.style.cssText = `
          font-size: 10px; font-weight: 600;
          color: var(--color-text-secondary, #9c9c9d); text-transform: uppercase;
          letter-spacing: 0.4px; margin-bottom: 4px;
          display: flex; align-items: center; gap: 6px;
        `;
        hdr.textContent = q.header;
        if (qAnswered) {
          const check = document.createElement('span');
          check.innerHTML = '&#10003;';
          check.style.cssText = 'color: var(--color-success, #00cd72); font-size: 11px;';
          hdr.appendChild(check);
        }
        qBlock.appendChild(hdr);
      }

      const qText = document.createElement('p');
      qText.textContent = q.question || '';
      qText.style.cssText = `
        color: rgba(255,255,255,0.6); font-size: 13px; line-height: 1.5;
        margin: 0 0 10px 0;
      `;
      qBlock.appendChild(qText);

      const options: string[] = q.options || [];
      if (options.length > 0) {
        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';
        const multiSelect = q.multiSelect === true && !qAnswered;

        if (multiSelect) {
          const selectedOptions = new Set<string>();
          for (const opt of options) {
            const btn = AskUserQuestionCard._optionBtn(opt, false, () => {
              if (selectedOptions.has(opt)) {
                selectedOptions.delete(opt);
                btn.removeAttribute('data-selected');
                btn.style.background = 'var(--color-surface-elevated, #101111)';
                btn.style.color = 'var(--color-text-secondary, #cdcdcd)';
                btn.style.borderColor = 'var(--color-hairline, #242728)';
              } else {
                selectedOptions.add(opt);
                btn.setAttribute('data-selected', '1');
                btn.style.background = 'var(--color-primary, #0b8ce9)';
                btn.style.color = 'var(--color-on-primary, #fff)';
                btn.style.borderColor = 'var(--color-primary, #0b8ce9)';
              }
            });
            btnGroup.appendChild(btn);
          }
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'aq-confirm-btn';
          confirmBtn.textContent = t('askUser.confirm');
          confirmBtn.style.cssText = `
            padding: 6px 16px; font-size: 12px; cursor: pointer;
            border: 1px solid var(--color-primary, #0b8ce9);
            background: var(--color-primary, #0b8ce9);
            color: var(--color-on-primary, #fff);
            border-radius: 4px; font-family: var(--font-sans); font-weight: 600;
          `;
          confirmBtn.addEventListener('click', () => {
            if (selectedOptions.size === 0) return;
            const answer = Array.from(selectedOptions).join(', ');
            pendingAnswers.set(qi, answer);
            AskUserQuestionCard._record(answeredIndices, msg.id, qi);
            AskUserQuestionCard._disableBlock(qBlock);
            AskUserQuestionCard._updateBadge(wrapper, msg, answeredIndices);
            void AskUserQuestionCard._maybeSend(wrapper, questions, pendingAnswers, answeredIndices, msg, onSendAnswer);
          });
          btnGroup.appendChild(confirmBtn);
        } else {
          for (const opt of options) {
            const btn = AskUserQuestionCard._optionBtn(opt, false, () => {
              pendingAnswers.set(qi, opt);
              AskUserQuestionCard._record(answeredIndices, msg.id, qi);
              AskUserQuestionCard._disableBlock(qBlock);
              AskUserQuestionCard._updateBadge(wrapper, msg, answeredIndices);
              void AskUserQuestionCard._maybeSend(wrapper, questions, pendingAnswers, answeredIndices, msg, onSendAnswer);
            });
            btnGroup.appendChild(btn);
          }
        }
        qBlock.appendChild(btnGroup);
      } else {
        const inputRow = document.createElement('div');
        inputRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
        const input = document.createElement('input');
        input.className = 'aq-answer-input';
        input.type = 'text';
        input.placeholder = t('askUser.answerPlaceholder');
        input.style.cssText = `
          flex:1;min-width:0;padding:7px 9px;border-radius:4px;
          border:1px solid var(--color-hairline, #242728);
          background:var(--color-surface-elevated, #101111);
          color:var(--color-text-primary, #fff);font:12px var(--font-sans);
        `;
        const submit = document.createElement('button');
        submit.className = 'aq-submit-btn';
        submit.textContent = t('askUser.submit');
        submit.style.cssText = `
          padding:7px 12px;border-radius:4px;cursor:pointer;
          border:1px solid var(--color-primary, #0b8ce9);
          background:var(--color-primary, #0b8ce9);color:var(--color-on-primary, #fff);
          font:600 12px var(--font-sans);
        `;
        const commitText = () => {
          const answer = input.value.trim();
          if (!answer) return;
          pendingAnswers.set(qi, answer);
          AskUserQuestionCard._record(answeredIndices, msg.id, qi);
          AskUserQuestionCard._disableBlock(qBlock);
          AskUserQuestionCard._updateBadge(wrapper, msg, answeredIndices);
          void AskUserQuestionCard._maybeSend(wrapper, questions, pendingAnswers, answeredIndices, msg, onSendAnswer);
        };
        submit.addEventListener('click', commitText);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitText();
          }
        });
        inputRow.appendChild(input);
        inputRow.appendChild(submit);
        qBlock.appendChild(inputRow);
      }

      if (qAnswered) AskUserQuestionCard._disableBlock(qBlock);
      body.appendChild(qBlock);
    }
    wrapper.appendChild(body);
  }

  private static async _maybeSend(
    wrapper: HTMLElement,
    questions: any[],
    pendingAnswers: Map<number, string>,
    answeredIndices: Map<string, Set<number>>,
    msg: Message,
    onSendAnswer: (answer: string) => Promise<boolean>,
  ): Promise<void> {
    const indices = answeredIndices.get(msg.id);
    if (!indices || indices.size < questions.length) return;
    if (wrapper.dataset.sending === '1') return;

    let answer: string;
    if (questions.length === 1) {
      answer = pendingAnswers.get(0) || '';
    } else {
      const parts: string[] = [];
      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        const header = q?.header || `Q${qi + 1}`;
        parts.push(`${header}: ${pendingAnswers.get(qi) || ''}`);
      }
      answer = parts.join('\n');
    }

    wrapper.dataset.sending = '1';
    AskUserQuestionCard._setError(wrapper, '');
    const sent = await onSendAnswer(answer);
    delete wrapper.dataset.sending;
    if (sent) return;

    answeredIndices.delete(msg.id);
    for (const block of Array.from(wrapper.querySelectorAll<HTMLElement>('[data-ask-qi]'))) {
      AskUserQuestionCard._enableBlock(block);
    }
    AskUserQuestionCard._updateBadge(wrapper, msg, answeredIndices);
    AskUserQuestionCard._setError(wrapper, t('askUser.sendFailed'), 'send-failed');
  }

  private static _record(
    answeredIndices: Map<string, Set<number>>,
    msgId: string,
    questionIndex: number,
  ): void {
    let s = answeredIndices.get(msgId);
    if (!s) { s = new Set(); answeredIndices.set(msgId, s); }
    s.add(questionIndex);
  }

  private static _optionBtn(text: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'aq-option-btn';
    btn.textContent = text;
    btn.style.cssText = `
      padding: 6px 14px; font-size: 12px; cursor: pointer;
      border: none; border-radius: 4px;
      border: 1px solid var(--color-hairline, #242728);
      background: var(--color-surface-elevated, #101111);
      color: var(--color-text-secondary, #cdcdcd);
      font-family: var(--font-sans);
      transition: background 0.15s, color 0.15s;
    `;
    if (disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
    } else {
      btn.addEventListener('click', onClick);
      btn.addEventListener('mouseenter', () => {
        if (btn.hasAttribute('data-selected')) return;
        btn.style.background = 'var(--color-surface-card, #121212)';
        btn.style.color = 'var(--color-text-primary, #fff)';
        btn.style.borderColor = 'var(--color-hairline-strong, rgba(255,255,255,0.16))';
      });
      btn.addEventListener('mouseleave', () => {
        if (btn.hasAttribute('data-selected')) return;
        btn.style.background = 'var(--color-surface-elevated, #101111)';
        btn.style.color = 'var(--color-text-secondary, #cdcdcd)';
        btn.style.borderColor = 'var(--color-hairline, #242728)';
      });
    }
    return btn;
  }

  private static _disableBlock(qBlock: HTMLElement): void {
    const controls = qBlock.querySelectorAll('button, input, textarea');
    for (const control of controls) { (control as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement).disabled = true; }
    qBlock.style.opacity = '0.45';
    const headerEl = qBlock.querySelector(':scope > div:first-child') as HTMLElement;
    if (headerEl && !headerEl.querySelector('.aq-check')) {
      const check = document.createElement('span');
      check.className = 'aq-check';
      check.innerHTML = '&#10003;';
      check.style.cssText = 'color: var(--color-success, #00cd72); font-size: 11px;';
      headerEl.appendChild(check);
    }
  }

  private static _enableBlock(qBlock: HTMLElement): void {
    const controls = qBlock.querySelectorAll('button, input, textarea');
    for (const control of controls) { (control as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement).disabled = false; }
    qBlock.style.opacity = '';
    qBlock.querySelector('.aq-check')?.remove();
  }

  private static _updateBadge(wrapper: HTMLElement, msg: Message, answeredIndices: Map<string, Set<number>>): void {
    const indices = answeredIndices.get(msg.id);
    const questions = (msg.toolInput as any)?.questions || [];
    const header = wrapper.querySelector(':scope > div:first-child') as HTMLElement;
    if (!header) return;
    const existing = header.querySelector('.aq-badge');
    if (existing) existing.remove();
    if (!indices || indices.size === 0) return;

    if (indices.size >= questions.length) {
      header.appendChild(AskUserQuestionCard._badge(indices.size, questions.length, true));
    } else {
      header.appendChild(AskUserQuestionCard._badge(indices.size, questions.length, false));
    }
  }

  private static _badge(answered: number, total: number, complete: boolean): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'aq-badge';
    badge.dataset.answered = String(answered);
    badge.dataset.total = String(total);
    badge.dataset.complete = String(complete);
    badge.textContent = t(complete ? 'askUser.answeredComplete' : 'askUser.answeredPartial', { answered, total });
    badge.style.cssText = `
      margin-left: auto; font-size: 10px;
      padding: 2px 8px; border-radius: 10px;
      color: ${complete ? 'var(--color-success, #59d499)' : 'var(--color-text-secondary, #cdcdcd)'};
      background: ${complete ? 'var(--color-success-soft, rgba(89,212,153,0.15))' : 'var(--color-surface-elevated, #101111)'};
    `;
    return badge;
  }

  private static _setError(wrapper: HTMLElement, message: string, localError?: string): void {
    wrapper.querySelector('.aq-error')?.remove();
    if (!message) return;
    const error = document.createElement('div');
    error.className = 'aq-error';
    if (localError) error.dataset.localError = localError;
    error.textContent = message;
    error.style.cssText = 'padding:0 14px 12px;color:var(--color-error, #f87171);font-size:11px;';
    wrapper.appendChild(error);
  }
}
