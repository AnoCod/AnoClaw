import { BackgroundTaskStore, type TaskEntry } from '../../viewmodel/BackgroundTaskStore.js';

export class BackgroundTasksTab {
  container: HTMLElement;
  private _store: BackgroundTaskStore;
  private _parentSessionId: string;
  private _onChanged: () => void;

  constructor(container: HTMLElement, parentSessionId: string) {
    this.container = container;
    this._parentSessionId = parentSessionId;
    this._store = BackgroundTaskStore.getInstance();
    this._onChanged = () => this._render();
    this._render();
    this._store.on('changed', this._onChanged);
  }

  setParentSessionId(sid: string): void {
    this._parentSessionId = sid;
    this._render();
  }

  private _render(): void {
    const tasks = this._store.getByParent(this._parentSessionId);
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:6px;';

    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:24px 16px;color:var(--color-text-secondary);font-size:13px;text-align:center;line-height:1.6;';
      empty.textContent = 'No background tasks yet.\nWhen an agent runs background work (bash commands, sub-agents, async operations), they will appear here with live status updates.';
      wrapper.appendChild(empty);
      this.container.appendChild(wrapper);
      return;
    }

    for (const task of tasks) {
      wrapper.appendChild(this._buildCard(task));
    }

    this.container.appendChild(wrapper);
  }

  private _buildCard(task: TaskEntry): HTMLElement {
    const el = document.createElement('div');
    el.className = 'task-panel-card';
    el.setAttribute('data-status', task.status);

    const statusColors: Record<string, string> = {
      running: '#60a5fa',
      completed: '#4ade80',
      failed: '#f87171',
      killed: '#fbbf24',
    };
    const statusLabels: Record<string, string> = {
      running: 'Running',
      completed: 'Done',
      failed: 'Failed',
      killed: 'Stopped',
    };
    const color = statusColors[task.status] || '#888';
    const label = statusLabels[task.status] || task.status;
    const elapsed = task.durationMs ? ` (${(task.durationMs / 1000).toFixed(1)}s)` : '';
    const started = new Date(task.startedAt).toLocaleTimeString();
    const isRunning = task.status === 'running';

    el.style.cssText = `
      padding: 10px 14px;
      border-left: 3px solid ${color};
      background: rgba(255,255,255,0.03);
      border-radius: 6px;
      font-size: 13px;
    `;

    // Header row
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;';

    const dot = document.createElement('span');
    dot.style.cssText = `
      display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};
      ${isRunning ? 'animation:pulse 1.5s infinite;' : ''}
      flex-shrink:0;
    `;
    header.appendChild(dot);

    const title = document.createElement('strong');
    title.textContent = this._esc(task.summary);
    header.appendChild(title);

    const meta = document.createElement('span');
    meta.style.cssText = 'margin-left:auto;color:var(--color-text-secondary);font-size:11px;';
    meta.textContent = `${label} · ${started}${elapsed}`;
    header.appendChild(meta);

    el.appendChild(header);

    // Command line (bash tasks)
    if (task.taskType === 'bash' && task.command) {
      const cmd = document.createElement('div');
      cmd.style.cssText = 'color:var(--color-text-secondary);font-size:11px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;';
      cmd.textContent = `$ ${task.command}`;
      el.appendChild(cmd);
    }

    // Progress (running subagent)
    if (task.taskType === 'subagent' && task.status === 'running' && task.currentTool) {
      const prog = document.createElement('div');
      prog.style.cssText = 'color:var(--color-text-secondary);font-size:11px;margin-top:2px;';
      prog.textContent = `Tool: ${task.currentTool} | Turn: ${task.turnCount ?? '-'}`;
      el.appendChild(prog);
    }

    // Error
    if (task.error) {
      const err = document.createElement('div');
      err.style.cssText = 'color:#f87171;font-size:11px;margin-top:4px;white-space:pre-wrap;word-break:break-word;';
      err.textContent = task.error;
      el.appendChild(err);
    }

    return el;
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  destroy(): void {
    this._store.off('changed', this._onChanged);
  }
}
