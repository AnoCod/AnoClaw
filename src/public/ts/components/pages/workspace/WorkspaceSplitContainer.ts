// WorkspaceSplitContainer.ts — Manages 1-2 WorkspaceTabGroup instances with split-view.

import { WorkspaceTabGroup } from './WorkspaceTabGroup.js';

export class WorkspaceSplitContainer {
  readonly element: HTMLElement;
  private _primary: WorkspaceTabGroup;
  private _secondary: WorkspaceTabGroup|null = null;
  private _grip: HTMLElement|null = null;
  private _workspacePath = '';

  get primaryGroup(): WorkspaceTabGroup { return this._primary; }
  get secondaryGroup(): WorkspaceTabGroup|null { return this._secondary; }
  get hasSplit(): boolean { return this._secondary !== null; }

  constructor() {
    this.element = document.createElement('div'); this.element.className = 'ws-split-container';
    this._primary = new WorkspaceTabGroup(); this._primary.element.classList.add('ws-split-primary');
    this._primary.setPersistenceScope('primary');
    this.element.appendChild(this._primary.element);
  }

  // ── Split / close split ──

  splitRight(sessionId: string): void {
    if (this._secondary) return;
    const tab = this._primary.activeTab;
    if (!tab) return;

    this._secondary = new WorkspaceTabGroup();
    this._secondary.element.classList.add('ws-split-secondary');
    this._secondary.setPersistenceScope('secondary');
    this._secondary.setSessionId(sessionId);
    this._secondary.setWorkspacePath(this._workspacePath);
    this._secondary.element.style.flex = '1';
    this._primary.element.style.flex = '1';
    this._primary.element.style.minWidth = '200px';

    this._grip = document.createElement('div');
    this._grip.className = 'ws-resize-grip';
    this.element.appendChild(this._grip);
    this.element.appendChild(this._secondary.element);

    // Move the active tab from primary to secondary
    this._primary.closeTab(tab.path);
    if (tab.fileType === 'browser' && (tab as any).browserUrl) {
      void this._secondary.newBrowserTab((tab as any).browserUrl);
    } else {
      void this._secondary.openFile(tab.path, tab.name);
    }

    this._wireGrip();
  }

  closeSplit(): void {
    if (!this._secondary) return;
    this._secondary.dispose(); this._secondary = null;
    if (this._grip) { this._grip.remove(); this._grip = null; }
    this._primary.element.style.flex = '';
    this._primary.element.style.minWidth = '';
  }

  private _wireGrip(): void {
    if (!this._grip || !this._secondary) return;
    const grip = this._grip;
    const left = this._primary.element;
    const right = this._secondary.element;
    let dragging = false, startX = 0, startLeftW = 0;
    grip.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startLeftW = left.getBoundingClientRect().width;
      grip.style.background = 'var(--color-hairline-strong)';
      document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(200, Math.min(this.element.getBoundingClientRect().width - 200, startLeftW + e.clientX - startX));
      left.style.flex = 'none'; left.style.width = w + 'px'; right.style.flex = '1';
    });
    window.addEventListener('mouseup', () => {
      dragging = false; grip.style.background = '';
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    });
  }

  // ── Delegation to primary / both groups ──

  setSessionId(id: string): void {
    this._primary.setSessionId(id);
    if (this._secondary) this._secondary.setSessionId(id);
  }

  setWorkspacePath(path: string): void {
    this._workspacePath = path;
    this._primary.setWorkspacePath(path);
    if (this._secondary) this._secondary.setWorkspacePath(path);
  }

  set onOpenFile(fn: ((path: string, name: string) => void) | null) {
    this._primary.onOpenFile = fn;
    if (this._secondary) this._secondary.onOpenFile = fn;
  }

  set onEditorContextChange(fn: (() => void) | null) {
    this._primary.onEditorContextChange = fn;
    if (this._secondary) this._secondary.onEditorContextChange = fn;
  }

  getEditorContext() {
    return this._primary.getEditorContext();
  }

  async saveActiveFile(): Promise<void> {
    await this._primary.saveActiveFile();
    if (this._secondary) await this._secondary.saveActiveFile();
  }

  dispose(): void {
    this._primary.dispose();
    if (this._secondary) { this._secondary.dispose(); this._secondary = null; }
    if (this._grip) { this._grip.remove(); this._grip = null; }
  }

  async checkForExternalChanges(): Promise<void> {
    await this._primary.checkForExternalChanges();
    if (this._secondary) await this._secondary.checkForExternalChanges();
  }

  get activeTab(): WorkspaceTabGroup['activeTab'] {
    return this._primary.activeTab;
  }

  get activePath(): string|null {
    return this._primary.activePath;
  }

  get hasTabs(): boolean {
    return this._primary.hasTabs || (this._secondary?.hasTabs ?? false);
  }

  /** Agent browser tab entry point — delegates to primary. */
  _createBrowserTab(url: string, viewId: string): void {
    this._primary._createBrowserTab(url, viewId);
  }
}
