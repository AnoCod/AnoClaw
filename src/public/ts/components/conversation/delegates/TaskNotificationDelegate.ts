// AnoClaw Cinema — TaskNotificationDelegate: background task completion/failure card
// Displays as a colored notification card in the chat flow.

export interface TaskNotificationData {
  subSessionId: string;
  subAgentId: string;
  status: 'completed' | 'failed';
  summary: string;
  result: string;
}

export class TaskNotificationDelegate {
  element: HTMLElement;

  constructor(data: TaskNotificationData) {
    this.element = this._build(data);

    // Fire desktop notification
    const w = window as any;
    if (w.electronAPI?.showNotification) {
      const title = data.status === 'completed'
        ? `Completed: ${data.summary}`
        : `Failed: ${data.summary}`;
      w.electronAPI.showNotification(title, data.result.slice(0, 200)).catch(() => {});
    }
  }

  private _build(data: TaskNotificationData): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'task-notification-card';
    wrapper.setAttribute('data-status', data.status);

    const borderColor = data.status === 'completed'
      ? 'var(--color-success, #4ade80)'
      : 'var(--color-error, #f87171)';

    wrapper.style.cssText = `
      margin: 8px 0;
      padding: 10px 14px;
      border-left: 3px solid ${borderColor};
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      font-size: 13px;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; gap: 6px;
      font-weight: 600; margin-bottom: 4px;
      color: var(--color-text-primary, #eee);
    `;
    const statusLabel = data.status === 'completed' ? 'Task completed' : 'Task failed';
    const agentName = data.subAgentId || 'sub-agent';
    header.textContent = `${statusLabel}: ${agentName} — ${data.summary}`;
    wrapper.appendChild(header);

    if (data.result) {
      const body = document.createElement('div');
      body.style.cssText = `
        color: var(--color-text-secondary, #aaa);
        font-size: 12px; max-height: 120px; overflow-y: auto;
        white-space: pre-wrap; word-break: break-word;
      `;
      body.textContent = data.result.slice(0, 500);
      wrapper.appendChild(body);
    }

    return wrapper;
  }
}
