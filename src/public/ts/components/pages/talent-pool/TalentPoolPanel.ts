// TalentPoolPanel — right-side drawer for the agent template library (talent pool)
// Contains: domain-grouped tree, template list, context menus, hire/save dialogs.
// Uses shared UI components: Button, Badge, ContextMenu, Dialog.

import { EventEmitter } from '../../../EventEmitter.js';
import { ClientLogger } from '../../../ClientLogger.js';
import { ToastManager } from '../../../ToastManager.js';
import { Badge } from '../../ui/Badge.js';
import type { TalentPoolGroup, TalentPoolTemplate } from '../../../types.js';

// Domain color mapping for colored dots
const DOMAIN_COLORS: Record<string, string> = {
  se: 'var(--color-token-system-prompt)',
  ds: 'var(--color-success)',
  mkt: 'var(--color-warning)',
  biz: 'var(--color-info)',
  fin: 'var(--color-success)',
  legal: 'var(--color-token-system-tools)',
  edu: 'var(--color-token-system-prompt)',
  creative: 'var(--color-warning)',
  hr: 'var(--color-info)',
  cs: 'var(--color-success)',
};

export class TalentPoolPanel extends EventEmitter {
  private _container: HTMLElement;
  private _panel: HTMLElement | null = null;
  private _overlay: HTMLElement | null = null;
  private _visible = false;

  private _groups: TalentPoolGroup[] = [];
  private _templates: TalentPoolTemplate[] = [];

  private _expandedGroups = new Set<string>();
  private _selectedTemplate: TalentPoolTemplate | null = null;
  private _filterText = '';

  constructor(container: HTMLElement) {
    super();
    this._container = container;
  }

  get visible(): boolean { return this._visible; }

  async toggle(): Promise<void> {
    if (this._visible) { this.close(); return; }
    await this.open();
  }

  async open(): Promise<void> {
    if (this._visible) return;
    await this._loadData();
    this._render();
    this._visible = true;
    requestAnimationFrame(() => {
      if (this._panel) this._panel.classList.add('tp-open');
    });
  }

  close(): void {
    if (!this._visible) return;
    if (this._panel) this._panel.classList.remove('tp-open');
    setTimeout(() => {
      if (this._overlay) { this._overlay.remove(); this._overlay = null; }
      if (this._panel) { this._panel.remove(); this._panel = null; }
      this._visible = false;
    }, 250);
  }

  destroy(): void {
    this.close();
  }

  private async _loadData(): Promise<void> {
    try {
      const [gRes, tRes] = await Promise.all([
        fetch('/api/v1/talent-pool/groups'),
        fetch('/api/v1/talent-pool/templates'),
      ]);
      if (gRes.ok) {
        const data = await gRes.json();
        this._groups = data.groups || [];
      }
      if (tRes.ok) {
        const data = await tRes.json();
        this._templates = data.templates || [];
      }
    } catch (err) {
      ClientLogger.ui.error('TalentPool load failed', { error: String(err) });
    }
  }

  private _render(): void {
    this._overlay = document.createElement('div');
    this._overlay.className = 'tp-overlay';
    this._overlay.addEventListener('click', () => this.close());

    this._panel = document.createElement('div');
    this._panel.className = 'tp-panel';
    this._panel.innerHTML = this._buildPanelHTML();
    this._wireEvents();

    this._container.appendChild(this._overlay);
    this._container.appendChild(this._panel);
  }

  private _buildPanelHTML(): string {
    const countInfo = `${this._templates.length} templates, ${this._groups.length} domains`;
    return `
      <div class="tp-header">
        <div class="tp-header-top">
          <span class="tp-title">Talent Pool</span>
          <button class="tp-close-btn">&times;</button>
        </div>
        <div class="tp-search">
          <input type="text" class="tp-search-input" placeholder="Search templates..." value="${this._esc(this._filterText)}">
        </div>
        <button class="tp-add-group-btn">+ New Domain</button>
      </div>
      <div class="tp-body">${this._buildTreeHTML()}</div>
      <div class="tp-footer"><span>${countInfo}</span></div>
    `;
  }

