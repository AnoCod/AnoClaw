// WorkspacePage.ts — Workspace page: file tree + tab container with Monaco + browser tabs.

import type { Page } from '../../../types.js';
import { App } from '../../../app.js';
import { pageRegistry } from '../../../PageRegistry.js';
import { WorkspaceFileTree } from './WorkspaceFileTree.js';
import { WorkspaceTabGroup } from './WorkspaceTabGroup.js';
import { WorkspaceSplitContainer } from './WorkspaceSplitContainer.js';
import { WorkspaceBindingDialog } from '../../WorkspaceBindingDialog.js';

// Always-on listener: agent calls wvCreate via executeJavaScript, then dispatches
// this event so the workspace renders the new browser tab.
window.addEventListener('ws-open-browser-internal', (e: Event) => {
  const { url, viewId } = (e as CustomEvent).detail || {} as any;
  if (!url) return;

  if (pageRegistry.currentPage !== 'workspace') { pageRegistry.navigateTo('workspace'); }

  let tries = 0;
  const cb = () => {
    const page = pageRegistry.getPage('workspace') as WorkspacePage | undefined;
    const g = page?._browserGroup();
    if (g) { g._createBrowserTab(url, viewId); return; }
    if (++tries < 30) setTimeout(cb, 200);
  };
  setTimeout(cb, 300);
});

export class WorkspacePage implements Page {
  name = 'workspace';
  container: HTMLElement;
  private _sessionId = '';
  private _workspacePath = '';
  private _toolbarPath!: HTMLElement;
  private _fileTree!: WorkspaceFileTree;
  private _treeGrip!: HTMLElement;
  private _tabMount!: HTMLElement;
  private _currentGroup: WorkspaceSplitContainer | null = null;
  private _onSessionChange: ((node: any) => void) | null = null;
  private _tabCache = new Map<string, WorkspaceSplitContainer>();

