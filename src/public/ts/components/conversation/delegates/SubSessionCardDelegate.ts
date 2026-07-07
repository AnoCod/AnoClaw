/**
 * SubSessionCardDelegate — single annotation line for sub-agent delegation.
 * "SUB-AGENT · Agent Beta dispatched · code review"
 * Click navigates to sub-session. Shows parent session info when available.
 */

export interface SubSessionCardData {
  subSessionId: string;
  subAgentId: string;
  subAgentName: string;
  taskDescription: string;
  messageCount: number;
  status: 'running' | 'completed' | 'error';
  parentSessionId?: string;
  parentSessionTitle?: string;
  onNavigate?: (sessionId: string) => void;
}

export class SubSessionCardDelegate {
  element: HTMLElement;
  private _data: SubSessionCardData;
  private _statusEl: HTMLElement;

  constructor(data: SubSessionCardData) {
    this._data = data;
    const { el, statusEl } = this._build();
    this.element = el;
    this._statusEl = statusEl;
    this.updateStatus(this._data.status);
  }

  private _build(): { el: HTMLElement; statusEl: HTMLElement } {
    const line = document.createElement('div');
    line.className = 'cinema-subsession-line';
    line.style.cursor = 'pointer';
    line.title = `Sub-session ${this._data.subSessionId.slice(0, 12)}… — click to view`;
    line.addEventListener('click', () => {
      if (this._data.onNavigate) {
        this._data.onNavigate(this._data.subSessionId);
      } else {
        window.dispatchEvent(new CustomEvent('select-session', { detail: { id: this._data.subSessionId } }));
      }
    });

    const label = document.createElement('span');
    label.className = 'cinema-label';
    label.textContent = 'SUB-AGENT';
    line.appendChild(label);

    const dot = document.createElement('span');
    dot.className = 'cinema-tool-dot';
    dot.style.cssText = `width:6px;height:6px;border-radius:50%;flex-shrink:0;`;
    const statusColors: Record<string, string> = {
      running: 'var(--color-accent-cinema)',
      completed: 'var(--color-success)',
      error: 'var(--color-error)',
    };
    dot.style.background = statusColors[this._data.status] || 'var(--cinema-text-muted)';
    line.appendChild(dot);

    const desc = document.createElement('span');
    const agentName = this._data.subAgentName || 'Agent';
    const task = this._data.taskDescription || '';
    desc.textContent = `${agentName}${task ? ` · ${task.slice(0, 80)}` : ''}`;
    desc.style.cssText = 'flex:1;';
    line.appendChild(desc);

    // Parent session link when available
    if (this._data.parentSessionId) {
      const parentLink = document.createElement('span');
      parentLink.style.cssText = `
        font-size: 9px;
        color: var(--cinema-text-muted);
        letter-spacing: 0.5px;
        margin-left: 8px;
        cursor: pointer;
        flex-shrink: 0;
        transition: color 0.15s;
      `;
      const parentLabel = this._data.parentSessionTitle
        ? this._data.parentSessionTitle.slice(0, 20)
        : this._data.parentSessionId.slice(0, 8);
      parentLink.textContent = `<- ${parentLabel}`;
      parentLink.title = `Parent: ${this._data.parentSessionId}`;
      parentLink.addEventListener('click', (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent('select-session', { detail: { id: this._data.parentSessionId } }));
      });
      parentLink.addEventListener('mouseenter', () => { parentLink.style.color = 'var(--cinema-text-btn)'; });
      parentLink.addEventListener('mouseleave', () => { parentLink.style.color = 'var(--cinema-text-muted)'; });
      line.appendChild(parentLink);
    }

    return { el: line, statusEl: dot };
  }

  updateStatus(status: 'running' | 'completed' | 'error'): void {
    if (this._data.status === status) return;
    this._data.status = status;
    const colors: Record<string, string> = {
      running: 'var(--color-accent-cinema)',
      completed: 'var(--color-success)',
      error: 'var(--color-error)',
    };
    this._statusEl.style.background = colors[status] || 'var(--cinema-text-muted)';
    if (status === 'running') {
      this._statusEl.style.animation = 'none';
      void this._statusEl.offsetHeight; // force reflow to restart animation
      this._statusEl.style.animation = 'cinema-pulse 2s ease-in-out infinite';
    } else {
      this._statusEl.style.animation = 'none';
    }
  }
}