  private _buildTreeHTML(): string {
    if (this._groups.length === 0) {
      return '<div class="tp-empty">No domains yet. Click "New Domain" to add one.</div>';
    }

    let html = '<div class="tp-tree">';
    for (const group of this._groups) {
      const expanded = this._expandedGroups.has(group.id) ? ' tp-expanded' : '';
      const domainColor = DOMAIN_COLORS[group.id] || 'var(--color-text-quaternary)';
      const members = this._templates.filter(t => t.groupId === group.id);

      html += `<div class="tp-group${expanded}" data-domain="${this._esc(group.id)}">`;
      html += `<div class="tp-group-header" data-group-id="${this._esc(group.id)}">
        <span class="tp-group-toggle">${expanded ? '▾' : '▸'}</span>
        <span class="tp-group-dot" style="background:${domainColor}"></span>
        <span class="tp-group-name">${this._esc(group.name)}</span>
        <span class="tp-group-count">${members.length}</span>
      </div>`;
      html += `<div class="tp-group-children">`;

      const filtered = this._filterText
        ? members.filter(m => this._matchesFilter(m))
        : members;
      for (const tpl of filtered) {
        const roleDotClass = tpl.role === 'Manager' ? 'manager' : 'member';
        html += `<div class="tp-template" data-template-id="${this._esc(tpl.id)}">
          <span class="tp-tpl-role-dot ${roleDotClass}"></span>
          <span class="tp-tpl-name">${this._esc(tpl.name)}</span>
          <span class="tp-tpl-stars">${'★'.repeat(tpl.starRating)}</span>
          <span class="tp-tpl-role-badge ${roleDotClass}">${tpl.role}</span>
        </div>`;
      }
      if (filtered.length === 0 && this._filterText) {
        html += '<div class="tp-empty-small">No match</div>';
      }
      html += `</div></div>`;
    }
    html += '</div>';
    return html;
  }

  private _matchesFilter(tpl: TalentPoolTemplate): boolean {
    if (!this._filterText) return true;
    const q = this._filterText.toLowerCase();
    return tpl.name.toLowerCase().includes(q)
      || tpl.description.toLowerCase().includes(q)
      || tpl.tags.some(t => t.toLowerCase().includes(q));
  }

  private _wireEvents(): void {
    if (!this._panel) return;

    this._panel.querySelector('.tp-close-btn')?.addEventListener('click', () => this.close());

    this._panel.querySelector('.tp-search-input')?.addEventListener('input', (e) => {
      this._filterText = (e.target as HTMLInputElement).value;
      this._rerenderTree();
    });

    this._panel.querySelector('.tp-add-group-btn')?.addEventListener('click', () => this._promptAddGroup());

    this._panel.querySelectorAll('.tp-group-header').forEach(el => {
      el.addEventListener('click', () => {
        const gid = (el as HTMLElement).dataset.groupId;
        if (!gid) return;
        if (this._expandedGroups.has(gid)) this._expandedGroups.delete(gid);
        else this._expandedGroups.add(gid);
        this._rerenderTree();
      });
      el.addEventListener('contextmenu' as any, (e: MouseEvent) => {
        e.preventDefault();
        const gid = (el as HTMLElement).dataset.groupId;
        if (gid) this._showGroupContextMenu(e.clientX, e.clientY, gid);
      });
    });

    this._panel.querySelectorAll('.tp-template').forEach(el => {
      el.addEventListener('click', () => {
        const tid = (el as HTMLElement).dataset.templateId;
        if (!tid) return;
        if (this._selectedTemplate?.id === tid) {
          this._selectedTemplate = null;
          el.classList.remove('tp-selected');
        } else {
          this._panel!.querySelectorAll('.tp-template').forEach(c => c.classList.remove('tp-selected'));
          this._selectedTemplate = this._templates.find(t => t.id === tid) || null;
          el.classList.add('tp-selected');
        }
      });
      el.addEventListener('contextmenu' as any, (e: MouseEvent) => {
        e.preventDefault();
        const tid = (el as HTMLElement).dataset.templateId;
        if (!tid) return;
        const tpl = this._templates.find(t => t.id === tid);
        if (tpl) this._showTemplateContextMenu(e.clientX, e.clientY, tpl);
      });
    });
  }

  private _rerenderTree(): void {
    if (!this._panel) return;
    const body = this._panel.querySelector('.tp-body');
    if (body) body.innerHTML = this._buildTreeHTML();
    this._wireEvents();
  }

  // ═══ Context menus ═══════════════════════════════════════

  private _ctxMenu: HTMLElement | null = null;

  private _showGroupContextMenu(x: number, y: number, groupId: string): void {
    this._closeCtxMenu();
    const group = this._groups.find(g => g.id === groupId);
    const menu = document.createElement('div');
    menu.className = 'ui-context-menu';
    menu.style.cssText = `left:${x}px;top:${y}px;position:fixed;z-index:1002;`;

    const renameItem = document.createElement('div');
    renameItem.className = 'ui-context-menu-item';
    renameItem.textContent = 'Rename Domain';
    renameItem.addEventListener('click', () => {
      this._closeCtxMenu();
      this._promptRenameGroup(groupId, group?.name || '');
    });

    const deleteItem = document.createElement('div');
    deleteItem.className = 'ui-context-menu-item';
    deleteItem.textContent = 'Delete Domain';
    deleteItem.addEventListener('click', async () => {
      this._closeCtxMenu();
      this._deleteGroup(groupId, group?.name || '');
    });

    menu.appendChild(renameItem);
    menu.appendChild(deleteItem);
    document.body.appendChild(menu);
    this._ctxMenu = menu;
    setTimeout(() => document.addEventListener('click', () => this._closeCtxMenu(), { once: true }), 0);
  }

