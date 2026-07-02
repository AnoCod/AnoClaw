// Shared UI: Select dropdown component
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectConfig {
  options: SelectOption[];
  value?: string;
  onChange?: (value: string) => void;
}

export class Select {
  readonly element: HTMLSelectElement;

  constructor(config: SelectConfig) {
    const sel = document.createElement('select');
    sel.className = 'ui-select';
    for (const opt of config.options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    if (config.value) sel.value = config.value;
    if (config.onChange) sel.addEventListener('change', () => config.onChange!(sel.value));
    this.element = sel;
  }

  get value(): string { return this.element.value; }
  set value(v: string) { this.element.value = v; }
}
