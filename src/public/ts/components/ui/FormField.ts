// Shared UI: FormField component
// Usage: new FormField({ label: 'Name', input: someInputElement }).element

export interface FormFieldConfig {
  label: string;
  input: HTMLElement;
  help?: string;
}

export class FormField {
  readonly element: HTMLElement;

  constructor(config: FormFieldConfig) {
    const field = document.createElement('div');
    field.className = 'ui-form-field';

    const label = document.createElement('label');
    label.textContent = config.label;
    field.appendChild(label);

    field.appendChild(config.input);

    if (config.help) {
      const help = document.createElement('div');
      help.style.cssText = 'font-size:11px;color:var(--color-text-quaternary);margin-top:4px;';
      help.textContent = config.help;
      field.appendChild(help);
    }

    this.element = field;
  }
}
