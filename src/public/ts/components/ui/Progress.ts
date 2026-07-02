// Shared UI: Progress bar component

type ProgressVariant = 'default' | 'success' | 'error';

export interface ProgressConfig {
  value?: number;
  variant?: ProgressVariant;
}

export class Progress {
  readonly element: HTMLElement;
  private _bar: HTMLElement;

  constructor(config: ProgressConfig = {}) {
    const outer = document.createElement('div');
    outer.className = 'ui-progress';
    this._bar = document.createElement('div');
    this._bar.className = 'ui-progress-bar';
    if (config.variant) this._bar.classList.add(`ui-progress-${config.variant}`);
    this._bar.style.width = `${config.value || 0}%`;
    outer.appendChild(this._bar);
    this.element = outer;
  }

  get value(): number { return parseFloat(this._bar.style.width) || 0; }
  set value(v: number) { this._bar.style.width = `${v}%`; }
}
