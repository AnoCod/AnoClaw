/**
 * StatusDelegate — renders a compact animated status card in the message list.
 * Shows a radial SVG spinner icon + status text (compaction, idle fun messages, etc.).
 * The card auto-removes when replaced by the next status or dismissed.
 */

export class StatusDelegate {
  element: HTMLDivElement;
  private _spinnerEl: SVGElement;
  private _textEl: HTMLElement;

  constructor(content: string) {
    this.element = document.createElement('div');
    this.element.className = 'delegate-status';

    // Radial spinner SVG
    this._spinnerEl = this._buildSpinner();
    this.element.appendChild(this._spinnerEl);

    // Text
    this._textEl = document.createElement('span');
    this._textEl.className = 'status-text';
    this._textEl.textContent = content;
    this.element.appendChild(this._textEl);

    this._injectStyles();
  }

  update(content: string): void {
    this._textEl.textContent = content;
  }

  dispose(): void {
    this.element.style.opacity = '0';
    this.element.style.transition = 'opacity 0.3s ease';
    setTimeout(() => {
      if (this.element.parentNode) {
        this.element.remove();
      }
    }, 300);
  }

  private _buildSpinner(): SVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.classList.add('status-spinner-svg');

    // Background circle
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bg.setAttribute('cx', '12');
    bg.setAttribute('cy', '12');
    bg.setAttribute('r', '10');
    bg.setAttribute('stroke', 'var(--color-hairline)');
    bg.setAttribute('stroke-width', '2');
    svg.appendChild(bg);

    // Animated arc (radial rays effect via dasharray)
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arc.setAttribute('cx', '12');
    arc.setAttribute('cy', '12');
    arc.setAttribute('r', '10');
    arc.setAttribute('stroke', 'var(--color-text-secondary)');
    arc.setAttribute('stroke-width', '2');
    arc.setAttribute('stroke-dasharray', '31.4 31.4');
    arc.setAttribute('stroke-dashoffset', '23.55');
    arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('fill', 'none');
    arc.classList.add('status-spinner-arc');
    svg.appendChild(arc);

    return svg;
  }

  private _injectStyles(): void {
    const id = 'status-delegate-styles';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      @keyframes status-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @keyframes status-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
      @keyframes status-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }
}
