// Shared UI: SystemCard — centered notification line for info/warning/error.

export type SystemLevel = 'info' | 'warning' | 'error';

export interface SystemCardConfig { content: string; level?: SystemLevel; }

export class SystemCard {
  readonly element: HTMLElement;

  constructor(config: SystemCardConfig) {
    const wrapper = document.createElement('div'); wrapper.className = 'ui-systemcard';
    const msg = document.createElement('span'); msg.className = 'ui-systemcard-text ' + (config.level || 'info');
    msg.textContent = config.content; wrapper.appendChild(msg);
    this.element = wrapper;
    this._injectStyles();
  }

  private _injectStyles(): void {
    if (document.getElementById('ui-systemcard-styles')) return;
    const s = document.createElement('style'); s.id = 'ui-systemcard-styles';
    s.textContent = `.ui-systemcard{display:flex;justify-content:center;margin-bottom:12px}
.ui-systemcard-text{font-size:10px;text-align:center;line-height:1.6;max-width:80%}
.ui-systemcard-text.info{color:var(--cinema-text-muted)}
.ui-systemcard-text.warning{color:rgba(251,191,36,.3)}
.ui-systemcard-text.error{color:rgba(248,113,113,.3)}`;
    document.head.appendChild(s);
  }
}
