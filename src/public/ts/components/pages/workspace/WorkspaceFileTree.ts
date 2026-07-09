// WorkspaceFileTree.ts — Recursive file tree component for Workspace page.

import type { FileEntry } from '../../../types.js';

/** Local alias using isDirectory for convenience; maps from FileEntry type field. */
type FileNode = FileEntry & { isDirectory?: boolean; modifiedAt?: string };
type TreeFilter = 'all' | 'files' | 'folders';

export class WorkspaceFileTree {
  readonly element: HTMLElement;
  private _onFileOpen: (path:string, name:string)=>void;
  private _sessionId = '';
  private _contextMenu: HTMLElement|null = null;
  private _nodeMap = new Map<string, HTMLElement>();
  private _treeBody: HTMLElement;
  private _searchInput: HTMLInputElement;
  private _treeMeta: HTMLElement;
  private _refreshBtn: HTMLButtonElement;
  private _createButtons: HTMLButtonElement[] = [];
  private _filterButtons = new Map<TreeFilter, HTMLButtonElement>();
  private _rootNodes: FileNode[] = [];
  private _filterMode: TreeFilter = 'all';
  private _searchQuery = '';
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

    const panelHead = document.createElement('div');
    panelHead.className = 'ws-tree-panel-head';

    // Header
    const header = document.createElement('div');
    header.className = 'ws-tree-header';
    const label = document.createElement('span');
    label.textContent = 'Files';
    label.className = 'ws-tree-label';
    header.appendChild(label);

    // New File button
    const newFileBtn = document.createElement('button');
    newFileBtn.className = 'ws-tree-action-btn ws-tree-create-btn';
    newFileBtn.innerHTML = _SVG_FILE_PLUS;
    newFileBtn.title = 'New File';
    this._createButtons.push(newFileBtn);
    newFileBtn.addEventListener('click', (e) => { e.stopPropagation(); void this._createFile('/'); });
    header.appendChild(newFileBtn);

    // New Folder button
    const newFolderBtn = document.createElement('button');
    newFolderBtn.className = 'ws-tree-action-btn ws-tree-create-btn';
    newFolderBtn.innerHTML = _SVG_FOLDER_PLUS;
    newFolderBtn.title = 'New Folder';
    this._createButtons.push(newFolderBtn);
    newFolderBtn.addEventListener('click', (e) => { e.stopPropagation(); void this._createFolder('/'); });
    header.appendChild(newFolderBtn);

    this._refreshBtn = document.createElement('button');
    this._refreshBtn.className = 'ws-tree-refresh-btn ws-tree-action-btn';
    this._refreshBtn.innerHTML = _SVG_REFRESH;
    this._refreshBtn.title = 'Refresh file tree';
    this._refreshBtn.addEventListener('click', () => { this.refreshAll(); });
    header.appendChild(this._refreshBtn);
    panelHead.appendChild(header);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'ws-tree-search';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'ws-tree-search-icon';
    searchIcon.innerHTML = _SVG_SEARCH;
    searchWrap.appendChild(searchIcon);

    this._searchInput = document.createElement('input');
    this._searchInput.className = 'ws-tree-search-input';
    this._searchInput.type = 'search';
    this._searchInput.placeholder = 'Search current folder';
    this._searchInput.spellcheck = false;
    this._searchInput.addEventListener('input', () => {
      this._searchQuery = this._searchInput.value.trim().toLowerCase();
      searchWrap.classList.toggle('has-value', this._searchQuery.length > 0);
      void this._renderRootNodes(false);
    });
    searchWrap.appendChild(this._searchInput);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'ws-tree-search-clear';
    clearBtn.type = 'button';
    clearBtn.title = 'Clear search';
    clearBtn.innerHTML = _SVG_X;
    clearBtn.addEventListener('click', () => {
      if (!this._searchInput.value) return;
      this._searchInput.value = '';
      this._searchQuery = '';
      searchWrap.classList.remove('has-value');
      this._searchInput.focus();
      void this._renderRootNodes(false);
    });
    searchWrap.appendChild(clearBtn);
    panelHead.appendChild(searchWrap);

