// Shared UI: Input component
export interface InputConfig {
  type?: 'text' | 'password' | 'number';
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}

export class Input {
  readonly element: HTMLInputElement;

  constructor(config: InputConfig = {}) {
    const input = document.createElement('input');
    input.type = config.type || 'text';
    input.className = 'ui-input';
    if (config.placeholder) input.placeholder = config.placeholder;
    if (config.value) input.value = config.value;
    if (config.disabled) input.disabled = true;
    if (config.onChange) input.addEventListener('input', () => config.onChange!(input.value));
    this.element = input;
  }

  get value(): string { return this.element.value; }
  set value(v: string) { this.element.value = v; }
  set disabled(v: boolean) { this.element.disabled = v; }
  get disabled(): boolean { return this.element.disabled; }
}
