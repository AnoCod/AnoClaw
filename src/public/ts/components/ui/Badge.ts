// Shared UI: Badge component
type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

export interface BadgeConfig {
  text: string;
  variant?: BadgeVariant;
}

export class Badge {
  readonly element: HTMLElement;

  constructor(config: BadgeConfig) {
    const el = document.createElement('span');
    el.className = 'ui-badge';
    if (config.variant && config.variant !== 'default') el.classList.add(`ui-badge-${config.variant}`);
    el.textContent = config.text;
    this.element = el;
  }

  set text(v: string) { this.element.textContent = v; }
}
