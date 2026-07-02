/**
 * SlashCommandPanel — popup panel that appears when user types "/".
 * Shows available slash commands with filtering and keyboard navigation.
 * Appended to document.body with position: fixed anchored to textarea.
 */

import { EventEmitter } from '../../EventEmitter.js';
import type { CommandDefinition } from '../../types.js';
import { filterCommands } from './SlashCommands.js';
import { ClientLogger } from '../../ClientLogger.js';

export class SlashCommandPanel extends EventEmitter {
  private _el: HTMLElement | null = null;
  private _listEl: HTMLElement | null = null;
  private _selectedIndex: number = 0;
  private _commands: CommandDefinition[] = [];
  private _filtered: CommandDefinition[] = [];
  private _textarea: HTMLElement | null = null;

  /** Show the popup anchored to the textarea with the current filter text. */
  open(textarea: HTMLElement, commands: CommandDefinition[], filterText: string): void {
    this._textarea = textarea;
    this._commands = commands;

    if (this._el) this._el.remove();

    this._el = this._buildPopup(commands);
    document.body.appendChild(this._el);

    this._applyFilter(filterText);
    this._position();

    // Dismiss on outside click (matching ModeSelector pattern)
    const closeOnClick = (e: MouseEvent) => {
      if (!this._el) return;
      if (!this._el.contains(e.target as Node) && e.target !== this._textarea) {
        this.close();
        document.removeEventListener('click', closeOnClick);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnClick), 0);

    ClientLogger.ui.debug('Slash popup opened', { commandCount: commands.length });
  }

  /** Update filtering as user types. */
  filter(query: string): void {
    this._applyFilter(query);
    this._selectedIndex = 0;
    this._updateSelection();
  }

  /** Close and remove the popup. */
  close(): void {
    if (this._el) {
      this._el.remove();
      this._el = null;
      this._listEl = null;
      this._textarea = null;
      this._filtered = [];
      ClientLogger.ui.debug('Slash popup closed');
    }
  }

  get isOpen(): boolean {
    return this._el !== null;
  }

  /** Public access to the popup DOM element. */
  get element(): HTMLElement | null {
    return this._el;
  }

  /** Check if a given node is inside the popup. Safe to call when closed (returns false). */
  containsElement(node: Node): boolean {
    return this._el ? this._el.contains(node) : false;
  }

  get selectedCommand(): CommandDefinition | undefined {
    return this._filtered[this._selectedIndex];
  }

  // ── Keyboard navigation ──

  moveUp(): void {
    if (this._filtered.length === 0) return;
    this._selectedIndex = (this._selectedIndex - 1 + this._filtered.length) % this._filtered.length;
    this._updateSelection();
  }

  moveDown(): void {
    if (this._filtered.length === 0) return;
    this._selectedIndex = (this._selectedIndex + 1) % this._filtered.length;
    this._updateSelection();
  }

  // ── DOM building ──

  private _buildPopup(commands: CommandDefinition[]): HTMLElement {
    const popup = document.createElement('div');
    popup.className = 'slash-popup';

    // Header
    const header = document.createElement('div');
    header.className = 'slash-popup-header';
    header.innerHTML = '<span>Commands</span><kbd>Esc</kbd>';
    popup.appendChild(header);

    // List
    this._listEl = document.createElement('div');
    this._listEl.className = 'slash-popup-list';
    popup.appendChild(this._listEl);

    return popup;
  }

  private _renderList(): void {
    if (!this._listEl) return;
    this._listEl.innerHTML = '';

    if (this._filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-popup-empty';
      empty.textContent = 'No matching commands';
      this._listEl.appendChild(empty);
      return;
    }

    for (let i = 0; i < this._filtered.length; i++) {
      const cmd = this._filtered[i];
      const item = document.createElement('div');
      item.className = 'slash-popup-item' + (i === this._selectedIndex ? ' selected' : '');
      item.setAttribute('data-index', String(i));

      // Icon
      const icon = document.createElement('span');
      icon.className = 'slash-popup-icon';
      icon.textContent = this._iconForCategory(cmd.category);
      item.appendChild(icon);

      // Text block
      const text = document.createElement('div');
      text.className = 'slash-popup-text';

      const name = document.createElement('span');
      name.className = 'slash-popup-name';
      name.textContent = `/${cmd.name}`;
      text.appendChild(name);

      const desc = document.createElement('span');
      desc.className = 'slash-popup-desc';
      desc.textContent = cmd.description;
      text.appendChild(desc);

      item.appendChild(text);

      // Category badge
      const badge = document.createElement('span');
      badge.className = 'slash-popup-category';
      badge.textContent = cmd.category;
      item.appendChild(badge);

      // Click handler
      const idx = i;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectedIndex = idx;
        this._confirmSelection();
      });

      this._listEl.appendChild(item);
    }
  }

  private _applyFilter(query: string): void {
    this._filtered = filterCommands(query, this._commands);
    this._renderList();
  }

  private _updateSelection(): void {
    if (!this._listEl) return;
    const items = this._listEl.querySelectorAll('.slash-popup-item');
    items.forEach((el, i) => {
      el.classList.toggle('selected', i === this._selectedIndex);
    });
    // Scroll selected into view
    const selected = items[this._selectedIndex] as HTMLElement | undefined;
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  private _confirmSelection(): void {
    const cmd = this.selectedCommand;
    if (cmd) {
      this.emit('commandSelected', cmd.name);
    }
    this.close();
  }

  // ── Positioning ──

  private _position(): void {
    if (!this._el || !this._textarea) return;
    const rect = this._textarea.getBoundingClientRect();
    this._el.style.position = 'fixed';
    this._el.style.left = `${rect.left}px`;
    this._el.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    this._el.style.width = `${Math.max(rect.width, 280)}px`;
  }

  // ── Helpers ──

  private _iconForCategory(cat: string): string {
    switch (cat) {
      case 'project': return 'P';
      case 'session': return 'S';
      case 'workspace': return 'W';
      case 'help': return '?';
      default: return '•';
    }
  }
}
