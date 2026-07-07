/**
 * AnoClaw Cinema — EditResultDelegate: diff card for Edit tool results.
 * Cinema style: no border, muted colors, just before|after side-by-side.
 */
export class EditResultDelegate {
  element: HTMLElement;
  private _bodyEl: HTMLElement | null = null;
  private _expanded = false;

  constructor(filePath: string, oldStr: string, newStr: string, success: boolean) {
    this.element = this.render(filePath, oldStr, newStr, success);
  }

  private render(filePath: string, oldStr: string, newStr: string, success: boolean): HTMLElement {
    const card = document.createElement('div');
    card.className = 'edit-result-card is-collapsed';
    card.style.cssText = `margin-bottom: 12px;`;

    const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

    // Header line — cinema annotation
    const header = document.createElement('div');
    header.style.cssText = `
      font-size: 9px; color: var(--cinema-text-muted); letter-spacing: 1px;
      display: flex; gap: 6px; align-items: center;
      margin-bottom: 8px; cursor: pointer;
    `;
    const dot = document.createElement('span');
    dot.style.cssText = `width:4px;height:4px;border-radius:50%;flex-shrink:0;background:${success ? 'rgba(134,239,172,0.4)' : 'rgba(248,113,113,0.4)'};`;
    header.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = 'EDIT';
    name.style.cssText = 'color: var(--cinema-text-welcome);';
    header.appendChild(name);
    const sep = document.createElement('span');
    sep.textContent = '·';
    sep.style.cssText = 'opacity: 0.3;';
    header.appendChild(sep);
    const file = document.createElement('span');
    file.textContent = fileName;
    file.style.cssText = 'letter-spacing: 0;';
    header.appendChild(file);
    header.addEventListener('click', () => this._toggle());
    card.appendChild(header);

    // Diff body — side by side, no outer border
    const body = document.createElement('div');
    body.style.cssText = 'display: flex; gap: 0;';

    body.appendChild(this._col('—', oldStr.slice(0, 500), 'rgba(248,113,113,0.08)', '#fca5a5'));
    body.appendChild(this._col('+', newStr.slice(0, 500), 'rgba(134,239,172,0.05)', '#86efac'));

    body.hidden = true;
    this._bodyEl = body;
    card.appendChild(body);
    return card;
  }

  collapse(): void {
    this._expanded = false;
    this.element.classList.add('is-collapsed');
    if (this._bodyEl) this._bodyEl.hidden = true;
  }

  expand(): void {
    this._expanded = true;
    this.element.classList.remove('is-collapsed');
    if (this._bodyEl) this._bodyEl.hidden = false;
  }

  private _toggle(): void {
    if (this._expanded) this.collapse();
    else this.expand();
  }

  private _col(label: string, text: string, bg: string, color: string): HTMLElement {
    const col = document.createElement('div');
    col.style.cssText = 'flex: 1; min-width: 0;';

    const lbl = document.createElement('div');
    lbl.textContent = label;
    lbl.style.cssText = `
      font-size: 10px; font-weight: 700; padding: 4px 8px;
      font-family: var(--font-mono, monospace); color: ${color};
    `;
    col.appendChild(lbl);

    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText = `
      margin: 0; padding: 6px 8px; font-size: 11px; line-height: 1.5;
      font-family: var(--font-mono, monospace);
      white-space: pre-wrap; word-break: break-all;
      background: ${bg}; border-radius: 4px; min-height: 40px;
      max-height: 200px; overflow-y: auto;
      color: var(--cinema-text-overlay);
    `;
    col.appendChild(pre);
    return col;
  }
}
