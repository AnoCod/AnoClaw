

import type { GoalState, InputMode } from './types.js';
import { ClientLogger } from '../../ClientLogger.js';
import { Toggle } from '../ui/Toggle.js';

export class ModeSelector {
  readonly element: HTMLButtonElement;

  /** Fires when mode changes (including external setMode calls and user menu clicks) */
  onModeChange: ((mode: InputMode) => void) | null = null;
  /** Fires when effort toggle changes */
  onEffortChange: ((enabled: boolean) => void) | null = null;
  onGoalAction: ((action: 'start' | 'pause' | 'resume' | 'edit' | 'delete', objective?: string) => void) | null = null;

  private mode: InputMode;
  private effortEnabled: boolean;
  private goal: GoalState | null = null;
  private dropdown: HTMLElement | null = null;

  constructor(initialMode: InputMode = 'auto', effortEnabled: boolean = true) {
    this.mode = initialMode;
    this.effortEnabled = effortEnabled;
    this.element = this._buildButton();
  }



  getMode(): InputMode {
    return this.mode;
  }

  isEffortEnabled(): boolean {
    return this.effortEnabled;
  }

  setMode(mode: InputMode, emit: boolean = true): void {
    this.mode = mode;
    this._updateLabel();
    if (emit && this.onModeChange) this.onModeChange(this.mode);
  }

  setGoal(goal: GoalState | null): void {
    this.goal = goal && goal.status !== 'deleted' ? goal : null;
    this._updateLabel();
  }

  setEffort(enabled: boolean, emit: boolean = true): void {
    this.effortEnabled = enabled;
    if (emit && this.onEffortChange) this.onEffortChange(enabled);
  }



