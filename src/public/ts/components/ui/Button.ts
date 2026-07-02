// Shared UI: Button component
// Usage: new Button({ label: 'Save', variant: 'primary' }).element

type ButtonVariant = 'default' | 'primary' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonConfig {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}

export class Button {
  readonly element: HTMLButtonElement;

  constructor(config: ButtonConfig) {
    const btn = document.createElement('button');
    btn.className = 'ui-btn';
    if (config.variant && config.variant !== 'default') btn.classList.add(`ui-btn-${config.variant}`);
    if (config.size && config.size !== 'md') btn.classList.add(`ui-btn-${config.size}`);
    if (config.disabled) btn.disabled = true;
    btn.textContent = config.label;
    if (config.title) btn.title = config.title;
    if (config.onClick) btn.addEventListener('click', config.onClick);
    this.element = btn;
  }

  set disabled(v: boolean) { this.element.disabled = v; }
  get disabled(): boolean { return this.element.disabled; }

  set label(v: string) { this.element.textContent = v; }
}
