/**
 * TodoWriteDelegate - compact todo timeline card.
 * Expands while a todo is active, collapses when all items are done/pending.
 */

import type { TodoWriteEvent, TodoItem, TodoStatus } from '../types.js';

export class TodoWriteDelegate {
  element: HTMLElement;
  private _expanded = false;
  private _listEl: HTMLElement | null = null;

  constructor(event: TodoWriteEvent) {
    this._expanded = event.todos.some(t => t.status === 'in_progress');
    this.element = this.render(event);
    if (!this._expanded) this.collapse();
  }

  render(event: TodoWriteEvent): HTMLElement {
    const card = document.createElement('div');
    card.className = 'todo-write-card';
    card.style.cssText = `
      margin-bottom: var(--space-sm);
      border-radius: 4px;
      background: var(--cinema-bg-subtle);
      overflow: hidden;
    `;

    const header = document.createElement('button');
    header.type = 'button';
    header.style.cssText = `
      width: 100%; border: 0; background: transparent;
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      font-size: 10px; color: var(--cinema-text-edge);
      letter-spacing: 1px; text-transform: uppercase;
      font-family: inherit; cursor: pointer; text-align: left;
    `;
    header.addEventListener('click', () => this._toggle());

    const dot = document.createElement('span');
    dot.style.cssText = 'width:4px;height:4px;border-radius:50%;flex-shrink:0;background:var(--cinema-text-welcome);';
    header.appendChild(dot);

    const label = document.createElement('span');
    const counts = this._summarize(event.todos);
    label.textContent = 'TODO' + (counts ? ` - ${counts}` : '');
    label.style.cssText = 'flex:1;';
    header.appendChild(label);

    const toggle = document.createElement('span');
    toggle.className = 'todo-write-toggle';
    toggle.textContent = this._expanded ? '-' : '+';
    toggle.style.cssText = 'opacity:0.55;';
    header.appendChild(toggle);
    card.appendChild(header);

    const listContainer = document.createElement('div');
    listContainer.className = 'todo-write-list';
    listContainer.style.cssText = 'padding: 4px 14px 10px;';
    listContainer.hidden = !this._expanded;

    for (const todo of event.todos) {
      listContainer.appendChild(this._row(todo));
    }
    this._listEl = listContainer;
    card.appendChild(listContainer);
    return card;
  }

  collapse(): void {
    this._expanded = false;
    this.element.classList.add('is-collapsed');
    if (this._listEl) this._listEl.hidden = true;
    const toggle = this.element.querySelector<HTMLElement>('.todo-write-toggle');
    if (toggle) toggle.textContent = '+';
  }

  expand(): void {
    this._expanded = true;
    this.element.classList.remove('is-collapsed');
    if (this._listEl) this._listEl.hidden = false;
    const toggle = this.element.querySelector<HTMLElement>('.todo-write-toggle');
    if (toggle) toggle.textContent = '-';
  }

  private _toggle(): void {
    if (this._expanded) this.collapse();
    else this.expand();
  }

  private _row(todo: TodoItem): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: flex-start; gap: 8px;
      padding: 3px 0; font-size: 12px;
    `;

    const statusColors: Record<TodoStatus, string> = {
      pending: 'var(--cinema-text-muted)',
      in_progress: 'var(--color-warning, #ffc533)',
      completed: 'rgba(89,212,153,0.5)',
    };
    const icons: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

    const icon = document.createElement('span');
    icon.textContent = icons[todo.status];
    icon.style.cssText = `flex-shrink:0;width:18px;text-align:center;font-size:11px;color:${statusColors[todo.status]};`;
    row.appendChild(icon);

    const text = document.createElement('span');
    text.textContent = todo.activeForm || todo.content;
    text.style.cssText = 'flex:1; color: var(--cinema-text-btn); line-height: 1.5;';
    if (todo.status === 'completed') {
      text.style.textDecoration = 'line-through';
      text.style.opacity = '0.4';
    }
    row.appendChild(text);

    return row;
  }

  private _summarize(todos: TodoItem[]): string {
    const done = todos.filter(t => t.status === 'completed').length;
    const active = todos.filter(t => t.status === 'in_progress').length;
    const pending = todos.filter(t => t.status === 'pending').length;
    const parts: string[] = [];
    if (active > 0) parts.push(`${active} active`);
    if (done > 0) parts.push(`${done} done`);
    if (pending > 0) parts.push(`${pending} pending`);
    return parts.join(' - ');
  }
}
