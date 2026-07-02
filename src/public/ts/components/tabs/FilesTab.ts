/**
 * FilesTab — workspace file browser with tree, preview, and file operations.
 *
 * Left-right layout: file tree on the left, preview on the right.
 * Supports rename, delete, create file/folder, cut/copy/paste, and drag-drop move.
 * Preview/rendering logic is delegated to {@link FilePreview}.
 *
 * @module FilesTab
 */

import { ClientLogger } from '../../ClientLogger.js';
import { ToastManager } from '../../ToastManager.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { renderMarkdown, highlightCode, getFileExtension, detectLanguage, formatFileSize } from './FilePreview.js';
import { handlePathClick } from '../../utils/ClickablePathHandler.js';

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  size?: number;
  modifiedAt?: string;
}

// ── Inline SVG icons (theme-aware via currentColor) ──

const SVG_FOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

const SVG_FILE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

const SVG_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;

const SVG_CODE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;

export class FilesTab {
  element: HTMLElement;
  readonly treeEl: HTMLElement;
  readonly previewEl: HTMLElement;
  onSendToSession: ((path: string) => void) | null;
  private sessionId: string;
  private _compact: boolean;

  // Clipboard for cut/copy/paste
  private clipboardPath: string | null = null;
  private clipboardOp: 'cut' | 'copy' | null = null;

  // Track the currently selected node for keyboard ops
  private selectedNode: FileNode | null = null;
  private _workspacePath = '';

