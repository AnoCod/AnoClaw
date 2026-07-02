// AnoClaw Cinema — TodoWriteDelegate: noticeable but borderless todo panel
// Subtle surface lift (like edge bar bg), no border. Cinema first, function second.

import type { TodoWriteEvent, TodoItem, TodoStatus } from '../types.js';

export class TodoWriteDelegate {
  element: HTMLElement;

  constructor(event: TodoWriteEvent) {
    this.element = this.render(event);
  }

  render(event: TodoWriteEvent): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = `
      margin-bottom: var(--space-sm);
      border-radius: 4px;
      background: var(--cinema-bg-subtle);
      overflow: hidden;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      font-size: 10px; color: var(--cinema-text-edge);
      letter-spacing: 1px; text-transform: uppercase;
    `;

    const dot = document.createElement('span');
    dot.style.cssText = `width:4px;height:4px;border-radius:50%;flex-shrink:0;background:var(--cinema-text-welcome);`;
    header.appendChild(dot);

    const label = document.createElement('span');
    const counts = this._summarize(event.todos);
    label.textContent = 'TODO' + (counts ? ` · ${counts}` : '');
    label.style.cssText = 'flex:1;';
    header.appendChild(label);
    card.appendChild(header);

    // Todo items
    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'padding: 4px 14px 10px;';

    for (const todo of event.todos) {
      listContainer.appendChild(this._row(todo));
    }
    card.appendChild(listContainer);
    return card;
  }

  private _row(todo: TodoItem): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex; align-items: flex-start; gap: 8px;
      padding: 3px 0; font-size: 12px;
    `;

    const statusColors: Record<TodoStatus, string> = {
      pending:     'var(--cinema-text-muted)',
      in_progress: 'var(--color-accent)',
      completed:   'rgba(89,212,153,0.5)',
    };
    const icons: Record<TodoStatus, string> = { pending: '○', in_progress: '◉', completed: '●' };

    const icon = document.createElement('span');
    icon.textContent = icons[todo.status];
    icon.style.cssText = `flex-shrink:0;width:18px;text-align:center;font-size:11px;color:${statusColors[todo.status]};`;
    row.appendChild(icon);

    const text = document.createElement('span');
    text.textContent = todo.activeForm || todo.content;
    text.style.cssText = `
      flex:1; color: var(--cinema-text-btn); line-height: 1.5;
    `;
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
    return parts.join(' · ');
  }
}
