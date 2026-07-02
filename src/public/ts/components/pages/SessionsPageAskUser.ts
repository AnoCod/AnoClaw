/**
 * AnoClaw Cinema — AskUserQuestion Interactive Card
 * Noticeable (user needs to see questions) but borderless cinema aesthetic.
 * Subtle purple surface lift, no hard border. Option buttons get purple accent.
 */
import type { Message } from '../../types.js';

export class AskUserQuestionCard {
  static build(
    msg: Message,
    answeredIndices: Map<string, Set<number>>,
    onSendAnswer: (answer: string) => void,
  ): HTMLElement {
    const indices = answeredIndices.get(msg.id) || new Set();
    const pendingAnswers = new Map<number, string>();
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      margin-bottom: 12px;
      border-radius: 4px;
      background: rgba(124,58,237,0.04);
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
      font-size: 10px; color: rgba(167,139,250,0.35);
      letter-spacing: 1px; text-transform: uppercase;
    `;

    // Dot
    const dot = document.createElement('span');
    dot.style.cssText = `width:4px;height:4px;border-radius:50%;flex-shrink:0;background:rgba(167,139,250,0.4);`;
    header.appendChild(dot);

    const title = document.createElement('span');
    title.textContent = 'Ask User';
    title.style.cssText = 'flex:1;';
    header.appendChild(title);

    const questions = (msg.toolInput as any)?.questions || [];
    if (questions.length > 0 && indices.size >= questions.length) {
      header.appendChild(AskUserQuestionCard._badge(`Answered (${indices.size}/${questions.length})`, true));
    } else if (indices.size > 0) {
      header.appendChild(AskUserQuestionCard._badge(`${indices.size}/${questions.length} answered`, false));
    }
    wrapper.appendChild(header);
  }

  private static _buildBody(
    wrapper: HTMLElement,
    msg: Message,
    indices: Set<number>,
    answeredIndices: Map<string, Set<number>>,
    onSendAnswer: (answer: string) => void,
    pendingAnswers: Map<number, string>,
  ): void {
    const body = document.createElement('div');
    body.style.cssText = 'padding: 6px 14px 14px;';

    const questions: any[] = (msg.toolInput as any)?.questions || [];
    if (questions.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No questions available.';
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
          color: rgba(167,139,250,0.4); text-transform: uppercase;
          letter-spacing: 0.5px; margin-bottom: 4px;
          display: flex; align-items: center; gap: 6px;
        `;
        hdr.textContent = q.header;
        if (qAnswered) {
          const check = document.createElement('span');
          check.innerHTML = '&#10003;';
          check.style.cssText = 'color: #10b981; font-size: 11px;';
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
                btn.style.background = 'rgba(124,58,237,0.08)';
                btn.style.color = 'rgba(167,139,250,0.6)';
              } else {
                selectedOptions.add(opt);
                btn.setAttribute('data-selected', '1');
                btn.style.background = 'rgba(124,58,237,0.2)';
                btn.style.color = '#ffffff';
              }
            });
            btnGroup.appendChild(btn);
          }
          const confirmBtn = document.createElement('button');
          confirmBtn.textContent = 'Confirm';
          confirmBtn.style.cssText = `
            padding: 6px 16px; font-size: 12px; cursor: pointer;
            border: none; background: #7c3aed; color: #fff;
            border-radius: 4px; font-family: var(--font-sans); font-weight: 600;
          `;
          confirmBtn.addEventListener('click', () => {
            if (selectedOptions.size === 0) return;
            const answer = Array.from(selectedOptions).join(', ');
            pendingAnswers.set(qi, answer);
            AskUserQuestionCard._record(answeredIndices, msg.id, qi);
            AskUserQuestionCard._disableBlock(qBlock);
            AskUserQuestionCard._updateBadge(wrapper, msg, answeredIndices);
            AskUserQuestionCard._maybeSend(questions, pendingAnswers, answeredIndices, msg, onSendAnswer);
          });
          btnGroup.appendChild(confirmBtn);
        } else {
          for (const opt of options) {
            const btn = AskUserQuestionCard._optionBtn(opt, false, () => {
              pendingAnswers.set(qi, opt);
              AskUserQuestionCard._record(answeredIndices, msg.id, qi);
              AskUserQuestionCard._disableBlock(qBlock);
              AskUserQuestionCard._updateBadge(wrapper, msg, answeredIndices);
              AskUserQuestionCard._maybeSend(questions, pendingAnswers, answeredIndices, msg, onSendAnswer);
            });
            btnGroup.appendChild(btn);
          }
        }
        qBlock.appendChild(btnGroup);
      } else {
        const hint = document.createElement('p');
        hint.textContent = qAnswered ? 'Answered via input.' : 'Type your answer in the input box below.';
        hint.style.cssText = 'font-size: 11px; color: rgba(255,255,255,0.2); font-style: italic; margin: 0;';
        qBlock.appendChild(hint);
      }

      if (qAnswered) AskUserQuestionCard._disableBlock(qBlock);
      body.appendChild(qBlock);
    }
    wrapper.appendChild(body);
  }

  private static _maybeSend(
    questions: any[],
    pendingAnswers: Map<number, string>,
    answeredIndices: Map<string, Set<number>>,
    msg: Message,
    onSendAnswer: (answer: string) => void,
  ): void {
    const indices = answeredIndices.get(msg.id);
    if (!indices || indices.size < questions.length) return;

    if (questions.length === 1) {
      onSendAnswer(pendingAnswers.get(0) || '');
      return;
    }

    const parts: string[] = [];
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const header = q?.header || `Q${qi + 1}`;
      const answer = pendingAnswers.get(qi) || '';
      parts.push(`${header}: ${answer}`);
    }
    onSendAnswer(parts.join('\n'));
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
    btn.textContent = text;
    btn.style.cssText = `
      padding: 6px 14px; font-size: 12px; cursor: pointer;
      border: none; border-radius: 4px;
      background: rgba(124,58,237,0.08);
      color: rgba(167,139,250,0.6);
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
        btn.style.background = 'rgba(124,58,237,0.15)';
        btn.style.color = 'rgba(167,139,250,0.8)';
      });
      btn.addEventListener('mouseleave', () => {
        if (btn.hasAttribute('data-selected')) return;
        btn.style.background = 'rgba(124,58,237,0.08)';
        btn.style.color = 'rgba(167,139,250,0.6)';
      });
    }
    return btn;
  }

  private static _disableBlock(qBlock: HTMLElement): void {
    const buttons = qBlock.querySelectorAll('button');
    for (const btn of buttons) { (btn as HTMLButtonElement).disabled = true; }
    qBlock.style.opacity = '0.45';
    const headerEl = qBlock.querySelector(':scope > div:first-child') as HTMLElement;
    if (headerEl && !headerEl.querySelector('.aq-check')) {
      const check = document.createElement('span');
      check.className = 'aq-check';
      check.innerHTML = '&#10003;';
      check.style.cssText = 'color: #10b981; font-size: 11px;';
      headerEl.appendChild(check);
    }
  }

  private static _updateBadge(wrapper: HTMLElement, msg: Message, answeredIndices: Map<string, Set<number>>): void {
    const indices = answeredIndices.get(msg.id);
    if (!indices) return;
    const questions = (msg.toolInput as any)?.questions || [];
    const header = wrapper.querySelector(':scope > div:first-child') as HTMLElement;
    if (!header) return;
    const existing = header.querySelector('.aq-badge');
    if (existing) existing.remove();

    if (indices.size >= questions.length) {
      header.appendChild(AskUserQuestionCard._badge(`Answered (${indices.size}/${questions.length})`, true));
    } else {
      header.appendChild(AskUserQuestionCard._badge(`${indices.size}/${questions.length} answered`, false));
    }
  }

  private static _badge(text: string, complete: boolean): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'aq-badge';
    badge.textContent = text;
    badge.style.cssText = `
      margin-left: auto; font-size: 10px;
      padding: 2px 8px; border-radius: 10px;
      color: ${complete ? '#10b981' : 'rgba(167,139,250,0.5)'};
      background: ${complete ? 'rgba(16,185,129,0.08)' : 'rgba(124,58,237,0.08)'};
    `;
    return badge;
  }
}
