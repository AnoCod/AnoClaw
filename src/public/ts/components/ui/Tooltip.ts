// Shared UI: Tooltip component — hover tooltip anchored to any element

export interface TooltipConfig {
  anchor: HTMLElement;
  text: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export class Tooltip {
  private _tip: HTMLElement;
  private _anchor: HTMLElement;
  private _pos: string;

  constructor(config: TooltipConfig) {
    this._pos = config.position || 'top';
    this._anchor = config.anchor;
    this._tip = document.createElement('div');
    this._tip.className = 'ui-tooltip';
    this._tip.textContent = config.text;
    this._tip.style.visibility = 'hidden';
    document.body.appendChild(this._tip);

    this._anchor.addEventListener('mouseenter', this._show);
    this._anchor.addEventListener('mouseleave', this._hide);
  }

  private _show = (): void => {
    const r = this._anchor.getBoundingClientRect();
    this._tip.style.visibility = 'visible';
    if (this._pos === 'top') { this._tip.style.left = `${r.left + r.width/2 - this._tip.offsetWidth/2}px`; this._tip.style.top = `${r.top - this._tip.offsetHeight - 4}px`; }
    else if (this._pos === 'bottom') { this._tip.style.left = `${r.left + r.width/2 - this._tip.offsetWidth/2}px`; this._tip.style.top = `${r.bottom + 4}px`; }
    else if (this._pos === 'left') { this._tip.style.left = `${r.left - this._tip.offsetWidth - 4}px`; this._tip.style.top = `${r.top + r.height/2 - this._tip.offsetHeight/2}px`; }
    else { this._tip.style.left = `${r.right + 4}px`; this._tip.style.top = `${r.top + r.height/2 - this._tip.offsetHeight/2}px`; }
  };

  private _hide = (): void => {
    this._tip.style.visibility = 'hidden';
  };

  destroy(): void {
    this._anchor.removeEventListener('mouseenter', this._show);
    this._anchor.removeEventListener('mouseleave', this._hide);
    if (this._tip.parentElement) this._tip.remove();
  }
}