  /** Exposed for the global agent browser handler. */
  _browserGroup(): WorkspaceTabGroup | null { return this._currentGroup?.primaryGroup ?? null; }

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'ws-page';
    this.container.style.display = 'none';
    this.container.setAttribute('data-page', 'workspace');
    this._buildDOM();
  }

  private _buildDOM(): void {
    const toolbar = document.createElement('div');
    toolbar.className = 'ws-toolbar';
    this._toolbarPath = document.createElement('span');
    this._toolbarPath.className = 'ws-toolbar-path';
    this._toolbarPath.textContent = 'No workspace';
    toolbar.appendChild(this._toolbarPath);
    const switchBtn = document.createElement('button');
    switchBtn.className = 'ws-toolbar-btn'; switchBtn.textContent = 'Switch...';
    switchBtn.addEventListener('click', () => void this._switchWorkspace());
    toolbar.appendChild(switchBtn);
    this.container.appendChild(toolbar);

    const content = document.createElement('div');
    content.className = 'ws-content';
    this._fileTree = new WorkspaceFileTree((path, name) => this._openFile(path, name));
    content.appendChild(this._fileTree.element);
    this._treeGrip = document.createElement('div');
    this._treeGrip.className = 'ws-resize-grip';
    content.appendChild(this._treeGrip);
    this._wireTreeGrip();
    this._tabMount = document.createElement('div');
    this._tabMount.style.cssText = 'flex:1;min-width:0;display:flex;overflow:hidden;';
    content.appendChild(this._tabMount);
    this.container.appendChild(content);
  }

  onEnter(): void {
    this._onSessionChange = () => { void this._onSessionSwitched(); };
    App.getInstance().sessionVM?.on('sessionSelected', this._onSessionChange);
    const sid = App.getInstance().sessionVM?.activeSessionId || '';
    if (sid) { void this._loadWorkspaceForSession(sid); }
  }

  onExit(): void {
    try {
      if (this._onSessionChange) { App.getInstance().sessionVM?.off('sessionSelected', this._onSessionChange); this._onSessionChange = null; }
      if (this._extChangeTimer) { clearInterval(this._extChangeTimer); this._extChangeTimer = 0; }
      for (const g of this._tabCache.values()) { try { g.dispose(); } catch {} }
      this._tabCache.clear(); this._currentGroup = null;
    } catch {}
  }

  private async _onSessionSwitched(): Promise<void> {
    const newSid = App.getInstance().sessionVM?.activeSessionId || '';
    if (!newSid || newSid === this._sessionId) return;
    await this._loadWorkspaceForSession(newSid);
  }

  private async _loadWorkspaceForSession(sid: string): Promise<void> {
    try {
      const resp = await fetch(`/api/v1/sessions/${encodeURIComponent(sid)}/workspace`);
      if (!resp.ok) return;
      const newPath = (await resp.json()).workspace || '';
      if (this._sessionId && this._currentGroup?.hasTabs) { this._tabCache.set(this._sessionId, this._currentGroup); }
      this._sessionId = sid; this._workspacePath = newPath;
      this._toolbarPath.textContent = newPath || '(default workspace)';
      await this._fileTree.loadRoot(sid);
      if (this._currentGroup) { this._currentGroup.element.remove(); }
      const cached = this._tabCache.get(sid);
      if (cached) { cached.setSessionId(sid); this._currentGroup = cached; }
      else { this._currentGroup = new WorkspaceSplitContainer(); this._currentGroup.setSessionId(sid); this._tabCache.set(sid, this._currentGroup); }
      this._currentGroup.onOpenFile = (path, name) => this._openFile(path, name);
      this._tabMount.innerHTML = '';
      this._tabMount.appendChild(this._currentGroup.element);
      // Wire editor context push
      this._currentGroup.onEditorContextChange = () => this._pushEditorContext();
      // Push initial context
      setTimeout(() => this._pushEditorContext(), 500);
      // Start polling for external changes (Agent edits)
      this._startExternalChangePolling();
    } catch {}
  }

  private _extChangeTimer = 0;

  private _startExternalChangePolling(): void {
    if (this._extChangeTimer) clearInterval(this._extChangeTimer);
    this._extChangeTimer = window.setInterval(() => {
      this._currentGroup?.checkForExternalChanges();
    }, 3000);
  }

  /** Push current editor state to server for prompt injection. */
  private _pushEditorContext(): void {
    if (!this._currentGroup || !this._sessionId) return;
    const ec = this._currentGroup.getEditorContext();
    if (!ec) return;
    const ws = App.getInstance().sessionVM?.getWSClient();
    ws?.sendEditorContext(this._sessionId, ec);
  }

  private async _switchWorkspace(): Promise<void> {
    const dlg = new WorkspaceBindingDialog();
    const result = await dlg.show(this._workspacePath);
    if (!result || !this._sessionId) return;
    try {
      await fetch(`/api/v1/sessions/${encodeURIComponent(this._sessionId)}/bind-workspace`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: result.path }) });
      this._workspacePath = result.path; this._toolbarPath.textContent = result.path;
      this._tabCache.get(this._sessionId)?.dispose(); this._tabCache.delete(this._sessionId); this._currentGroup = null;
      this._tabMount.innerHTML = '';
      const fresh = new WorkspaceSplitContainer(); fresh.setSessionId(this._sessionId);
      fresh.onOpenFile = (path, name) => this._openFile(path, name);
      this._tabCache.set(this._sessionId, fresh); this._currentGroup = fresh;
      this._tabMount.appendChild(fresh.element);
      await this._fileTree.loadRoot(this._sessionId);
    } catch {}
  }

  private _openFile(path: string, name: string): void {
    if (this._currentGroup) { void this._currentGroup.primaryGroup.openFile(path, name); }
  }

  private _wireTreeGrip(): void {
    const grip = this._treeGrip; const tree = this._fileTree.element;
    let dragging = false, startX = 0, startW = 0;
    grip.addEventListener('mousedown', (e) => { dragging = true; startX = e.clientX; startW = tree.getBoundingClientRect().width; grip.style.background = 'var(--color-hairline-strong)'; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!dragging) return; tree.style.width = Math.max(150, startW + e.clientX - startX) + 'px'; tree.style.flexShrink = '0'; });
    window.addEventListener('mouseup', () => { dragging = false; grip.style.background = ''; document.body.style.cursor = ''; document.body.style.userSelect = ''; });
  }
}
