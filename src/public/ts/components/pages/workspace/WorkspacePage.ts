// WorkspacePage.ts — Workspace page: file tree + tab container with Monaco + browser tabs.

import type { Page } from '../../../types.js';
import { App } from '../../../app.js';
import { pageRegistry } from '../../../PageRegistry.js';
import { WorkspaceFileTree } from './WorkspaceFileTree.js';
import { WorkspaceTabGroup } from './WorkspaceTabGroup.js';
import { WorkspaceSplitContainer } from './WorkspaceSplitContainer.js';
import { WorkspaceBindingDialog } from '../../WorkspaceBindingDialog.js';
import { ToastManager } from '../../../ToastManager.js';

interface AgentBrowserEvent {
  sessionId: string;
  viewId: string;
  action: string;
  phase: 'start' | 'done' | 'error';
  url?: string;
  selector?: string;
  valuePreview?: string;
  resultPreview?: string;
  error?: string;
  timestamp: number;
}

interface WorkspaceFileLinkEvent {
  path: string;
  sessionId?: string;
  line?: number;
  column?: number;
}

function openAgentBrowserInWorkspace(detail: Partial<AgentBrowserEvent>): void {
  const { url, viewId } = detail;
  if (!viewId) return;

  if (pageRegistry.currentPage !== 'workspace') { pageRegistry.navigateTo('workspace'); }

  let tries = 0;
  const cb = () => {
    const page = pageRegistry.getPage('workspace') as WorkspacePage | undefined;
    const g = page?._browserGroup();
    if (g) { g.handleAgentBrowserEvent(detail as AgentBrowserEvent); return; }
    if (++tries < 30) setTimeout(cb, 200);
  };
  setTimeout(cb, 300);
}

// Legacy renderer bridge kept for callers that dispatch this custom event.
window.addEventListener('ws-open-browser-internal', (e: Event) => {
  openAgentBrowserInWorkspace((e as CustomEvent).detail || {});
});

function openFileLinkInWorkspace(detail: Partial<WorkspaceFileLinkEvent>): void {
  const path = String(detail.path || '').trim();
  if (!path) return;

  const app = App.getInstance();
  if (detail.sessionId && app.sessionVM?.activeSessionId !== detail.sessionId) {
    app.sessionVM?.selectSession(detail.sessionId);
  }
  if (pageRegistry.currentPage !== 'workspace') pageRegistry.navigateTo('workspace');

  let tries = 0;
  const tryOpen = async () => {
    const page = pageRegistry.getPage('workspace') as WorkspacePage | undefined;
    if (page && await page.openLinkedFile({
      path,
      sessionId: detail.sessionId,
      line: detail.line,
      column: detail.column,
    })) return;
    if (++tries < 30) setTimeout(() => { void tryOpen(); }, 200);
  };
  setTimeout(() => { void tryOpen(); }, 0);
}

window.addEventListener('ws-open-workspace-file', (e: Event) => {
  openFileLinkInWorkspace((e as CustomEvent).detail || {});
});

const electronApi = (window as any).electronAPI;
if (electronApi?.onAgentBrowserEvent) {
  electronApi.onAgentBrowserEvent((event: AgentBrowserEvent) => openAgentBrowserInWorkspace(event));
}

export class WorkspacePage implements Page {
  name = 'workspace';
  container: HTMLElement;
  private _sessionId = '';
  private _loadGeneration = 0;
  private _loadAbortController: AbortController | null = null;
  private _workspacePath = '';
  private _toolbarPath!: HTMLElement;
  private _fileTree!: WorkspaceFileTree;
  private _treeGrip!: HTMLElement;
  private _tabMount!: HTMLElement;
  private _currentGroup: WorkspaceSplitContainer | null = null;
  private _onSessionChange: ((node: any) => void) | null = null;
  private _onRevealWorkspacePath: ((event: Event) => void) | null = null;
  private _onWorkspaceDownloadComplete: ((event: Event) => void) | null = null;
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

    const toolbarTitle = document.createElement('div');
    toolbarTitle.className = 'ws-toolbar-title';
    const toolbarKicker = document.createElement('span');
    toolbarKicker.className = 'ws-toolbar-kicker';
    toolbarKicker.textContent = 'Workspace';
    toolbarTitle.appendChild(toolbarKicker);

    this._toolbarPath = document.createElement('span');
    this._toolbarPath.className = 'ws-toolbar-path';
    this._toolbarPath.textContent = 'No workspace';
    toolbarTitle.appendChild(this._toolbarPath);
    toolbar.appendChild(toolbarTitle);

    const switchBtn = document.createElement('button');
    switchBtn.className = 'ws-toolbar-btn'; switchBtn.textContent = 'Switch';
    switchBtn.addEventListener('click', () => void this._switchWorkspace());
    toolbar.appendChild(switchBtn);
    this.container.appendChild(toolbar);

