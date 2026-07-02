// Shared UI: Textarea component
export interface TextareaConfig {
  rows?: number;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
}

export class Textarea {
  readonly element: HTMLTextAreaElement;

  constructor(config: TextareaConfig = {}) {
    const ta = document.createElement('textarea');
    ta.className = 'ui-textarea';
    ta.rows = config.rows || 3;
    if (config.placeholder) ta.placeholder = config.placeholder;
    if (config.value) ta.value = config.value;
    if (config.onChange) ta.addEventListener('input', () => config.onChange!(ta.value));
    this.element = ta;
  }

  get value(): string { return this.element.value; }
  set value(v: string) { this.element.value = v; }
}
