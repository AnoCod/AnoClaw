// Shared UI: Spinner component

type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerConfig {
  size?: SpinnerSize;
}

export class Spinner {
  readonly element: HTMLElement;

  constructor(config: SpinnerConfig = {}) {
    const el = document.createElement('div');
    el.className = 'ui-spinner';
    if (config.size && config.size !== 'md') el.classList.add(`ui-spinner-${config.size}`);
    this.element = el;
  }
}