  private _showTemplateContextMenu(x: number, y: number, tpl: TalentPoolTemplate): void {
    this._closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ui-context-menu';
    menu.style.cssText = `left:${x}px;top:${y}px;position:fixed;z-index:1002;`;

    const header = document.createElement('div');
    header.className = 'ui-context-menu-item';
    header.style.cssText = 'opacity:0.5;font-size:11px;text-transform:uppercase;cursor:default;pointer-events:none;';
    header.textContent = tpl.name;
    menu.appendChild(header);

    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--color-bubble-sent);margin:4px 8px;';
    menu.appendChild(sep);

    const items = [
      { label: 'Hire Template', action: () => this.emit('hire', tpl) },
      { label: 'Preview Prompt', action: () => this._showPreview(tpl) },
    ];
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'ui-context-menu-item';
      row.textContent = item.label;
      row.addEventListener('click', () => { this._closeCtxMenu(); item.action(); });
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    this._ctxMenu = menu;
    setTimeout(() => document.addEventListener('click', () => this._closeCtxMenu(), { once: true }), 0);
  }

  private _closeCtxMenu(): void {
    if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
  }

  // ═══ Dialogs ══════════════════════════════════════════════

  private _promptAddGroup(): void {
    const name = prompt('Enter domain name:');
    if (!name || !name.trim()) return;
    fetch('/api/v1/talent-pool/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const g = await res.json();
      this._expandedGroups.add(g.id);
      await this._loadData();
      this._rerenderTree();
      ToastManager.getInstance().success(`Domain "${g.name}" created`);
    }).catch(() => ToastManager.getInstance().error('Failed to create domain'));
  }

  private _promptRenameGroup(groupId: string, currentName: string): void {
    const name = prompt('Enter new name:', currentName);
    if (!name || !name.trim() || name.trim() === currentName) return;
    fetch(`/api/v1/talent-pool/groups/${groupId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await this._loadData();
      this._rerenderTree();
      ToastManager.getInstance().success('Domain renamed');
    }).catch(() => ToastManager.getInstance().error('Rename failed'));
  }

  private async _deleteGroup(groupId: string, name: string): Promise<void> {
    if (!confirm(`Delete domain "${name}"? Templates in this domain will lose their group assignment.`)) return;
    try {
      await fetch(`/api/v1/talent-pool/groups/${groupId}`, { method: 'DELETE' });
      this._expandedGroups.delete(groupId);
      await this._loadData();
      this._rerenderTree();
      ToastManager.getInstance().success('Domain deleted');
    } catch { ToastManager.getInstance().error('Delete failed'); }
  }

  private _showPreview(tpl: TalentPoolTemplate): void {
    const overlay = document.createElement('div');
    overlay.className = 'tp-preview-overlay';
    overlay.innerHTML = `
      <div class="tp-preview-modal">
        <div class="tp-preview-header">
          <span>${this._esc(tpl.name)}</span>
          <button class="tp-preview-close">&times;</button>
        </div>
        <div class="tp-preview-body">
          <div class="tp-preview-section">
            <label>Role</label>
            <span><span class="tp-tpl-role-dot ${tpl.role === 'Manager' ? 'manager' : 'member'}" style="display:inline-block;vertical-align:middle;margin-right:4px;"></span> ${tpl.role}</span>
          </div>
          <div class="tp-preview-section">
            <label>Description</label>
            <span>${this._esc(tpl.description)}</span>
          </div>
          <div class="tp-preview-section">
            <label>Model</label>
            <span>${this._esc(tpl.model)}</span>
          </div>
          <div class="tp-preview-section">
            <label>Tags</label>
            <span>${tpl.tags.map(t => `<span class="tp-preview-tag">${this._esc(t)}</span>`).join(' ')}</span>
          </div>
          <div class="tp-preview-section">
            <label>System Prompt</label>
            <pre class="tp-preview-prompt">${this._esc(tpl.agentPrompt)}</pre>
          </div>
          <div class="tp-preview-section">
            <label>Allowed Tools (${tpl.allowedTools.length})</label>
            <span class="tp-preview-tools">${tpl.allowedTools.length > 0 ? tpl.allowedTools.map(t => `<span class="tp-preview-tag">${this._esc(t)}</span>`).join(' ') : 'All'}</span>
          </div>
        </div>
        <div class="tp-preview-footer">
          <button class="tp-preview-hire-btn">Hire Template</button>
          <button class="tp-preview-close-btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.tp-preview-close')?.addEventListener('click', close);
    overlay.querySelector('.tp-preview-close-btn')?.addEventListener('click', close);
    overlay.querySelector('.tp-preview-hire-btn')?.addEventListener('click', () => { close(); this.emit('hire', tpl); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }
}
