// Shared UI: TodoCard — collapsible todo list panel.
// Cinema-style: subtle surface lift, no border, status dots.

export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; }

export interface TodoCardConfig { todos: TodoItem[]; }

export class TodoCard {
  readonly element: HTMLElement;

  constructor(config: TodoCardConfig) {
    const card = document.createElement('div');
    card.className = 'ui-todocard';

    const header = document.createElement('div');
    header.className = 'ui-todocard-header';
    const dot = document.createElement('span'); dot.className = 'ui-todocard-dot'; header.appendChild(dot);
    const label = document.createElement('span'); label.className = 'ui-todocard-label';
    const counts = this._summarize(config.todos);
    label.textContent = 'TODO' + (counts ? ' · ' + counts : '');
    header.appendChild(label);
    card.appendChild(header);

    const list = document.createElement('div'); list.className = 'ui-todocard-list';
    for (const todo of config.todos) list.appendChild(this._row(todo));
    card.appendChild(list);

    this.element = card;
    this._injectStyles();
  }

  private _row(todo: TodoItem): HTMLElement {
    const row = document.createElement('div'); row.className = 'ui-todocard-row';
    const icon = document.createElement('span'); icon.className = 'ui-todocard-icon ' + todo.status;
    const icons: Record<string, string> = { pending: '○', in_progress: '◉', completed: '●' };
    icon.textContent = icons[todo.status] || '○'; row.appendChild(icon);
    const text = document.createElement('span'); text.className = 'ui-todocard-text ' + todo.status;
    text.textContent = todo.activeForm || todo.content; row.appendChild(text);
    return row;
  }

  private _summarize(todos: TodoItem[]): string {
    const d = todos.filter(t => t.status === 'completed').length;
    const a = todos.filter(t => t.status === 'in_progress').length;
    const p = todos.filter(t => t.status === 'pending').length;
    const parts: string[] = [];
    if (a > 0) parts.push(a + ' active');
    if (d > 0) parts.push(d + ' done');
    if (p > 0) parts.push(p + ' pending');
    return parts.join(' · ');
  }

  private _injectStyles(): void {
    if (document.getElementById('ui-todocard-styles')) return;
    const s = document.createElement('style'); s.id = 'ui-todocard-styles';
    s.textContent = `
      .ui-todocard { margin-bottom: var(--space-sm); border-radius: 4px; background: var(--cinema-bg-subtle); overflow: hidden; }
      .ui-todocard-header { display: flex; align-items: center; gap: 8px; padding: 8px 14px; font-size: 10px; color: var(--cinema-text-edge); letter-spacing: 1px; text-transform: uppercase; }
      .ui-todocard-dot { width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0; background: var(--cinema-text-welcome); }
      .ui-todocard-label { flex: 1; }
      .ui-todocard-list { padding: 4px 14px 10px; }
      .ui-todocard-row { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; font-size: 12px; }
      .ui-todocard-icon { flex-shrink: 0; width: 18px; text-align: center; font-size: 11px; }
      .ui-todocard-icon.pending { color: var(--cinema-text-muted); }
      .ui-todocard-icon.in_progress { color: var(--color-warning, #ffc533); }
      .ui-todocard-icon.completed { color: rgba(89,212,153,0.5); }
      .ui-todocard-text { flex: 1; color: var(--cinema-text-btn); line-height: 1.5; }
      .ui-todocard-text.completed { text-decoration: line-through; opacity: 0.4; }
    `;
    document.head.appendChild(s);
  }
}
