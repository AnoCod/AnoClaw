
// Extracted from SessionsPage.ts to keep the main page class under 500 lines.


import { App } from '../../app.js';
import { handlePathClick } from '../../utils/ClickablePathHandler.js';
import { BackgroundTasksTab } from '../tabs/BackgroundTasksTab.js';
import { ToastManager } from '../../ToastManager.js';
import { slotRegistry } from '../../SlotRegistry.js';
import { ArtifactPanel } from './ArtifactPanel.js';

export class SessionsPageOverfly {
  private _panel: HTMLElement | null = null;
  private _currentPanel: string | null = null;
  private _activeSessionId: string | null = null;
  private _workspacePath: string = '';
  private _clickHandler: ((e: MouseEvent) => void) | null = null;
  private _artifactPanel: ArtifactPanel | null = null;

  get isOpen(): boolean { return this._panel !== null; }

  show(panel: string, activeSessionId: string | null, workspacePath?: string): void {
    console.log('[Overfly] show panel:', panel, 'session:', activeSessionId);
    this.close();

    this._currentPanel = panel;
    this._activeSessionId = activeSessionId;
    this._workspacePath = workspacePath || '';

    const overfly = document.createElement('div');
    overfly.className = 'cinema-overfly';
    const openedAt = Date.now();


    const overflySlot = document.createElement('div');
    overflySlot.setAttribute('data-slot', 'sessions-overfly');
    overfly.appendChild(overflySlot);

    this._panel = overfly;
    document.body.appendChild(overfly);

    // Drain pending mounts for this dynamic slot
    slotRegistry._onSlotReady('sessions-overfly');

    // Click delegation for file paths and external URLs
    this._clickHandler = (e: MouseEvent) => {
      handlePathClick(e, this._workspacePath);
    };
    overfly.addEventListener('click', this._clickHandler);

    switch (panel) {
      case 'overview': this._renderOverviewPanel(overfly, activeSessionId); break;
      case 'artifacts': this._renderArtifactsPanel(overfly, activeSessionId); break;
      case 'plan': this._renderPlanPanel(overfly); break;
      case 'tasks': this._renderTasksPanel(overfly, activeSessionId); break;
      default:
        this.close();
        return;
    }


    // and streaming DOM updates don't spuriously trigger close.
    setTimeout(() => {
      const onOutsideClick = (e: MouseEvent) => {
        if (!this._panel) {
          document.removeEventListener('click', onOutsideClick);
          return;
        }
        // Grace period: ignore clicks in the first 300ms (panel still rendering)
        if (Date.now() - openedAt < 300) return;
        // Ignore synthetic/programmatic clicks
        if (!e.isTrusted) return;
        const target = e.target as HTMLElement;
        if (!this._panel.contains(target) && !target.closest('.cinema-edge-icon')) {
          this.close();
        }
      };
      document.addEventListener('click', onOutsideClick);
    }, 0);
  }

  close(): void {
    console.log('[Overfly] close');
    if (this._artifactPanel) { this._artifactPanel.dispose(); this._artifactPanel = null; }
    if (this._panel) { this._panel.remove(); this._panel = null; }
    this._currentPanel = null;
    this._activeSessionId = null;
  }



  private _renderOverviewPanel(overfly: HTMLElement, activeSessionId: string | null): void {
    const title = document.createElement('div');
    title.className = 'cinema-overfly-title';
    title.textContent = 'Session Overview';
    overfly.appendChild(title);

    const convVM = App.getInstance().conversationVM;
    const agent = convVM.getAgent(activeSessionId || '');
    const msgs = agent.state.messages.messages || [];
    const stats = {
      messages: msgs.length,
      tools: msgs.filter((m: any) => m.type === 'tool_call').length,
      thinks: msgs.filter((m: any) => m.type === 'think').length,
      users: msgs.filter((m: any) => m.role === 'user').length,
    };

    const items = [
      { label: 'Messages', value: stats.messages },
      { label: 'User Messages', value: stats.users },
      { label: 'Tool Calls', value: stats.tools },
      { label: 'Thinking Steps', value: stats.thinks },
      { label: 'Session ID', value: activeSessionId?.slice(0, 8) || '-', mono: true },
    ];

    for (const item of items) {
      if (typeof item.value === 'number' && item.value === 0) continue;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:11px;';
      row.innerHTML = `
        <span style="color:var(--cinema-text-welcome)">${item.label}</span>
        <span style="color:var(--cinema-text-btn);font-family:${item.mono ? 'var(--font-mono)' : 'var(--font-sans)'};font-size:${item.mono ? '9px' : '11px'}">${item.value}</span>
      `;
      overfly.appendChild(row);
    }
  }

  private _renderArtifactsPanel(overfly: HTMLElement, activeSessionId: string | null): void {
    const host = document.createElement('div');
    overfly.appendChild(host);
    this._artifactPanel = new ArtifactPanel(host, activeSessionId);
  }



  private _renderPlanPanel(overfly: HTMLElement): void {
    const title = document.createElement('div');
    title.className = 'cinema-overfly-title';
    title.textContent = 'Plan';
    overfly.appendChild(title);

    const convVM = App.getInstance().conversationVM;
    const agent = convVM.getAgent(this._activeSessionId || '');
    const msgs = agent.state.messages.messages || [];
    const latestTodos = [...msgs].reverse().find((m: any) => m.type === 'todo_write' && Array.isArray(m.todos)) as any;
    const latestPlanBoundary = [...msgs].reverse().find((m: any) => m.type === 'plan_enter' || m.type === 'plan_exit') as any;
    const todos = Array.isArray(latestTodos?.todos) ? latestTodos.todos : [];

    if (!todos.length && !latestPlanBoundary) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--cinema-text-welcome-desc);font-size:11px;padding:12px;text-align:center;';
      empty.textContent = 'No active plan';
      overfly.appendChild(empty);
      return;
    }

    if (latestPlanBoundary) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:4px 0;font-size:11px;';
      const isExit = latestPlanBoundary.type === 'plan_exit';
      row.innerHTML = `
        <span style="color:${isExit ? 'var(--cinema-text-muted)' : 'var(--color-success)'}">${isExit ? '[done]' : '[active]'}</span>
        <span style="color:var(--cinema-text-overlay)">${_esc(isExit ? 'Plan mode exited' : (latestPlanBoundary.planTitle || latestPlanBoundary.content || 'Plan mode active'))}</span>
      `;
      overfly.appendChild(row);
    }

    for (const todo of todos) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:4px 0;font-size:11px;';
      const status = String(todo.status || 'pending');
      const marker = status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
      row.innerHTML = `
        <span style="color:${status === 'completed' ? 'var(--color-success)' : status === 'in_progress' ? 'var(--color-warning, #ffc533)' : 'var(--cinema-text-muted)'}">${marker}</span>
        <span style="color:var(--cinema-text-overlay)">${_esc(String(todo.content || ''))}</span>
      `;
      overfly.appendChild(row);
    }
  }



  private _renderTasksPanel(overfly: HTMLElement, activeSessionId: string | null): void {
    const title = document.createElement('div');
    title.className = 'cinema-overfly-title';
    title.textContent = 'Background Tasks';
    overfly.appendChild(title);

    const container = document.createElement('div');
    overfly.appendChild(container);

    new BackgroundTasksTab(container, activeSessionId || '');
  }
}



function _esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