    const content = document.createElement('div');
    content.className = 'ws-content';
    this._fileTree = new WorkspaceFileTree((path, name) => this._openFile(path, name));
    this._fileTree.beforePathDelete = async path => this._currentGroup?.prepareForPathRemoval(path) ?? true;
    this._fileTree.onPathRenamed = (oldPath, newPath) => this._currentGroup?.handlePathRenamed(oldPath, newPath);
    this._fileTree.onPathDeleted = path => this._currentGroup?.handlePathDeleted(path);
    content.appendChild(this._fileTree.element);
    this._treeGrip = document.createElement('div');
    this._treeGrip.className = 'ws-resize-grip';
    content.appendChild(this._treeGrip);
    this._wireTreeGrip();
    this._tabMount = document.createElement('div');
    this._tabMount.className = 'ws-tab-mount';
    content.appendChild(this._tabMount);
    this._showWorkspaceIdle();
    this.container.appendChild(content);
  }

  onEnter(): void {
    if (this._onSessionChange) { App.getInstance().sessionVM?.off('sessionSelected', this._onSessionChange); this._onSessionChange = null; }
    if (this._onRevealWorkspacePath) { window.removeEventListener('ws-reveal-workspace-path', this._onRevealWorkspacePath); this._onRevealWorkspacePath = null; }
    if (this._onWorkspaceDownloadComplete) { window.removeEventListener('ws-workspace-download-complete', this._onWorkspaceDownloadComplete); this._onWorkspaceDownloadComplete = null; }
    this._onSessionChange = () => { void this._onSessionSwitched(); };
    App.getInstance().sessionVM?.on('sessionSelected', this._onSessionChange);
    this._onRevealWorkspacePath = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      void this._revealWorkspacePath(String(detail.path || ''), Boolean(detail.open));
    };
    this._onWorkspaceDownloadComplete = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      void this._revealWorkspacePath(String(detail.relativePath || detail.path || ''), false);
    };
    window.addEventListener('ws-reveal-workspace-path', this._onRevealWorkspacePath);
    window.addEventListener('ws-workspace-download-complete', this._onWorkspaceDownloadComplete);
    const sid = App.getInstance().sessionVM?.activeSessionId || '';
    if (sid) { void this._loadWorkspaceForSession(sid); }
    else { this._sessionId = ''; this._workspacePath = ''; this._toolbarPath.textContent = 'No workspace'; this._showWorkspaceIdle(); }
  }

  onExit(): void {
    try {
      if (this._onSessionChange) { App.getInstance().sessionVM?.off('sessionSelected', this._onSessionChange); this._onSessionChange = null; }
      if (this._onRevealWorkspacePath) { window.removeEventListener('ws-reveal-workspace-path', this._onRevealWorkspacePath); this._onRevealWorkspacePath = null; }
      if (this._onWorkspaceDownloadComplete) { window.removeEventListener('ws-workspace-download-complete', this._onWorkspaceDownloadComplete); this._onWorkspaceDownloadComplete = null; }
      if (this._extChangeTimer) { clearInterval(this._extChangeTimer); this._extChangeTimer = 0; }
      this._loadGeneration++;
      this._loadAbortController?.abort();
      this._loadAbortController = null;
      this._fileTree.suspend();
      for (const group of this._tabCache.values()) group.suspend();
    } catch { console.debug('WorkspacePage: onExit cleanup failed'); }
  }

  private async _onSessionSwitched(): Promise<void> {
    const newSid = App.getInstance().sessionVM?.activeSessionId || '';
    if (!newSid) {
      this._sessionId = '';
      this._workspacePath = '';
      this._toolbarPath.textContent = 'No workspace';
      this._fileTree.suspend();
      this._showWorkspaceIdle();
      return;
    }
    if (newSid === this._sessionId) return;
    await this._loadWorkspaceForSession(newSid);
  }

  private async _loadWorkspaceForSession(sid: string): Promise<void> {
    const generation = ++this._loadGeneration;
    this._loadAbortController?.abort();
    const controller = new AbortController();
    this._loadAbortController = controller;
    try {
      const resp = await fetch(`/api/v1/sessions/${encodeURIComponent(sid)}/workspace`, { signal: controller.signal });
      if (!resp.ok) return;
      const newPath = (await resp.json()).workspace || '';
      if (generation !== this._loadGeneration || App.getInstance().sessionVM?.activeSessionId !== sid) return;
      if (this._sessionId && this._currentGroup?.hasTabs) { this._tabCache.set(this._sessionId, this._currentGroup); }
      this._sessionId = sid; this._workspacePath = newPath;
      App.getInstance().sessionVM?.updateSessionWorkspace(sid, newPath);
      this._toolbarPath.textContent = newPath || 'Default workspace';
      await this._fileTree.loadRoot(sid);
      if (generation !== this._loadGeneration || App.getInstance().sessionVM?.activeSessionId !== sid) return;
      if (this._currentGroup) { this._currentGroup.element.remove(); }
      const cached = this._tabCache.get(sid);
      if (cached) { cached.setSessionId(sid); cached.setWorkspacePath(newPath); this._currentGroup = cached; }
      else {
        this._currentGroup = new WorkspaceSplitContainer();
        this._currentGroup.setSessionId(sid);
        this._currentGroup.setWorkspacePath(newPath);
        this._tabCache.set(sid, this._currentGroup);
      }
      this._currentGroup.onOpenFile = (path, name) => this._openFile(path, name);
      this._tabMount.innerHTML = '';
      this._tabMount.appendChild(this._currentGroup.element);
      this._currentGroup.resume();
      // Wire editor context push
      this._currentGroup.onEditorContextChange = () => this._pushEditorContext();
      // Push initial context
      setTimeout(() => this._pushEditorContext(), 500);
      // Start polling for external changes (Agent edits)
      this._startExternalChangePolling();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.debug('WorkspacePage: failed to load workspace for session', sid);
      }
    } finally {
      if (this._loadAbortController === controller) this._loadAbortController = null;
    }
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
    if (this._currentGroup && !await this._currentGroup.prepareToDiscardAll('switching workspaces')) return;
    try {
      const resp = await fetch(`/api/v1/sessions/${encodeURIComponent(this._sessionId)}/bind-workspace`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: result.path }) });
      if (!resp.ok) throw new Error(`Workspace binding failed (HTTP ${resp.status})`);
      const payload = await resp.json() as { workspace?: string };
      const boundPath = payload.workspace || result.path;
      this._workspacePath = boundPath;
      App.getInstance().sessionVM?.updateSessionWorkspace(this._sessionId, boundPath);
      this._toolbarPath.textContent = boundPath || 'Default workspace';
      this._tabCache.get(this._sessionId)?.dispose(); this._tabCache.delete(this._sessionId); this._currentGroup = null;
      this._tabMount.innerHTML = '';
      const fresh = new WorkspaceSplitContainer(); fresh.setSessionId(this._sessionId);
      fresh.setWorkspacePath(boundPath);
      fresh.onOpenFile = (path, name) => this._openFile(path, name);
      fresh.onEditorContextChange = () => this._pushEditorContext();
      this._tabCache.set(this._sessionId, fresh); this._currentGroup = fresh;
      this._tabMount.appendChild(fresh.element);
      await this._fileTree.loadRoot(this._sessionId);
      this._startExternalChangePolling();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Workspace switch failed';
      ToastManager.getInstance().error(message);
      console.debug('WorkspacePage: session switch cleanup failed');
    }
  }

  private _openFile(path: string, name: string): void {
    if (this._currentGroup) { void this._currentGroup.primaryGroup.openFile(path, name); }
  }

  async openLinkedFile(detail: WorkspaceFileLinkEvent): Promise<boolean> {
    if (!this._currentGroup || !this._sessionId) return false;
    if (detail.sessionId && detail.sessionId !== this._sessionId) return false;

    await this._fileTree.revealPath(detail.path);
    await this._currentGroup.primaryGroup.openFile(
      detail.path,
      detail.path.split('/').pop() || detail.path,
      detail.line,
      detail.column,
    );
    return true;
  }

  private async _revealWorkspacePath(path: string, open: boolean): Promise<void> {
    if (!path || !this._sessionId) return;
    await this._fileTree.revealPath(path);
    if (open) this._openFile(path, path.split('/').pop() || path);
  }

  private _wireTreeGrip(): void {
    const grip = this._treeGrip; const tree = this._fileTree.element;
    let dragging = false, startX = 0, startW = 0;
    grip.addEventListener('mousedown', (e) => { dragging = true; startX = e.clientX; startW = tree.getBoundingClientRect().width; grip.style.background = 'var(--color-hairline-strong)'; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!dragging) return; tree.style.width = Math.max(150, startW + e.clientX - startX) + 'px'; tree.style.flexShrink = '0'; });
    window.addEventListener('mouseup', () => { dragging = false; grip.style.background = ''; document.body.style.cursor = ''; document.body.style.userSelect = ''; });
  }

  private _showWorkspaceIdle(): void {
    this._tabMount.innerHTML = `
      <div class="ws-editor-empty ws-editor-empty--workspace">
        <div class="ws-editor-empty-panel">
          <div class="ws-editor-empty-mark"></div>
          <div class="ws-editor-empty-title">No file open</div>
          <div class="ws-editor-empty-meta">Workspace editor idle</div>
        </div>
      </div>`;
  }
}
