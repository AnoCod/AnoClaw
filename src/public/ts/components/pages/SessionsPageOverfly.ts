// SessionsPageOverfly — right-bar overfly panels (overview, plan)
// Extracted from SessionsPage.ts to keep the main page class under 500 lines.
// Files panel removed — replaced by WorkspacePage.

import { App } from '../../app.js';
import { handlePathClick } from '../../utils/ClickablePathHandler.js';
import { BackgroundTasksTab } from '../tabs/BackgroundTasksTab.js';
import { ToastManager } from '../../ToastManager.js';
import { slotRegistry } from '../../SlotRegistry.js';

export class SessionsPageOverfly {
  private _panel: HTMLElement | null = null;
  private _currentPanel: string | null = null;
  private _activeSessionId: string | null = null;
  private _workspacePath: string = '';
  private _clickHandler: ((e: MouseEvent) => void) | null = null;

  /** Called after files list is refreshed — fires with the file count. Kept for compatibility. */
  onFilesRefreshed: ((count: number) => void) | null = null;

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

    // Slot: sessions-overfly — plugins can add content here
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
      case 'plan': this._renderPlanPanel(overfly); break;
      case 'tasks': this._renderTasksPanel(overfly, activeSessionId); break;
    }

    // Close on outside click — with a 300ms grace period so async renders
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
    if (this._panel) { this._panel.remove(); this._panel = null; }
    this._currentPanel = null;
    this._activeSessionId = null;
  }

  refreshFilesIfOpen(_sessionId: string): void {
    // Files panel moved to WorkspacePage. No-op for compatibility.
  }

  // ── Overview panel ──

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
      { label: 'Session ID', value: activeSessionId?.slice(0, 8) || '—', mono: true },
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

  // ── Plan panel ──

  private _renderPlanPanel(overfly: HTMLElement): void {
    const title = document.createElement('div');
    title.className = 'cinema-overfly-title';
    title.textContent = 'Plan';
    overfly.appendChild(title);

    const convVM = App.getInstance().conversationVM;
    const agent = convVM.getAgent(this._activeSessionId || '');
    const msgs = agent.state.messages.messages || [];
    const planMsgs = msgs.filter((m: any) => m.type === 'plan' || m.type === 'plan_step');

    if (!planMsgs.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--cinema-text-welcome-desc);font-size:11px;padding:12px;text-align:center;';
      empty.textContent = 'No active plan';
      overfly.appendChild(empty);
      return;
    }

    for (const p of planMsgs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:4px 0;font-size:11px;';
      const status = (p as any).status || 'pending';
      const icons: Record<string, string> = { completed: '✓', in_progress: '●', pending: '○', error: '✗' };
      row.innerHTML = `
        <span style="color:${status === 'completed' ? 'var(--color-success)' : status === 'in_progress' ? 'var(--color-accent-cinema)' : 'var(--cinema-text-muted)'}">${icons[status] || '○'}</span>
        <span style="color:var(--cinema-text-overlay)">${_esc((p as any).content || (p as any).description || (p as any).title || '')}</span>
      `;
      overfly.appendChild(row);
    }
  }

  // ── Tasks panel ──

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

// ── Shared helpers ──

function _esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