  constructor(sessionId?: string, options?: { compact?: boolean }) {
    this.onSendToSession = null;
    this.sessionId = sessionId || '';
    this._compact = options?.compact ?? false;
    const { el, tree, preview } = this._build();
    this.element = el;
    this.treeEl = tree;
    this.previewEl = preview;
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  setWorkspacePath(p: string): void {
    this._workspacePath = p;
  }

  // ── Render ──

  /** Build DOM. In compact mode header is omitted — caller provides its own. */
  private _build(): { el: HTMLElement; tree: HTMLElement; preview: HTMLElement } {
    const container = document.createElement('div');
    container.className = 'tab-files';
    container.tabIndex = 0;
    // Compact mode: flex-child in overfly column layout
    if (this._compact) container.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:300px;overflow:hidden;';
    container.addEventListener('keydown', (e) => this._onKeyDown(e));

    // ── Header bar (omitted in compact/overfly mode) ──
    if (!this._compact) {
      const wsBar = document.createElement('div');
      wsBar.className = 'tab-files-header';

      const wsLabel = document.createElement('span');
      wsLabel.className = 'tab-files-header-label';
      wsLabel.textContent = 'No workspace bound';
      wsBar.appendChild(wsLabel);

      const actions = document.createElement('span');
      actions.className = 'tab-files-header-actions';

      const newFileBtn = document.createElement('button');
      newFileBtn.className = 'tab-files-header-btn';
      newFileBtn.textContent = '+File';
      newFileBtn.title = 'Create new file';
      newFileBtn.addEventListener('click', (e) => { e.stopPropagation(); this.createFile(); });
      actions.appendChild(newFileBtn);

      const newFolderBtn = document.createElement('button');
      newFolderBtn.className = 'tab-files-header-btn';
      newFolderBtn.textContent = '+Folder';
      newFolderBtn.title = 'Create new folder';
      newFolderBtn.addEventListener('click', (e) => { e.stopPropagation(); this.createFolder(); });
      actions.appendChild(newFolderBtn);

      wsBar.appendChild(actions);

      const bindBtn = document.createElement('button');
      bindBtn.className = 'tab-files-header-btn';
      bindBtn.textContent = 'Bind…';
      bindBtn.style.color = 'var(--color-text-secondary)';
      bindBtn.addEventListener('click', () => this._onBindWorkspace());
      wsBar.appendChild(bindBtn);

      container.appendChild(wsBar);
    }

    // ── Split: tree | preview (side-by-side, tree handles its own scroll) ──
    const split = document.createElement('div');
    split.className = 'tab-files-split';

    const fileTree = document.createElement('div');
    fileTree.className = 'tab-files-tree';

    const previewArea = document.createElement('div');
    previewArea.className = 'tab-files-list';

    split.appendChild(fileTree);
    split.appendChild(previewArea);
    container.appendChild(split);
    this._showPreviewPlaceholder(previewArea);

    previewArea.addEventListener('click', (e: MouseEvent) => {
      handlePathClick(e, this._workspacePath);
    });

    return { el: container, tree: fileTree, preview: previewArea };
  }

  /** Public entry points for create-file / create-folder (used by overfly header). */
  createFile(): Promise<void> { return this._onCreateFile(); }
  createFolder(): Promise<void> { return this._onCreateFolder(); }

  private _showPreviewPlaceholder(previewArea?: HTMLElement): void {
    const pa = previewArea || this.previewEl;
    pa.style.display = 'flex';
    pa.innerHTML = `
      <div class="tab-files-preview-placeholder">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="28" height="28" opacity="0.3">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="tab-files-preview-hint">Select a file to preview</span>
      </div>
    `;
  }

  // ── Tree rendering ──

  renderTree(nodes: FileNode[]): void {
    this.treeEl.innerHTML = '';

    if (nodes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tab-files-list-empty';
      empty.textContent = 'No files in workspace';
      this.treeEl.appendChild(empty);
      return;
    }

    for (const node of nodes) {
      const item = this.renderFileNode(node, 0);
      this.treeEl.appendChild(item);
    }
  }

  /** Refresh the current directory. Used after mutations. */
  async refreshDirectory(dirPath: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      const resp = await fetch(
        `/api/v1/workspace/browse?sessionId=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(dirPath)}`
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.nodes) this.renderTree(data.nodes);
      }
    } catch {
      // Best-effort refresh
    }
  }

  private renderFileNode(node: FileNode, depth: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.draggable = true;
    row.dataset.path = node.path;
    row.dataset.isDir = String(node.isDirectory);

    // Drag-and-drop
    row.addEventListener('dragstart', (e) => this._onDragStart(e, node));
    row.addEventListener('dragover', (e) => this._onDragOver(e, node));
    row.addEventListener('dragleave', () => row.classList.remove('file-row-dragover'));
    row.addEventListener('drop', (e) => this._onDrop(e, node));

    // Expand arrow (for directories) — always visible, children lazy-loaded on click
    const arrowSpan = document.createElement('span');
    arrowSpan.className = 'tab-files-tree-arrow';
    arrowSpan.style.visibility = node.isDirectory ? 'visible' : 'hidden';
    arrowSpan.textContent = '▶';
    row.appendChild(arrowSpan);

    // Icon
    const iconWrap = document.createElement('span');
    iconWrap.className = 'tab-files-tree-icon';
    if (node.isDirectory) {
      iconWrap.innerHTML = SVG_FOLDER;
    } else {
      const ext = getFileExtension(node.name);
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
        iconWrap.innerHTML = SVG_IMAGE;
      } else if (['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json', 'yaml', 'yml', 'sh', 'bash', 'go', 'rs', 'java', 'c', 'cpp', 'h'].includes(ext)) {
        iconWrap.innerHTML = SVG_CODE;
      } else {
        iconWrap.innerHTML = SVG_FILE;
      }
    }
    row.appendChild(iconWrap);

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-files-tree-name';
    nameSpan.textContent = node.name;
    row.appendChild(nameSpan);

    // Size (for files)
    if (!node.isDirectory && node.size !== undefined) {
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'tab-files-tree-size';
      sizeSpan.textContent = formatFileSize(node.size);
      row.appendChild(sizeSpan);
    }

    // Children container
    const childContainer = document.createElement('div');
    childContainer.style.display = 'none';

    if (node.isDirectory && node.children && node.children.length > 0) {
      for (const child of node.children) {
        childContainer.appendChild(this.renderFileNode(child, depth + 1));
      }
    }

    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.selectedNode = node;

      if (node.isDirectory) {
        const isExpanded = childContainer.style.display !== 'none';
        if (isExpanded) {
          childContainer.style.display = 'none';
          arrowSpan.style.transform = 'rotate(0deg)';
        } else {
          if (childContainer.children.length === 0 && this.sessionId) {
            try {
              const resp = await fetch(
                `/api/v1/workspace/browse?sessionId=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(node.path)}`
              );
              if (resp.ok) {
                const data = await resp.json();
                if (data.nodes) {
                  childContainer.innerHTML = '';
                  for (const child of data.nodes) {
                    childContainer.appendChild(this.renderFileNode(child, depth + 1));
                  }
                }
              }
            } catch (err) {
              ToastManager.getInstance().error(`Failed to load directory: ${(err as Error).message}`);
            }
          }
          childContainer.style.display = 'block';
          arrowSpan.style.transform = 'rotate(90deg)';
        }
      } else {
        this.showFilePreview(node);
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.selectedNode = node;
      this.showContextMenu(e.clientX, e.clientY, node);
    });

    const wrapper = document.createElement('div');
    wrapper.appendChild(row);
    wrapper.appendChild(childContainer);
    return wrapper;
  }

  // ── File Preview ──

  private async showFilePreview(node: FileNode): Promise<void> {
    this.previewEl.style.display = 'block';
    this.previewEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'file-preview';

    const nameLabel = document.createElement('span');
    nameLabel.className = 'file-preview-name';
    nameLabel.textContent = node.name;
    header.appendChild(nameLabel);

    const sendBtn = document.createElement('button');
    sendBtn.className = 'file-preview-send-btn';
    sendBtn.textContent = 'Send to session';
    sendBtn.addEventListener('click', () => {
      if (this.onSendToSession) this.onSendToSession(node.path);
    });
    header.appendChild(sendBtn);
    this.previewEl.appendChild(header);

    const loading = document.createElement('div');
    loading.className = 'file-preview-loading';
    loading.textContent = 'Loading...';
    this.previewEl.appendChild(loading);

    const ext = getFileExtension(node.name);
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);

    if (isImage) {
      loading.remove();
      const img = document.createElement('img');
      img.className = 'file-preview-image';
      img.alt = node.name;
      img.src = `/api/v1/workspace/read?sessionId=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(node.path)}&raw=1`;
      img.onerror = () => {
        img.style.display = 'none';
        const errDiv = document.createElement('div');
        errDiv.className = 'file-preview-image-error';
        errDiv.textContent = 'Failed to load image';
        this.previewEl.appendChild(errDiv);
      };
      this.previewEl.appendChild(img);
      return;
    }

    try {
      const resp = await fetch(
        `/api/v1/workspace/read?sessionId=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(node.path)}`
      );
      if (!resp.ok) {
        loading.textContent = `Error: ${resp.status} ${resp.statusText}`;
        return;
      }
      const data = await resp.json();

      loading.remove();

      const isMarkdown = ext === 'md' || ext === 'markdown';
      const isCode = ['js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'json', 'yaml', 'yml', 'sh', 'bash', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'xml', 'sql', 'rb', 'php', 'swift', 'kt', 'scala', 'r'].includes(ext) || isMarkdown;

      if (isMarkdown) {
        const mdContainer = document.createElement('div');
        mdContainer.className = 'preview-markdown';
        mdContainer.innerHTML = renderMarkdown(data.content || '');
        this.previewEl.appendChild(mdContainer);

        mdContainer.querySelectorAll('pre code').forEach((el) => {
          const code = el.textContent || '';
          const lang = (el as HTMLElement).className.replace('language-', '') || detectLanguage(node.name);
          el.innerHTML = highlightCode(code, lang);
        });
      } else if (isCode) {
        const code = data.content || '';
        const highlighted = highlightCode(code, detectLanguage(node.name));
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        const codeEl = document.createElement('code');
        codeEl.innerHTML = highlighted;
        pre.appendChild(codeEl);
        this.previewEl.appendChild(pre);

        if (data.truncated) {
          const truncNote = document.createElement('div');
          truncNote.className = 'file-preview-truncation';
          truncNote.textContent = `File truncated (${(data.size / 1024).toFixed(1)} KB shown)`;
          this.previewEl.appendChild(truncNote);
        }
      } else {
        const pre = document.createElement('pre');
        pre.className = 'file-preview-plain';
        pre.textContent = data.content;

        if (data.truncated) {
          const truncNote = document.createElement('div');
          truncNote.className = 'file-preview-truncation';
          truncNote.textContent = `File truncated (${(data.size / 1024).toFixed(1)} KB shown)`;
          this.previewEl.appendChild(truncNote);
        }
        this.previewEl.appendChild(pre);
      }
    } catch (err) {
      loading.textContent = `Failed to load: ${(err as Error).message}`;
      ToastManager.getInstance().error(`Failed to load file preview: ${(err as Error).message}`);
    }
  }

  // ── Context Menu ──

  private showContextMenu(x: number, y: number, node: FileNode): void {
    const existing = document.querySelector('.file-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.className = 'file-context-menu';
    menu.style.cssText = `top: ${y}px; left: ${x}px;`;

    const items = [
      { label: 'Send to session', icon: 'attach', action: () => {
        if (this.onSendToSession) this.onSendToSession(node.path);
      }},
      { label: 'Copy path', icon: 'copy', action: () => {
        navigator.clipboard.writeText(node.path).catch(() => {});
      }},
      { label: 'Copy content', icon: 'copy', action: async () => {
        try {
          const resp = await fetch(`/api/v1/workspace/read?sessionId=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(node.path)}`);
          if (resp.ok) {
            const data = await resp.json();
            navigator.clipboard.writeText(data.content || '').catch(() => {});
          }
        } catch {}
      }},
      null, // separator
      { label: 'Cut', icon: 'cut', action: () => {
        this.clipboardPath = node.path;
        this.clipboardOp = 'cut';
        ClientLogger.ui.debug('File cut to clipboard', { path: node.path });
      }},
      { label: 'Copy', icon: 'copy', action: () => {
        this.clipboardPath = node.path;
        this.clipboardOp = 'copy';
        ClientLogger.ui.debug('File copied to clipboard', { path: node.path });
      }},
      { label: 'Paste', icon: 'paste', action: () => {
        this._onPaste(node.isDirectory ? node.path : this._parentPath(node.path));
      }},
      null, // separator
      { label: 'Rename', icon: 'edit', action: () => {
        this._startRename(node);
      }},
      { label: 'Delete', icon: 'delete', action: async () => {
        const confirmed = await ConfirmDialog.show(`Delete '${node.name}'?${node.isDirectory ? ' This will remove all contents.' : ''}`, 'Delete File');
        if (confirmed) this._onDelete(node);
      }},
    ];

    for (const item of items) {
      if (item === null) {
        const sep = document.createElement('div');
        sep.className = 'file-context-menu-separator';
        menu.appendChild(sep);
        continue;
      }

      // Disable paste if nothing on clipboard
      if (item.label === 'Paste' && !this.clipboardPath) continue;

      const menuItem = document.createElement('button');
      menuItem.className = 'file-context-menu-item';

      const itemIcon = document.createElement('img');
      itemIcon.src = `icons/${item.icon}.svg`;
      itemIcon.width = 14;
      itemIcon.height = 14;
      menuItem.appendChild(itemIcon);

      const label = document.createElement('span');
      label.textContent = item.label;
      menuItem.appendChild(label);

      menuItem.addEventListener('click', () => {
        item.action();
        menu.remove();
      });

      menu.appendChild(menuItem);
    }

    document.body.appendChild(menu);

    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // ── File Operations ──

  private async api(method: string, url: string, body?: Record<string, unknown>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
    try {
      const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const resp = await fetch(url, opts);
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) return { ok: true, data };
      return { ok: false, error: (data as Record<string, unknown>).message as string || `${resp.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private _parentPath(filePath: string): string {
    const i = filePath.lastIndexOf('/');
    return i > 0 ? filePath.slice(0, i) : '/';
  }

  private async _onCreateFile(): Promise<void> {
    const name = prompt('File name:');
    if (!name || !name.trim()) return;

    // Create in root or in the selected directory's parent
    const parentPath = this.selectedNode?.isDirectory ? this.selectedNode.path : (this.selectedNode ? this._parentPath(this.selectedNode.path) : '/');

    const r = await this.api('POST', '/api/v1/workspace/create-file', {
      sessionId: this.sessionId,
      path: parentPath,
      name: name.trim(),
    });

    if (r.ok) {
      ToastManager.getInstance().info(`Created '${name.trim()}'`);
      this.refreshDirectory(parentPath);
    } else {
      ToastManager.getInstance().error(`Failed to create file: ${r.error}`);
    }
  }

  private async _onCreateFolder(): Promise<void> {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;

    const parentPath = this.selectedNode?.isDirectory ? this.selectedNode.path : (this.selectedNode ? this._parentPath(this.selectedNode.path) : '/');

    const r = await this.api('POST', '/api/v1/workspace/create-dir', {
      path: parentPath,
      name: name.trim(),
      sessionId: this.sessionId,
    });

    if (r.ok) {
      ToastManager.getInstance().info(`Created folder '${name.trim()}'`);
      this.refreshDirectory(parentPath);
    } else {
      ToastManager.getInstance().error(`Failed to create folder: ${r.error}`);
    }
  }

  private async _onDelete(node: FileNode): Promise<void> {
    const r = await this.api('DELETE', `/api/v1/workspace/file?sessionId=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(node.path)}`);
    if (r.ok) {
      ToastManager.getInstance().info(`Deleted '${node.name}'`);
      const parentDir = this._parentPath(node.path);
      this.refreshDirectory(parentDir);
      if (this.selectedNode === node) this.selectedNode = null;
    } else {
      ToastManager.getInstance().error(`Failed to delete: ${r.error}`);
    }
  }

  // ── Inline Rename ──

  private _findRowByPath(filePath: string): HTMLElement | null {
    const rows = this.treeEl.querySelectorAll('[data-path]');
    for (const row of rows) {
      if ((row as HTMLElement).dataset.path === filePath) return row as HTMLElement;
    }
    return null;
  }

  private _startRename(node: FileNode): void {
    const row = this._findRowByPath(node.path);
    if (!row) return;

    const nameSpan = row.querySelector('.tab-files-tree-name') as HTMLElement;
    if (!nameSpan) return;

    const oldName = node.name;
    const ext = node.isDirectory ? '' : getFileExtension(oldName);
    const baseName = node.isDirectory ? oldName : oldName.slice(0, -(ext.length + (ext ? 1 : 0)));

    // Replace name span with input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-files-rename-input';
    input.value = baseName;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = async (newBaseName: string) => {
      const trimmed = newBaseName.trim();
      if (!trimmed || trimmed === baseName) {
        // Cancelled or unchanged — restore
        const restoredSpan = document.createElement('span');
        restoredSpan.className = 'tab-files-tree-name';
        restoredSpan.textContent = oldName;
        input.replaceWith(restoredSpan);
        return;
      }

      const newName = node.isDirectory ? trimmed : `${trimmed}.${ext}`;
      const r = await this.api('PATCH', '/api/v1/workspace/rename', {
        path: node.path,
        newName,
        sessionId: this.sessionId,
      });

      if (r.ok) {
        ToastManager.getInstance().info(`Renamed to '${newName}'`);
        const parentDir = this._parentPath(node.path);
        this.refreshDirectory(parentDir);
      } else {
        ToastManager.getInstance().error(`Rename failed: ${r.error}`);
        const restoredSpan = document.createElement('span');
        restoredSpan.className = 'tab-files-tree-name';
        restoredSpan.textContent = oldName;
        input.replaceWith(restoredSpan);
      }
    };

    input.addEventListener('blur', () => finish(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(baseName); }
    });
  }

  // ── Cut / Copy / Paste ──

  private async _onPaste(destDir: string): Promise<void> {
    if (!this.clipboardPath || !this.clipboardOp) return;

    const sourcePath = this.clipboardPath;

    if (this.clipboardOp === 'cut') {
      const r = await this.api('POST', '/api/v1/workspace/move', {
        source: sourcePath,
        destDir,
        sessionId: this.sessionId,
      });
      if (r.ok) {
        ToastManager.getInstance().info('Moved');
        this.clipboardPath = null;
        this.clipboardOp = null;
        this.refreshDirectory(destDir);
        const oldParent = this._parentPath(sourcePath);
        if (oldParent !== destDir) this.refreshDirectory(oldParent);
      } else {
        ToastManager.getInstance().error(`Move failed: ${r.error}`);
      }
    } else {
      // Copy — need to create a copy (not implemented yet — use placeholder)
      // For now, copy is just a path copy — future: implement server-side copy
      ToastManager.getInstance().info('Copy not yet implemented');
    }
  }

  // ── Drag & Drop ──

  private _dragNode: FileNode | null = null;

  private _onDragStart(e: DragEvent, node: FileNode): void {
    this._dragNode = node;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.path);
    }
  }

  private _onDragOver(e: DragEvent, node: FileNode): void {
    if (!this._dragNode || this._dragNode === node) return;
    // Only allow drop onto directories
    if (!node.isDirectory) return;

    // Prevent dropping a directory into itself
    if (this._dragNode.isDirectory && node.path.startsWith(this._dragNode.path + '/')) return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const row = (e.currentTarget as HTMLElement);
    row.classList.add('file-row-dragover');
  }

  private async _onDrop(e: DragEvent, targetDir: FileNode): Promise<void> {
    e.preventDefault();
    const row = (e.currentTarget as HTMLElement);
    row.classList.remove('file-row-dragover');

    if (!this._dragNode || !targetDir.isDirectory || this._dragNode === targetDir) return;
    // Prevent dropping a directory into itself
    if (this._dragNode.isDirectory && targetDir.path.startsWith(this._dragNode.path + '/')) return;

    const sourcePath = this._dragNode.path;
    const r = await this.api('POST', '/api/v1/workspace/move', {
      source: sourcePath,
      destDir: targetDir.path,
      sessionId: this.sessionId,
    });

    if (r.ok) {
      ToastManager.getInstance().info(`Moved '${this._dragNode.name}' to '${targetDir.path}'`);
      this.refreshDirectory(targetDir.path);
      const oldParent = this._parentPath(sourcePath);
      if (oldParent !== targetDir.path) this.refreshDirectory(oldParent);
    } else {
      ToastManager.getInstance().error(`Move failed: ${r.error}`);
    }

    this._dragNode = null;
  }

  // ── Keyboard Shortcuts ──

  private _onKeyDown(e: KeyboardEvent): void {
    if (!this.selectedNode) return;

    // F2 — Rename
    if (e.key === 'F2') {
      e.preventDefault();
      this._startRename(this.selectedNode);
      return;
    }

    // Delete
    if (e.key === 'Delete') {
      e.preventDefault();
      const node = this.selectedNode;
      ConfirmDialog.show(`Delete '${node.name}'?${node.isDirectory ? ' This will remove all contents.' : ''}`, 'Delete File').then(confirmed => {
        if (confirmed) this._onDelete(node);
      });
      return;
    }

    // Ctrl+X / Ctrl+C
    if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'c')) {
      e.preventDefault();
      this.clipboardPath = this.selectedNode.path;
      this.clipboardOp = e.key === 'x' ? 'cut' : 'copy';
      return;
    }

    // Ctrl+V
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault();
      const destDir = this.selectedNode.isDirectory ? this.selectedNode.path : this._parentPath(this.selectedNode.path);
      this._onPaste(destDir);
      return;
    }
  }

  // ── Workspace binding ──

  private async _onBindWorkspace(): Promise<void> {
    const { WorkspaceBindingDialog } = await import('../WorkspaceBindingDialog.js');
    const dialog = new WorkspaceBindingDialog();
    const result = await dialog.show();
    const dirPath = result?.path || null;
    if (!dirPath || !this.sessionId) return;

    try {
      const resp = await fetch(`/api/v1/sessions/${encodeURIComponent(this.sessionId)}/bind-workspace`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      });
      if (resp.ok) {
        this._workspacePath = dirPath;
        this.updateWorkspaceLabel(dirPath);
        const browseResp = await fetch(`/api/v1/workspace/browse?sessionId=${encodeURIComponent(this.sessionId)}&path=/`);
        if (browseResp.ok) {
          const data = await browseResp.json();
          if (data.nodes) this.renderTree(data.nodes);
        }
        ToastManager.getInstance().info(`Workspace bound to ${dirPath}`);
      }
    } catch (err) {
      ToastManager.getInstance().error('Failed to bind workspace');
    }
  }

  updateWorkspaceLabel(pathStr: string): void {
    this._workspacePath = pathStr;
    const label = this.element.querySelector('.tab-files-header-label');
    if (label) label.textContent = pathStr || 'No workspace bound';
  }
}