    const filterRow = document.createElement('div');
    filterRow.className = 'ws-tree-filter-row';
    const filters: Array<{ mode: TreeFilter; label: string }> = [
      { mode: 'all', label: 'All' },
      { mode: 'files', label: 'Files' },
      { mode: 'folders', label: 'Folders' },
    ];
    for (const filter of filters) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-tree-filter-chip';
      btn.dataset.filter = filter.mode;
      btn.addEventListener('click', () => {
        if (this._filterMode === filter.mode) return;
        this._filterMode = filter.mode;
        this._syncFilterButtons();
        void this._renderRootNodes(false);
      });
      filterRow.appendChild(btn);
      this._filterButtons.set(filter.mode, btn);
    }
    panelHead.appendChild(filterRow);

    this._treeMeta = document.createElement('div');
    this._treeMeta.className = 'ws-tree-meta';
    panelHead.appendChild(this._treeMeta);
    this.element.appendChild(panelHead);

    // Scrollable tree body
    this._treeBody = document.createElement('div');
    this._treeBody.className = 'ws-tree-body';
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
    this._rootNodes = [];
    this._expandedPaths.clear();
    this._lastFileFingerprint = '';
    this._syncFilterButtons();
    this._updateTreeMeta(0, 0);
    if (!sessionId) {
      this._setUnavailable(true);
      this._showEmpty('No workspace', 'Bind a workspace to browse files.');
      return;
    }
    this._setUnavailable(false);
    await this._doLoadRoot();
    this._startPolling();
  }

  private async _doLoadRoot(): Promise<void> {
    try {
      const resp = await fetch(`/api/v1/workspace/browse?sessionId=${encodeURIComponent(this._sessionId)}&path=/`);
      if (!resp.ok) {
        this._setUnavailable(true);
        this._updateTreeMeta(0, 0);
        this._showEmpty('No workspace', 'Bind a workspace to browse files.');
        return;
      }
      this._setUnavailable(false);
      this._treeBody.innerHTML = '';
      this._nodeMap.clear();
      const nodes = (await resp.json()).nodes || [];
      this._lastFileFingerprint = nodes.map((n: FileNode) => `${n.path}|${n.modifiedAt||''}|${n.isDirectory?'d':'f'}`).sort().join(',');
      this._rootNodes = nodes;
      this._fileCount = nodes.length;
      await this._renderRootNodes(true);
    } catch {
      this._setUnavailable(true);
      this._showEmpty('Workspace unavailable', 'Refresh after binding a folder.');
      console.debug('WorkspaceFileTree: loadRoot failed');
    }
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
        this._rootNodes = nodes;
        this._fileCount = nodes.length;
        await this._renderRootNodes(true);
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
    if (!dirPath || dirPath === '/') {
      await this._doLoadRoot();
      return;
    }
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

  private async _renderRootNodes(restoreExpanded: boolean): Promise<void> {
    this._treeBody.innerHTML = '';
    this._nodeMap.clear();
    this._syncFilterButtons();

    const filtered = this._filteredRootNodes();
    this._updateTreeMeta(filtered.length, this._rootNodes.length);

    if (this._rootNodes.length === 0) {
      this._showEmpty('Empty folder', 'No files in this workspace.');
      return;
    }
    if (filtered.length === 0) {
      this._showEmpty('No matches', 'Try a different search or filter.');
      return;
    }

    this._renderNodes(filtered, this._treeBody, 0);
    if (restoreExpanded && this._filterMode === 'all' && !this._searchQuery) {
      await this._restoreExpandedState();
    }
  }

  private _filteredRootNodes(): FileNode[] {
    const query = this._searchQuery;
    return this._rootNodes.filter((node) => {
      if (this._filterMode === 'files' && node.isDirectory) return false;
      if (this._filterMode === 'folders' && !node.isDirectory) return false;
      if (!query) return true;
      return `${node.name} ${node.path}`.toLowerCase().includes(query);
    });
  }

  private _syncFilterButtons(): void {
    const counts: Record<TreeFilter, number> = {
      all: this._rootNodes.length,
      files: this._rootNodes.filter((node) => !node.isDirectory).length,
      folders: this._rootNodes.filter((node) => node.isDirectory).length,
    };
    const labels: Record<TreeFilter, string> = {
      all: 'All',
      files: 'Files',
      folders: 'Folders',
    };
    this._filterButtons.forEach((btn, mode) => {
      btn.classList.toggle('active', this._filterMode === mode);
      btn.innerHTML = `<span>${labels[mode]}</span><strong>${counts[mode]}</strong>`;
    });
  }

  private _updateTreeMeta(visible: number, total: number): void {
    if (!this._treeMeta) return;
    if (total === 0) {
      this._treeMeta.textContent = 'No entries';
      return;
    }
    const folders = this._rootNodes.filter((node) => node.isDirectory).length;
    const files = Math.max(0, total - folders);
    const filtered = visible !== total || this._filterMode !== 'all' || !!this._searchQuery;
    this._treeMeta.textContent = filtered
      ? `${visible} of ${total} shown`
      : `${folders} folders / ${files} files`;
  }

  private _showEmpty(title: string, subtitle: string): void {
    this._treeBody.innerHTML = `<div class="ws-tree-empty"><div class="ws-tree-empty-mark">${_SVG_FOLDER}</div><span>${_esc(title)}</span><small>${_esc(subtitle)}</small></div>`;
  }

  private _setUnavailable(disabled: boolean): void {
    this.element.classList.toggle('is-unavailable', disabled);
    this._searchInput.disabled = disabled;
    for (const btn of this._createButtons) btn.disabled = disabled;
    this._filterButtons.forEach((btn) => { btn.disabled = disabled; });
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

const _SVG_FOLDER = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/></svg>`;
const _SVG_FILE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 3.5H7A2 2 0 0 0 5 5.5v13A2 2 0 0 0 7 20.5h10a2 2 0 0 0 2-2V8Z"/><path d="M14.5 3.5V8H19"/></svg>`;
const _SVG_CODE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 8-4 4 4 4"/><path d="m14 16 4-4-4-4"/></svg>`;
const _SVG_BRACES = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>`;
const _SVG_MARKDOWN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15V9l3 3 3-3v6"/><path d="M17 9v6"/><path d="m15 13 2 2 2-2"/></svg>`;
const _SVG_IMAGE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.4"/><path d="m20.5 15-4.2-4.2L6 20"/></svg>`;
const _SVG_FILE_PLUS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 3.5H7A2 2 0 0 0 5 5.5v13A2 2 0 0 0 7 20.5h10a2 2 0 0 0 2-2V8Z"/><path d="M14.5 3.5V8H19"/><path d="M12 12v5"/><path d="M9.5 14.5h5"/></svg>`;
const _SVG_FOLDER_PLUS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2.5h7.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/><path d="M12 11v5"/><path d="M9.5 13.5h5"/></svg>`;
const _SVG_REFRESH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 16v5h5"/><path d="M3 12A9 9 0 0 1 18.5 5.7L21 8"/><path d="M21 8V3h-5"/></svg>`;
const _SVG_SEARCH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>`;
const _SVG_X = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const _SVG_CHEVRON_RIGHT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
const _SVG_TS = _SVG_CODE;
const _SVG_JS = _SVG_CODE;
const _SVG_JSON = _SVG_BRACES;
const _SVG_CSS = _SVG_CODE;
const _SVG_HTML = _SVG_CODE;
const _SVG_MD = _SVG_MARKDOWN;
const _SVG_PY = _SVG_CODE;
