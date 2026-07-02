// Shared UI: StatusCard — animated status indicator with spinner + text.

export class StatusCard {
  readonly element: HTMLElement;
  private _textEl: HTMLElement;

  constructor(content: string) {
    const el = document.createElement('div'); el.className = 'ui-statuscard';
    el.appendChild(this._buildSpinner());
    this._textEl = document.createElement('span'); this._textEl.className = 'ui-statuscard-text';
    this._textEl.textContent = content; el.appendChild(this._textEl);
    this.element = el;
    this._injectStyles();
  }

  set text(v: string) { this._textEl.textContent = v; }

  dispose(): void {
    this.element.style.opacity = '0';
    this.element.style.transition = 'opacity 0.3s ease';
    setTimeout(() => { if (this.element.parentNode) this.element.remove(); }, 300);
  }

  private _buildSpinner(): SVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.classList.add('ui-statuscard-spinner');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bg.setAttribute('cx', '12'); bg.setAttribute('cy', '12'); bg.setAttribute('r', '10');
    bg.setAttribute('stroke', 'var(--color-hairline)'); bg.setAttribute('stroke-width', '2');
    svg.appendChild(bg);
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arc.setAttribute('cx', '12'); arc.setAttribute('cy', '12'); arc.setAttribute('r', '10');
    arc.setAttribute('stroke', 'var(--color-text-secondary)'); arc.setAttribute('stroke-width', '2');
    arc.setAttribute('stroke-dasharray', '31.4 31.4'); arc.setAttribute('stroke-dashoffset', '23.55');
    arc.setAttribute('stroke-linecap', 'round'); arc.setAttribute('fill', 'none');
    arc.classList.add('ui-statuscard-arc'); svg.appendChild(arc);
    return svg;
  }

  private _injectStyles(): void {
    if (document.getElementById('ui-statuscard-styles')) return;
    const s = document.createElement('style'); s.id = 'ui-statuscard-styles';
    s.textContent = `.ui-statuscard{display:flex;align-items:center;gap:8px;padding:6px 14px;margin:2px 0;font-size:12px;color:var(--color-text-secondary);animation:statuscard-in .3s ease}
.ui-statuscard-spinner{flex-shrink:0;animation:statuscard-spin 1.2s linear infinite}
.ui-statuscard-arc{stroke:var(--color-text-secondary);transition:stroke .1s}
.ui-statuscard-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:statuscard-pulse 2s ease-in-out infinite}
@keyframes statuscard-spin{to{transform:rotate(360deg)}}
@keyframes statuscard-pulse{0%,100%{opacity:1}50%{opacity:.6}}
@keyframes statuscard-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(s);
  }
}
