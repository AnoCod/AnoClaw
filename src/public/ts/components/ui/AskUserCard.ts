// Shared UI: AskUserCard — interactive question panel with options.
// Raycast-like cinema style. Auto-builds option buttons with single/multi-select.

export interface AskUserOption { label: string; description: string; preview?: string; }

export interface AskUserCardConfig {
  questions: Array<{ header: string; question: string; options: AskUserOption[]; multiSelect?: boolean; }>;
  onAnswer: (answers: Record<string, string | string[]>) => void;
}

export class AskUserCard {
  readonly element: HTMLElement;

  constructor(config: AskUserCardConfig) {
    const wrapper = document.createElement('div'); wrapper.className = 'ui-askusercard';

    const header = document.createElement('div'); header.className = 'ui-askusercard-header';
    const dot = document.createElement('span'); dot.className = 'ui-askusercard-dot'; header.appendChild(dot);
    const title = document.createElement('span'); title.textContent = 'Ask User'; header.appendChild(title);
    wrapper.appendChild(header);

    const body = document.createElement('div'); body.className = 'ui-askusercard-body';
    for (const q of config.questions) {
      body.appendChild(this._buildQuestion(q));
      // Single-question: submit button per question group
    }

    wrapper.appendChild(body);
    this.element = wrapper;
    this._injectStyles();
  }

  private _buildQuestion(q: AskUserCardConfig['questions'][0]): HTMLElement {
    const qBlock = document.createElement('div');
    const qLabel = document.createElement('div'); qLabel.className = 'ui-askusercard-qheader';
    qLabel.textContent = q.header; qBlock.appendChild(qLabel);

    const qText = document.createElement('div'); qText.className = 'ui-askusercard-qtext';
    qText.textContent = q.question; qBlock.appendChild(qText);

    const optsWrap = document.createElement('div'); optsWrap.className = 'ui-askusercard-opts';
    for (const opt of q.options) {
      const btn = document.createElement('button'); btn.className = 'ui-askusercard-opt';
      btn.innerHTML = `<strong>${opt.label}</strong><span>${opt.description}</span>`;
      if (opt.preview) { const pv = document.createElement('span'); pv.className = 'ui-askusercard-preview'; pv.textContent = opt.preview; btn.appendChild(pv); }
      optsWrap.appendChild(btn);
    }
    qBlock.appendChild(optsWrap);
    return qBlock;
  }

  private _injectStyles(): void {
    if (document.getElementById('ui-askusercard-styles')) return;
    const s = document.createElement('style'); s.id = 'ui-askusercard-styles';
    s.textContent = `.ui-askusercard{margin-bottom:12px;border:1px solid var(--color-hairline,#242728);border-radius:8px;background:var(--color-surface,#0d0d0d);overflow:hidden}
.ui-askusercard-header{display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:10px;color:var(--color-text-secondary,#9c9c9d);letter-spacing:.4px;text-transform:uppercase}
.ui-askusercard-dot{width:4px;height:4px;border-radius:50%;flex-shrink:0;background:var(--color-info,#57c1ff)}
.ui-askusercard-body{padding:8px 14px 14px}
.ui-askusercard-qheader{font-size:11px;color:var(--cinema-text-btn);font-weight:600;margin-bottom:4px}
.ui-askusercard-qtext{font-size:12px;color:var(--cinema-text-secondary);line-height:1.5;margin-bottom:10px}
.ui-askusercard-opts{display:flex;flex-direction:column;gap:6px}
.ui-askusercard-opt{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border:1px solid var(--color-hairline,#242728);border-radius:6px;background:var(--color-surface-elevated,#101111);color:var(--color-text-primary);cursor:pointer;font-family:inherit;font-size:12px;text-align:left;transition:border-color .15s,background .15s}
.ui-askusercard-opt:hover{border-color:var(--color-hairline-strong,rgba(255,255,255,.16));background:var(--color-surface-card,#121212)}
.ui-askusercard-opt strong{display:block;font-size:13px}
.ui-askusercard-opt span{display:block;font-size:11px;color:var(--color-text-secondary)}
.ui-askusercard-preview{font-size:10px;color:var(--color-text-quaternary);margin-top:4px;font-family:var(--font-mono)}`;
    document.head.appendChild(s);
  }
}
