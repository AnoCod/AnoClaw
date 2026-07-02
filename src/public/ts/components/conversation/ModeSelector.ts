/**
 * ModeSelector — Mode selection button + dropdown menu component
 * Extracted from InputPanel, independently manages input mode (Ask / Auto-Edit / Plan / Auto) and Effort toggle.
 * Dropdown menu renders on body and auto-closes on outside click.
 */

import type { InputMode, RunningMode } from './types.js';
import { ClientLogger } from '../../ClientLogger.js';
import { Toggle } from '../ui/Toggle.js';

export class ModeSelector {
  readonly element: HTMLButtonElement;

  /** Fires when mode changes (including external setMode calls and user menu clicks) */
  onModeChange: ((mode: InputMode) => void) | null = null;
  /** Fires when running mode (normal/infinite) changes */
  onRunningModeChange: ((mode: RunningMode) => void) | null = null;

  private mode: InputMode;
  private runningMode: RunningMode;
  private effortEnabled: boolean;
  private dropdown: HTMLElement | null = null;

  constructor(initialMode: InputMode = 'auto', initialRunningMode: RunningMode = 'normal', effortEnabled: boolean = true) {
    this.mode = initialMode;
    this.runningMode = initialRunningMode;
    this.effortEnabled = effortEnabled;
    this.element = this._buildButton();
  }

  // ── Public API ──────────────────────────────────────────────────

  getMode(): InputMode {
    return this.mode;
  }

  getRunningMode(): RunningMode {
    return this.runningMode;
  }

  isEffortEnabled(): boolean {
    return this.effortEnabled;
  }

  setMode(mode: InputMode): void {
    this.mode = mode;
    this._updateLabel();
    if (this.onModeChange) this.onModeChange(this.mode);
  }

  setRunningMode(mode: RunningMode): void {
    this.runningMode = mode;
    this._updateLabel();
    if (this.onRunningModeChange) this.onRunningModeChange(this.runningMode);
  }

  // ── Button build ──────────────────────────────────────────────────

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
      'ask': 'Ask',
      'auto-edit': 'Auto-Edit',
      'plan': 'Plan',
      'auto': 'Auto',
    };
    b.innerHTML = '';

    const prefix = this.runningMode === 'infinite' ? '∞ ' : '';
    const label = document.createElement('span');
    label.textContent = prefix + modeLabels[this.mode];
    b.appendChild(label);

    const arrow = document.createElement('span');
    arrow.textContent = '▾';
    arrow.style.cssText = 'font-size: 8px; opacity: 0.5; margin-left: 2px;';
    b.appendChild(arrow);
  }

  // ── Dropdown menu ──────────────────────────────────────────────────

  private _toggleDropdown(): void {
    if (this.dropdown) {
      this._closeDropdown();
      return;
    }
    this.dropdown = this._buildDropdown();
    document.body.appendChild(this.dropdown);

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
      { mode: 'ask', label: 'Ask before edits', desc: 'Ask for confirmation before each edit' },
      { mode: 'auto-edit', label: 'Edit automatically', desc: 'Edit files directly without asking' },
      { mode: 'plan', label: 'Plan mode', desc: 'Explore code and present a plan first' },
      { mode: 'auto', label: 'Auto mode', desc: 'Auto-select best permission mode (default)' },
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

    // Separator before running mode
    const divider1 = document.createElement('div');
    divider1.className = 'mode-dropdown-divider';
    dd.appendChild(divider1);

    // Infinite toggle row
    const infiniteRow = document.createElement('div');
    infiniteRow.className = 'mode-infinite-row';
    const infiniteLabel = document.createElement('span');
    infiniteLabel.className = 'mode-infinite-label';
    infiniteLabel.textContent = '∞ Infinite';

    const infiniteToggle = new Toggle({ checked: this.runningMode === 'infinite', onChange: (v) => {
      this.setRunningMode(v ? 'infinite' : 'normal');
    }});

    infiniteRow.appendChild(infiniteLabel);
    infiniteRow.appendChild(infiniteToggle.element);
    dd.appendChild(infiniteRow);

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
    }});

    effortRow.appendChild(effortLabel);
    effortRow.appendChild(effortToggle.element);
    dd.appendChild(effortRow);

    // Position above the button (dropdown opens upward)
    const anchorRect = this.element.getBoundingClientRect();
    dd.style.bottom = `${window.innerHeight - anchorRect.top + 4}px`;
    dd.style.left = `${anchorRect.left}px`;

    return dd;
  }
}