  private _buildButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'cinema-tool-btn';
    this._updateLabel(btn);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleDropdown();
    });
    return btn;
  }

  private _updateLabel(btn?: HTMLButtonElement): void {
    const b = btn || this.element;
    const modeLabels: Record<InputMode, string> = {
      'auto-edit': 'Auto Edit',
      'auto': 'Safe Auto',
      'ask': 'Ask',
      'plan': 'Plan',
    };
    b.innerHTML = '';

    const prefix = this.goal?.status === 'active' ? 'Goal ' : '';
    const label = document.createElement('span');
    label.textContent = prefix + modeLabels[this.mode];
    b.appendChild(label);

    const arrow = document.createElement('span');
    arrow.textContent = '^';
    arrow.style.cssText = 'font-size: 8px; opacity: 0.5; margin-left: 2px;';
    b.appendChild(arrow);
  }



  private _toggleDropdown(): void {
    if (this.dropdown) {
      this._closeDropdown();
      return;
    }
    this.dropdown = this._buildDropdown();
    document.body.appendChild(this.dropdown);
    this._positionDropdown();

    // Close on outside click (use capture to beat stopped propagation).
    // setTimeout avoids the click that opened the dropdown from closing it.
    const closeOnClick = (e: MouseEvent) => {
      if (!this.dropdown) return;
      if (!this.dropdown.contains(e.target as Node) && e.target !== this.element) {
        this._closeDropdown();
        document.removeEventListener('click', closeOnClick, true);
        document.removeEventListener('keydown', closeOnEscape, true);
      }
    };
    // Close on Escape key
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this._closeDropdown();
        document.removeEventListener('click', closeOnClick, true);
        document.removeEventListener('keydown', closeOnEscape, true);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeOnClick, { capture: true });
      document.addEventListener('keydown', closeOnEscape, { capture: true });
    }, 0);
  }

  private _closeDropdown(): void {
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
  }

  private _buildDropdown(): HTMLElement {
    const dd = document.createElement('div');
    dd.className = 'mode-dropdown';

    const modes: { mode: InputMode; label: string; desc: string }[] = [
      { mode: 'auto-edit', label: 'Auto Edit', desc: 'All tools run freely. No confirmation pop-ups.' },
      { mode: 'auto', label: 'Safe Auto', desc: 'Auto-approve edits and writes. Pop up only for risky commands.' },
      { mode: 'ask', label: 'Ask', desc: 'Pop up confirmation for every file change and command.' },
      { mode: 'plan', label: 'Plan', desc: 'Read and explore only. No changes allowed.' },
    ];

    for (const m of modes) {
      const item = document.createElement('button');
      item.className = 'mode-dropdown-item' + (m.mode === this.mode ? ' active' : '');

      const radio = document.createElement('span');
      radio.className = 'mode-radio' + (m.mode === this.mode ? ' active' : '');
      if (m.mode === this.mode) {
        const dot = document.createElement('span');
        dot.className = 'mode-radio-dot';
        radio.appendChild(dot);
      }

      const textCol = document.createElement('div');
      textCol.className = 'mode-dropdown-text';
      const title = document.createElement('span');
      title.className = 'mode-dropdown-title';
      title.textContent = m.label;
      const desc = document.createElement('span');
      desc.className = 'mode-dropdown-desc';
      desc.textContent = m.desc;
      textCol.appendChild(title);
      textCol.appendChild(desc);

      item.appendChild(radio);
      item.appendChild(textCol);

      item.addEventListener('click', () => {
        this.setMode(m.mode);
        this._closeDropdown();
        ClientLogger.ui.debug('Input mode changed', { mode: m.mode });
      });
      dd.appendChild(item);
    }

    // Separator before goal controls
    const divider1 = document.createElement('div');
    divider1.className = 'mode-dropdown-divider';
    dd.appendChild(divider1);

    dd.appendChild(this._buildGoalRow());

    // Separator before effort
    const divider2 = document.createElement('div');
    divider2.className = 'mode-dropdown-divider';
    dd.appendChild(divider2);

    // Effort toggle row
    const effortRow = document.createElement('div');
    effortRow.className = 'mode-effort-row';
    const effortLabel = document.createElement('span');
    effortLabel.className = 'mode-effort-label';
    effortLabel.textContent = 'Effort';

    const effortToggle = new Toggle({ checked: this.effortEnabled, onChange: (v) => {
      this.effortEnabled = v;
      ClientLogger.ui.debug('Effort toggled', { enabled: v });
      if (this.onEffortChange) this.onEffortChange(v);
    }});

    effortRow.appendChild(effortLabel);
    effortRow.appendChild(effortToggle.element);
    dd.appendChild(effortRow);

    return dd;
  }

  private _positionDropdown(): void {
    if (!this.dropdown) return;
    const anchorRect = this.element.getBoundingClientRect();
    const dropdownRect = this.dropdown.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const left = Math.min(
      Math.max(anchorRect.left, margin),
      Math.max(margin, window.innerWidth - dropdownRect.width - margin),
    );
    const top = Math.max(margin, anchorRect.top - dropdownRect.height - gap);

    this.dropdown.style.left = `${left}px`;
    this.dropdown.style.top = `${top}px`;
    this.dropdown.style.bottom = 'auto';
  }

  private _buildGoalRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mode-goal-row';
    row.style.gap = '8px';

    const label = document.createElement('span');
    label.className = 'mode-goal-label';
    label.textContent = this.goal ? `Goal: ${this.goal.status}` : 'Goal';
    label.title = this.goal?.objective || 'No active goal';
    row.appendChild(label);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:4px;align-items:center;';

    const makeBtn = (text: string, action: 'start' | 'pause' | 'resume' | 'edit' | 'delete') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.className = 'cinema-tool-btn';
      btn.style.cssText = 'height:22px;padding:0 7px;font-size:10px;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onGoalAction?.(action);
        this._closeDropdown();
      });
      return btn;
    };

    if (!this.goal) {
      actions.style.width = '100%';
      const startBtn = makeBtn('Start Goal', 'start');
      startBtn.classList.add('mode-goal-start-btn');
      startBtn.style.width = '100%';
      actions.appendChild(startBtn);
    } else if (this.goal.status === 'active') {
      actions.appendChild(makeBtn('Pause', 'pause'));
      actions.appendChild(makeBtn('Edit', 'edit'));
      actions.appendChild(makeBtn('Delete', 'delete'));
    } else {
      actions.appendChild(makeBtn('Resume', 'resume'));
      actions.appendChild(makeBtn('Edit', 'edit'));
      actions.appendChild(makeBtn('Delete', 'delete'));
    }

    row.appendChild(actions);
    return row;
  }
}


