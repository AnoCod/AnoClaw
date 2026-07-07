// WorkspaceFileTree.ts — Recursive file tree component for Workspace page.

import type { FileEntry } from '../../../types.js';

/** Local alias using isDirectory for convenience; maps from FileEntry type field. */
type FileNode = FileEntry & { isDirectory?: boolean; modifiedAt?: string };

export class WorkspaceFileTree {
  readonly element: HTMLElement;
  private _onFileOpen: (path:string, name:string)=>void;
  private _sessionId = '';
  private _contextMenu: HTMLElement|null = null;
  private _nodeMap = new Map<string, HTMLElement>();
  private _treeBody: HTMLElement;
  private _refreshBtn: HTMLElement;
  private _pollTimer = 0;
  private _fileCount = 0;
  private _selectedPath = '';
  // Expand-state preservation: track which directory paths are expanded
  private _expandedPaths = new Set<string>();
  private _lastExpandTime = 0;
  private _lastFileFingerprint = '';

  constructor(onFileOpen: (path:string, name:string)=>void) {
    this.element = document.createElement('div'); this.element.className = 'ws-file-tree-pane';
    this._onFileOpen = onFileOpen;

    // Header
    const header = document.createElement('div');
    header.className = 'ws-tree-header';
    header.style.cssText = 'display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid var(--color-hairline,#242728);flex-shrink:0;';
    const label = document.createElement('span');
    label.textContent = 'Files';
    label.style.cssText = 'font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--color-text-secondary,#9c9c9d);flex:1;';
    header.appendChild(label);

    // New File button
    const newFileBtn = document.createElement('button');
    newFileBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
    newFileBtn.title = 'New File';
    newFileBtn.style.cssText = 'border:none;background:transparent;color:var(--color-text-tertiary,#6a6b6c);cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;';
    newFileBtn.addEventListener('click', (e) => { e.stopPropagation(); void this._createFile('/'); });
    header.appendChild(newFileBtn);

    // New Folder button
    const newFolderBtn = document.createElement('button');
    newFolderBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`;
    newFolderBtn.title = 'New Folder';
    newFolderBtn.style.cssText = 'border:none;background:transparent;color:var(--color-text-tertiary,#6a6b6c);cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;';
    newFolderBtn.addEventListener('click', (e) => { e.stopPropagation(); void this._createFolder('/'); });
    header.appendChild(newFolderBtn);

    this._refreshBtn = document.createElement('button');
    this._refreshBtn.className = 'ws-tree-refresh-btn';
    this._refreshBtn.innerHTML = _SVG_REFRESH;
    this._refreshBtn.title = 'Refresh file tree';
    this._refreshBtn.style.cssText = 'border:none;background:transparent;color:var(--color-text-tertiary,#6a6b6c);cursor:pointer;padding:2px 4px;border-radius:4px;display:flex;align-items:center;';
    this._refreshBtn.addEventListener('click', () => { this.refreshAll(); });
    header.appendChild(this._refreshBtn);
    this.element.appendChild(header);

    // Scrollable tree body
    this._treeBody = document.createElement('div');
    this._treeBody.style.cssText = 'overflow-y:auto;flex:1;min-height:0;';
    this._treeBody.tabIndex = 0; // make focusable for keyboard events
    this.element.appendChild(this._treeBody);

    // Keyboard shortcuts
    this._treeBody.addEventListener('keydown', (e) => {
      if (!this._selectedPath) return;
      if (e.key === 'Delete') {
        e.preventDefault();
        const name = this._selectedPath.split('/').pop() || '';
        if (name) { void this._deleteByName(this._selectedPath, name); }
      } else if (e.key === 'F2') {
        e.preventDefault();
        void this._renameByPath(this._selectedPath);
      }
    });
  }

  async loadRoot(sessionId: string): Promise<void> {
    this._sessionId = sessionId; this._treeBody.innerHTML = ''; this._nodeMap.clear();
    this._expandedPaths.clear();
    this._lastFileFingerprint = '';
    if (!sessionId) return;
    await this._doLoadRoot();
    this._startPolling();
  }

  private async _doLoadRoot(): Promise<void> {
    try {
      const resp = await fetch(`/api/v1/workspace/browse?sessionId=${encodeURIComponent(this._sessionId)}&path=/`);
      if (!resp.ok) return;
      this._treeBody.innerHTML = '';
      this._nodeMap.clear();
      const nodes = (await resp.json()).nodes || [];
      this._fileCount = nodes.length;
      this._lastFileFingerprint = nodes.map((n: FileNode) => `${n.path}|${n.modifiedAt||''}|${n.isDirectory?'d':'f'}`).sort().join(',');
      if (nodes.length === 0) {
        this._treeBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--color-text-tertiary,#6a6b6c);font-size:12px;">Empty folder<br><span style="font-size:10px;opacity:0.6;">Right-click or use + buttons above</span></div>';
        return;
      }
      this._renderNodes(nodes, this._treeBody, 0);
      await this._restoreExpandedState();
    } catch { console.debug('WorkspaceFileTree: loadRoot failed'); }
  }

  private _startPolling(): void {
    this._stopPolling();
    // Check every 5 seconds for external changes. Preserves expand state.
    this._pollTimer = window.setInterval(async () => {
      try {
        // Cooldown: skip if user manually expanded a folder within last 2 seconds
        if (Date.now() - this._lastExpandTime < 2000) return;
        const resp = await fetch(`/api/v1/workspace/browse?sessionId=${encodeURIComponent(this._sessionId)}&path=/`);
        if (!resp.ok) return;
        const nodes = (await resp.json()).nodes || [];
        // Fingerprint: path + mtime + type. Skip DOM update if nothing changed.
        const fingerprint = nodes.map((n: FileNode) => `${n.path}|${n.modifiedAt||''}|${n.isDirectory?'d':'f'}`).sort().join(',');
        if (fingerprint === this._lastFileFingerprint) return;
        this._lastFileFingerprint = fingerprint;
        this._fileCount = nodes.length;
        // Re-render root, then restore all expanded directories
        this._treeBody.innerHTML = '';
        this._nodeMap.clear();
        if (nodes.length === 0) {
          this._treeBody.innerHTML = '<div style="padding:20px;text-align:center;color:var(--color-text-tertiary,#6a6b6c);font-size:12px;">Empty folder<br><span style="font-size:10px;opacity:0.6;">Right-click or use + buttons above</span></div>';
          return;
        }
        this._renderNodes(nodes, this._treeBody, 0);
        await this._restoreExpandedState();
      } catch { console.debug('WorkspaceFileTree: poll refresh failed'); }
    }, 5000);
  }

  private _stopPolling(): void {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = 0; }
  }

  refreshAll(): void {
    if (this._sessionId) { void this._doLoadRoot(); }
  }

  async refreshDirectory(dirPath: string): Promise<void> {
    const wrapper = this._nodeMap.get(dirPath); if (!wrapper) return;
    const childContainer = wrapper.querySelector('.ws-tree-children') as HTMLElement; if (!childContainer) return;
    try {
      const resp = await fetch(`/api/v1/workspace/browse?sessionId=${encodeURIComponent(this._sessionId)}&path=${encodeURIComponent(dirPath)}`);
      if (!resp.ok) return;
      childContainer.innerHTML = '';
      this._renderNodes((await resp.json()).nodes||[], childContainer, 0);
    } catch { console.debug('WorkspaceFileTree: refreshDirectory failed for', dirPath); }
  }

  async revealPath(filePath: string): Promise<void> {
    if (!this._sessionId || !filePath) return;
    const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return;
    const parts = normalized.split('/').filter(Boolean);
    let parent = '';
    for (let i = 0; i < parts.length - 1; i++) {
      parent = parent ? `${parent}/${parts[i]}` : parts[i];
      this._expandedPaths.add(parent);
    }
    await this._doLoadRoot();
    const target = this._nodeMap.get(normalized);
    if (!target) return;
    const row = target.classList.contains('ws-tree-node')
      ? target
      : target.firstElementChild as HTMLElement | null;
    if (!row || !row.classList.contains('ws-tree-node')) return;
    this._treeBody.querySelectorAll('.ws-tree-node.selected').forEach(el => el.classList.remove('selected'));
    row.classList.add('selected');
    this._selectedPath = normalized;
    row.scrollIntoView({ block: 'center' });
  }

  // Restore expanded state after a full tree rebuild (polling / refreshAll).
  // Uses iterative deepening: expand parent dirs first, then children become available.
  private async _restoreExpandedState(): Promise<void> {
    if (this._expandedPaths.size === 0) return;
    const remaining = new Set(this._expandedPaths);
    let madeProgress = true;
    while (remaining.size > 0 && madeProgress) {
      madeProgress = false;
      // Sort shallow-first so parent directories expand before their children
      const sorted = [...remaining].sort((a, b) =>
        a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length
      );
      for (const path of sorted) {
        const wrapper = this._nodeMap.get(path);
        if (!wrapper) continue; // not in DOM yet — try next iteration after parent expands
        const childContainer = wrapper.querySelector('.ws-tree-children') as HTMLElement;
        const arrow = wrapper.querySelector('.ws-tree-arrow');
        if (!childContainer || !arrow) { remaining.delete(path); continue; }
        const depth = path.split('/').filter(Boolean).length;
        await this._loadDirChildren(path, childContainer, depth);
        childContainer.style.display = '';
        arrow.classList.add('expanded');
        remaining.delete(path);
        madeProgress = true;
      }
    }
    // Clean up stale entries (directories that no longer exist)
    for (const path of remaining) {
      this._expandedPaths.delete(path);
    }
  }

  private _renderNodes(nodes: FileNode[], parent: HTMLElement, depth: number): void {
    const dirs = nodes.filter(n => n.isDirectory), files = nodes.filter(n => !n.isDirectory);
    for (const node of [...dirs, ...files]) parent.appendChild(this._buildNodeRow(node, depth));
  }

  private _buildNodeRow(node: FileNode, depth: number): HTMLElement {
    const row = document.createElement('div'); row.className = 'ws-tree-node';
    row.style.paddingLeft = (8 + depth*16) + 'px'; row.title = node.path;

    const arrow = document.createElement('span'); arrow.className = 'ws-tree-arrow';
    if (node.isDirectory) arrow.innerHTML = _SVG_CHEVRON_RIGHT;
    row.appendChild(arrow);

    const icon = document.createElement('span'); icon.className = 'ws-tree-icon';
    icon.innerHTML = node.isDirectory ? _SVG_FOLDER : _fileIcon(node.name);
    row.appendChild(icon);

    const name = document.createElement('span'); name.className = 'ws-tree-name'; name.textContent = node.name;
    row.appendChild(name);

    if (node.size !== undefined && !node.isDirectory) {
      const size = document.createElement('span'); size.className = 'ws-tree-size'; size.textContent = _fmtSize(node.size);
      row.appendChild(size);
    }

    let childContainer: HTMLElement|null = null;
    if (node.isDirectory) { childContainer = document.createElement('div'); childContainer.className = 'ws-tree-children'; childContainer.style.display = 'none'; }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      this._treeBody.querySelectorAll('.ws-tree-node.selected').forEach(el => el.classList.remove('selected'));
      row.classList.add('selected');
      this._selectedPath = node.path;
      if (node.isDirectory && childContainer) {
        const isOpen = childContainer.style.display !== 'none';
        if (isOpen) { childContainer.style.display = 'none'; arrow.classList.remove('expanded'); this._expandedPaths.delete(node.path); }
        else { childContainer.style.display = ''; arrow.classList.add('expanded'); this._expandedPaths.add(node.path); this._lastExpandTime = Date.now(); if (childContainer.children.length===0) this._loadDirChildren(node.path, childContainer, depth+1); }
      }
    });

    row.addEventListener('dblclick', (e) => { e.stopPropagation(); if (!node.isDirectory) this._onFileOpen(node.path, node.name); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this._showContextMenu(e.clientX, e.clientY, node); });

    // Drag & drop — only for files
    if (!node.isDirectory) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('text/plain', node.path);
        e.dataTransfer!.effectAllowed = 'move';
        row.style.opacity = '0.4';
      });
      row.addEventListener('dragend', () => { row.style.opacity = ''; });
    }

    // Drop target — only directories can receive drops
    if (node.isDirectory && childContainer) {
      row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move'; row.style.background = 'rgba(255,255,255,0.04)'; });
      row.addEventListener('dragleave', () => { row.style.background = ''; });
      row.addEventListener('drop', (e) => {
        e.preventDefault(); row.style.background = '';
        const srcPath = e.dataTransfer!.getData('text/plain');
        if (!srcPath || srcPath === node.path) return;
        void this._moveFile(srcPath, node.path);
      });
    }

    if (childContainer) {
      const wrapper = document.createElement('div'); wrapper.appendChild(row); wrapper.appendChild(childContainer);
      this._nodeMap.set(node.path, wrapper);
      return wrapper;
    }
    this._nodeMap.set(node.path, row);
    return row;
  }

  private async _loadDirChildren(dirPath: string, container: HTMLElement, depth: number): Promise<void> {
    try {
      const resp = await fetch(`/api/v1/workspace/browse?sessionId=${encodeURIComponent(this._sessionId)}&path=${encodeURIComponent(dirPath)}`);
      if (!resp.ok) return;
      container.innerHTML = '';
      this._renderNodes((await resp.json()).nodes||[], container, depth);
    } catch { console.debug('WorkspaceFileTree: _loadDirChildren failed for', dirPath); }
  }

  private _showContextMenu(x:number, y:number, node:FileNode): void {
    this._closeContextMenu();
    const menu = document.createElement('div'); menu.className = 'ws-tree-context-menu';
    menu.style.left = x+'px'; menu.style.top = y+'px';
    const items: Array<{label:string;cls?:string;action:()=>void}> = [];
    if (!node.isDirectory) items.push({label:'Open', action:()=>this._onFileOpen(node.path, node.name)});
    if (node.isDirectory) { items.push({label:'New File', action:()=>this._createFile(node.path)}); items.push({label:'New Folder', action:()=>this._createFolder(node.path)}); }
    if (!node.isDirectory) {
      items.push({label:'Agent: Review File', action:()=>this._askAgent('Review', node)});
      items.push({label:'Agent: Find Bugs', action:()=>this._askAgent('FindBugs', node)});
      items.push({label:'Agent: Explain File', action:()=>this._askAgent('Explain', node)});
    }
    items.push({label:'Rename', action:()=>this._rename(node)}, {label:'Delete', cls:'danger', action:()=>this._delete(node)});
    menu.innerHTML = items.map((it,i) => {
      const divider = i===1 && !node.isDirectory ? '<div class="ws-tree-context-divider"></div>' : '';
      return `${divider}<div class="ws-tree-context-item${it.cls?' '+it.cls:''}" data-action="${i}">${it.label}</div>`;
    }).join('');
    document.body.appendChild(menu); this._contextMenu = menu;
    menu.querySelectorAll('[data-action]').forEach(el => { const i = parseInt(el.getAttribute('data-action')||'0'); el.addEventListener('click', () => { this._closeContextMenu(); items[i]?.action(); }); });
    setTimeout(() => { document.addEventListener('click', () => this._closeContextMenu(), { once: true }); }, 0);
  }

  private _closeContextMenu(): void { if (this._contextMenu) { this._contextMenu.remove(); this._contextMenu = null; } }

  private _askAgent(action: string, node: FileNode): void {
    this._closeContextMenu();
    const ext = node.name.split('.').pop()?.toLowerCase() || '';
    window.dispatchEvent(new CustomEvent('ws-ask-agent', {
      detail: { action, activeFile: node.path, fileName: node.name, language: ext, selectedText: '' },
    }));
  }

  private async _createFile(parentPath:string): Promise<void> {
    const name = await this._prompt('File name:', 'new-file.txt'); if (!name) return;
    await fetch('/api/v1/workspace/create-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:this._sessionId,path:parentPath,name})}); this.refreshDirectory(parentPath);
  }
  private async _createFolder(parentPath:string): Promise<void> {
    const name = await this._prompt('Folder name:', 'new-folder'); if (!name) return;
    await fetch('/api/v1/workspace/create-dir',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:this._sessionId,path:parentPath,name})}); this.refreshDirectory(parentPath);
  }
  private async _rename(node:FileNode): Promise<void> {
    const newName = await this._prompt('New name:', node.name); if (!newName||newName===node.name) return;
    await fetch('/api/v1/workspace/rename',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:this._sessionId,path:node.path,newName})});
    const parentPath = node.path.substring(0,node.path.lastIndexOf('/'))||'/'; this.refreshDirectory(parentPath);
  }
  private async _delete(node:FileNode): Promise<void> {
    const ok = await this._confirm(`Delete ${node.name}?`); if (!ok) return;
    await this._deleteByName(node.path, node.name);
  }

  private async _deleteByName(filePath: string, name: string): Promise<void> {
    await fetch(`/api/v1/workspace/file?path=${encodeURIComponent(filePath)}&sessionId=${encodeURIComponent(this._sessionId)}`,{method:'DELETE'});
    const parentPath = filePath.substring(0,filePath.lastIndexOf('/'))||'/'; this.refreshDirectory(parentPath);
    if (this._selectedPath === filePath) this._selectedPath = '';
  }

  private async _renameByPath(filePath: string): Promise<void> {
    const name = filePath.split('/').pop() || '';
    const newName = await this._prompt('New name:', name); if (!newName||newName===name) return;
    await fetch('/api/v1/workspace/rename',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:this._sessionId,path:filePath,newName})});
    const parentPath = filePath.substring(0,filePath.lastIndexOf('/'))||'/';
    if (this._selectedPath === filePath) this._selectedPath = parentPath + '/' + newName;
    this.refreshDirectory(parentPath);
  }

  private async _moveFile(srcPath: string, destDir: string): Promise<void> {
    await fetch('/api/v1/workspace/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:this._sessionId,source:srcPath,destDir})});
    this.refreshAll();
  }

  private _prompt(title: string, defaultValue: string): Promise<string> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(''); } });
      const card = document.createElement('div');
      card.className = 'dialog';
      card.innerHTML = `<h2 class="dialog-title">${_esc(title)}</h2><input id="ws-ftp" type="text" class="dialog-input" value="${_esc(defaultValue)}" autofocus style="width:100%;padding:6px 10px;background:var(--color-bg);border:1px solid var(--color-hairline);border-radius:6px;color:var(--color-text);font-size:13px;font-family:inherit;outline:none;margin:8px 0;box-sizing:border-box;"><div class="dialog-actions"><button class="btn-dialog-cancel">Cancel</button><button class="btn-dialog-confirm">OK</button></div>`;
      overlay.appendChild(card); document.body.appendChild(overlay);
      const field = card.querySelector('#ws-ftp') as HTMLInputElement;
      field.focus(); field.select();
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { overlay.remove(); resolve(field.value); } });
      card.querySelector('.btn-dialog-confirm')?.addEventListener('click', () => { overlay.remove(); resolve(field.value); });
      card.querySelector('.btn-dialog-cancel')?.addEventListener('click', () => { overlay.remove(); resolve(''); });
    });
  }

  private _confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
      const card = document.createElement('div');
      card.className = 'dialog';
      card.innerHTML = `<h2 class="dialog-title">Confirm</h2><p class="dialog-message">${_esc(message)}</p><div class="dialog-actions"><button class="btn-dialog-cancel">Cancel</button><button class="btn-dialog-confirm">Delete</button></div>`;
      overlay.appendChild(card); document.body.appendChild(overlay);
      card.querySelector('.btn-dialog-confirm')?.addEventListener('click', () => { overlay.remove(); resolve(true); });
      card.querySelector('.btn-dialog-cancel')?.addEventListener('click', () => { overlay.remove(); resolve(false); });
    });
  }
}

const _IMG_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico']);
function _fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()||'';
  if (_IMG_EXTS.has(ext)) return _SVG_IMAGE;
  if (ext==='ts'||ext==='tsx') return _SVG_TS; if (ext==='js'||ext==='jsx') return _SVG_JS;
  if (ext==='json') return _SVG_JSON; if (ext==='css') return _SVG_CSS;
  if (ext==='html') return _SVG_HTML; if (ext==='md') return _SVG_MD; if (ext==='py') return _SVG_PY;
  return _SVG_FILE;
}
function _fmtSize(bytes:number):string { if (bytes<1024) return `${bytes}B`; if (bytes<1048576) return `${(bytes/1024).toFixed(1)}KB`; return `${(bytes/1048576).toFixed(1)}MB`; }
function _esc(s:string):string { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const _SVG_FOLDER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffc533" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const _SVG_FILE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_TS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3178c6" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_JS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f7df1e" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_JSON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f4f4f6" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_CSS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#42a5f5" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_HTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e44d26" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_MD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#59d499" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_PY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffd43b" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const _SVG_IMAGE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#57c1ff" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
const _SVG_REFRESH = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 16v5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.7L21 8"/><path d="M21 8V3h-5"/></svg>`;
const _SVG_CHEVRON_RIGHT = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
