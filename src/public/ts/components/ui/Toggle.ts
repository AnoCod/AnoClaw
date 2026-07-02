// Shared UI: Toggle component
// Usage: new Toggle({ checked: false, onChange: (v) => ... }).element

export interface ToggleConfig {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}

export class Toggle {
  readonly element: HTMLElement;
  private _thumb: HTMLElement;
  private _checked: boolean;
  private _onChange?: (checked: boolean) => void;

  constructor(config: ToggleConfig = {}) {
    this._checked = config.checked ?? false;
    this._onChange = config.onChange;

    const el = document.createElement('div');
    el.className = 'ui-toggle';
    if (this._checked) el.classList.add('on');

    const thumb = document.createElement('div');
    thumb.className = 'ui-toggle-thumb';
    el.appendChild(thumb);
    this._thumb = thumb;

    el.addEventListener('click', () => {
      this._checked = !this._checked;
      el.classList.toggle('on', this._checked);
      this._onChange?.(this._checked);
    });

    this.element = el;
  }

  get checked(): boolean { return this._checked; }
  set checked(v: boolean) {
    this._checked = v;
    this.element.classList.toggle('on', v);
  }
}
