/**
 * TaskNotificationDelegate — background task completion/failure card.
 * Displays as a colored notification card in the chat flow.
 */

export interface TaskNotificationData {
  subSessionId: string;
  subAgentId: string;
  status: 'completed' | 'failed';
  summary: string;
  result: string;
}

export class TaskNotificationDelegate {
  element: HTMLElement;

  constructor(data: TaskNotificationData, options: { notify?: boolean } = {}) {
    this.element = this._build(data);

    // Desktop notifications are only for newly-arrived live events, never history replay.
    const w = window as any;
    if (options.notify && w.electronAPI?.showNotification) {
      const title = data.status === 'completed'
        ? `Completed: ${data.summary}`
        : `Failed: ${data.summary}`;
      w.electronAPI.showNotification(title, data.result.slice(0, 200)).catch(() => {});
    }
  }

  /** Update in-place: refresh border colour, header text, and body content. */
  update(data: TaskNotificationData): void {
    const status = data.status;
    this.element.setAttribute('data-status', status);
    const borderColor = status === 'completed'
      ? 'var(--color-success, #4ade80)'
      : 'var(--color-error, #f87171)';
    this.element.style.borderLeftColor = borderColor;

    const header = this.element.firstElementChild as HTMLElement | null;
    if (header) {
      const agentName = data.subAgentId || 'sub-agent';
      header.textContent = `${status === 'completed' ? 'Task completed' : 'Task failed'}: ${agentName} — ${data.summary}`;
    }
    let body = this.element.querySelector<HTMLElement>('.task-notification-body');
    if (data.result) {
      if (!body) {
        body = this._buildBody();
        this.element.appendChild(body);
      }
      body.textContent = data.result.slice(0, 500);
    } else if (body) {
      body.remove();
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
      const body = this._buildBody();
      body.textContent = data.result.slice(0, 500);
      wrapper.appendChild(body);
    }

    return wrapper;
  }

  private _buildBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'task-notification-body';
    body.style.cssText = `
      color: var(--color-text-secondary, #aaa);
      font-size: 12px; max-height: 120px; overflow-y: auto;
      white-space: pre-wrap; word-break: break-word;
    `;
    return body;
  }
}
