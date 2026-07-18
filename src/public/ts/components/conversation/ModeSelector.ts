

import type { GoalState, InputMode } from './types.js';
import { ClientLogger } from '../../ClientLogger.js';
import { Toggle } from '../ui/Toggle.js';

export class ModeSelector {
  readonly element: HTMLButtonElement;

  /** Fires when mode changes (including external setMode calls and user menu clicks) */
  onModeChange: ((mode: InputMode) => void) | null = null;
  /** Fires when effort toggle changes */
  onEffortChange: ((enabled: boolean) => void) | null = null;
  onGoalAction: ((action: 'start' | 'view' | 'pause' | 'resume' | 'edit' | 'delete', objective?: string) => void) | null = null;

  private mode: InputMode;
  private effortEnabled: boolean;
  private goal: GoalState | null = null;
  private dropdown: HTMLElement | null = null;
  private closeOnPointerDown: ((e: PointerEvent) => void) | null = null;
  private closeOnEscape: ((e: KeyboardEvent) => void) | null = null;
  private ignoreNextButtonClick = false;

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
    btn.type = 'button';
    btn.className = 'cinema-tool-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    this._updateLabel(btn);
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.ignoreNextButtonClick = true;
      this._toggleDropdown();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.ignoreNextButtonClick) {
        this.ignoreNextButtonClick = false;
        return;
      }
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

    const prefix = this.goal?.status === 'active'
      ? `Goal${this.goal.runCount ? ` #${this.goal.runCount}` : ''} · `
      : '';
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
    this.element.setAttribute('aria-expanded', 'true');

    this.closeOnPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || !this.dropdown) return;
      if (!this.dropdown.contains(target) && !this.element.contains(target)) {
        this._closeDropdown();
      }
    };

    this.closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeDropdown();
        this.element.focus();
      }
    };

    document.addEventListener('pointerdown', this.closeOnPointerDown, true);
    document.addEventListener('keydown', this.closeOnEscape, true);
  }

  private _closeDropdown(): void {
    if (this.closeOnPointerDown) {
      document.removeEventListener('pointerdown', this.closeOnPointerDown, true);
      this.closeOnPointerDown = null;
    }
    if (this.closeOnEscape) {
      document.removeEventListener('keydown', this.closeOnEscape, true);
      this.closeOnEscape = null;
    }
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
    this.element.setAttribute('aria-expanded', 'false');
  }

  private _buildDropdown(): HTMLElement {
    const dd = document.createElement('div');
    dd.className = 'mode-dropdown';
    dd.setAttribute('role', 'menu');
    dd.style.position = 'fixed';
    dd.style.zIndex = '10002';
    dd.addEventListener('pointerdown', (e) => e.stopPropagation());
    dd.addEventListener('click', (e) => e.stopPropagation());

    const modes: { mode: InputMode; label: string; desc: string }[] = [
      { mode: 'auto-edit', label: 'Auto Edit', desc: 'All tools run freely. No confirmation pop-ups.' },
      { mode: 'auto', label: 'Safe Auto', desc: 'Auto-approve edits and writes. Pop up only for risky commands.' },
      { mode: 'ask', label: 'Ask', desc: 'Pop up confirmation for every file change and command.' },
      { mode: 'plan', label: 'Plan', desc: 'Read and explore only. No changes allowed.' },
    ];

    for (const m of modes) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mode-dropdown-item' + (m.mode === this.mode ? ' active' : '');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(m.mode === this.mode));

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

      const chooseMode = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        this.setMode(m.mode);
        this._closeDropdown();
        ClientLogger.ui.debug('Input mode changed', { mode: m.mode });
      };
      item.addEventListener('pointerdown', chooseMode);
      item.addEventListener('click', (e) => {
        if (this.dropdown?.contains(item)) chooseMode(e);
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
    const spaceAbove = anchorRect.top - margin;
    const spaceBelow = window.innerHeight - anchorRect.bottom - margin;
    const preferredTop = spaceAbove >= dropdownRect.height || spaceAbove >= spaceBelow
      ? anchorRect.top - dropdownRect.height - gap
      : anchorRect.bottom + gap;
    const top = Math.min(
      Math.max(preferredTop, margin),
      Math.max(margin, window.innerHeight - dropdownRect.height - margin),
    );

    this.dropdown.style.left = `${left}px`;
    this.dropdown.style.top = `${top}px`;
    this.dropdown.style.bottom = 'auto';
  }

  private _buildGoalRow(): HTMLElement {
    // Goal has one canonical entry point: the Mode menu. The composer itself
    // stays focused on writing; opening this item either creates a Goal or
    // shows its complete contract, evidence, and controls in a dialog.
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mode-dropdown-item mode-goal-entry';
    item.setAttribute('role', 'menuitem');

    const icon = document.createElement('span');
    const statusClass = this.goal?.status.replace(/_/g, '-') || 'empty';
    icon.className = `mode-goal-icon goal-${statusClass}`;
    icon.setAttribute('aria-hidden', 'true');

    const textCol = document.createElement('div');
    textCol.className = 'mode-dropdown-text';
    const title = document.createElement('span');
    title.className = 'mode-dropdown-title';
    title.textContent = this.goal ? `Goal · ${this._goalStatusLabel(this.goal.status)}` : 'Goal';
    const desc = document.createElement('span');
    desc.className = 'mode-dropdown-desc';
    desc.textContent = this.goal?.objective || 'Set a bounded, verifiable outcome for this Workspace.';
    desc.title = this.goal?.objective || desc.textContent;
    textCol.appendChild(title);
    textCol.appendChild(desc);

    const badge = document.createElement('span');
    badge.className = 'mode-goal-badge';
    badge.textContent = this.goal
      ? `${this.goal.runCount || 0}/${this.goal.maxRuns || 20}`
      : 'Set up';

    item.appendChild(icon);
    item.appendChild(textCol);
    item.appendChild(badge);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onGoalAction?.(this.goal ? 'view' : 'start');
      this._closeDropdown();
    });
    return item;
  }

  private _goalStatusLabel(status: GoalState['status']): string {
    switch (status) {
      case 'active': return 'Running';
      case 'paused': return 'Paused';
      case 'waiting_user': return 'Needs input';
      case 'waiting_confirmation': return 'Needs approval';
      case 'waiting_review': return 'Ready for review';
      case 'blocked': return 'Blocked';
      case 'failed': return 'Stopped';
      case 'budget_exhausted': return 'Run limit reached';
      case 'completed': return 'Completed';
      default: return 'Unavailable';
    }
  }
}


