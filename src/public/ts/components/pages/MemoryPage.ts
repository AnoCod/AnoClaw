/**
 * AnoClaw Cinema — Memory Page
 * Card grid with type tabs, search, create/edit modal, and delete.
 */

import type { Page, MemoryEntry } from '../../types.js';
import { App } from '../../app.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { ClientLogger } from '../../ClientLogger.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { FormField } from '../ui/FormField.js';
import { getLocale, onLocaleChange, t } from '../../i18n/index.js';

const TYPES = ['all', 'user', 'feedback', 'project', 'reference'] as const;
const TYPE_COLOR: Record<string, number> = {
  user: 0, feedback: 1, project: 2, reference: 3,
};
const SCOPE_DOT: Record<string, string> = {
  team: '#4fc3f7', agent: '#ffb74d', personal: '#ffb74d', session: '#ce93d8',
};

export class MemoryPage implements Page {
  name = 'memory';
  container: HTMLElement;
  private _memories: MemoryEntry[] = [];
  private _activeType = 'all';
  private _gridEl: HTMLElement;
  private _tabsEl: HTMLElement;
  private _searchInput: HTMLInputElement;
  private _headerTitle: HTMLElement;
  private _createButton: Button;
  private _modalOverlay: HTMLElement | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'cinema-static-page';
    this.container.setAttribute('data-page', 'memory');
    this.container.style.display = 'none';
    this.container.innerHTML = `<div class="cinema-static-inner" id="memory-inner"></div>`;

    const inner = this.container.querySelector('#memory-inner')!;

    // Header
    const header = document.createElement('div');
    header.className = 'mem-header';
    const headerTitle = document.createElement('span');
    headerTitle.className = 'mem-header-title';
    headerTitle.textContent = t('memory.title');
    this._headerTitle = headerTitle;
    header.appendChild(headerTitle);
    const headerRight = document.createElement('div');
    headerRight.style.cssText = 'display:flex;gap:8px;align-items:center;';
    this._searchInput = document.createElement('input');
    this._searchInput.className = 'cinema-filter-input';
    this._searchInput.type = 'text';
    this._searchInput.placeholder = t('common.search');
    this._searchInput.addEventListener('input', () => this._renderGrid());
    headerRight.appendChild(this._searchInput);
    this._createButton = new Button({ label: t('memory.create'), variant: 'primary', size: 'sm', onClick: () => this._showModal(null) });
    headerRight.appendChild(this._createButton.element);
    header.appendChild(headerRight);
    inner.appendChild(header);

    // Type tabs
    this._tabsEl = document.createElement('div');
    this._tabsEl.className = 'mem-type-tabs';
    inner.appendChild(this._tabsEl);
    this._buildTabs();

    // Card grid
    this._gridEl = document.createElement('div');
    this._gridEl.className = 'cinema-card-grid';
    inner.appendChild(this._gridEl);

    // Auto-refresh on external memory changes (CEO deletes/creates via tool)
    const sse = App.getInstance().sseClient;
    sse.on('memory_changed', () => this._load());
    onLocaleChange(() => this._refreshLocale());
  }

  onEnter(): void { this._load(); }
  onExit(): void { this._closeModal(); }

  // ── Data ──

  private async _load(): Promise<void> {
    try {
      const resp = await fetch('/api/v1/memory');
      this._memories = resp.ok ? await resp.json() : [];
    } catch { this._memories = []; }
    this._renderGrid();
  }

  // ── Tabs ──

  private _buildTabs(): void {
    this._tabsEl.innerHTML = '';
    for (const t of TYPES) {
      const tab = document.createElement('button');
      tab.className = 'mem-type-tab';
      tab.textContent = this._typeLabel(t);
      tab.dataset.type = t;
      if (t === this._activeType) tab.classList.add('active');
      tab.addEventListener('click', () => {
        this._activeType = t;
        this._tabsEl.querySelectorAll('.mem-type-tab').forEach(el => el.classList.remove('active'));
        tab.classList.add('active');
        this._renderGrid();
      });
      this._tabsEl.appendChild(tab);
    }
  }

  // ── Grid ──

  private _renderGrid(): void {
    this._gridEl.innerHTML = '';
    const q = this._searchInput.value.toLowerCase();
    let filtered = this._memories;
    if (this._activeType !== 'all') filtered = filtered.filter(m => m.type === this._activeType);
    if (q) filtered = filtered.filter(m => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q));

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'ui-empty';
      empty.style.gridColumn = '1 / -1';
      const title = document.createElement('div');
      title.className = 'ui-empty-title';
      title.textContent = t('memory.empty');
      empty.appendChild(title);
      this._gridEl.appendChild(empty);
      return;
    }
    for (const mem of filtered) this._gridEl.appendChild(this._buildCard(mem));
  }

  private _buildCard(mem: MemoryEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cinema-card mem-card mem-row-card';
    card.dataset.memoryType = mem.type || 'reference';
    card.addEventListener('click', () => this._showModal(mem));

    // Top: icon + title + type badge
    const top = document.createElement('div');
    top.className = 'mem-card-top';

    const ci = TYPE_COLOR[mem.type] ?? 3;
    const icon = document.createElement('div');
    icon.className = 'mem-card-icon';
    icon.style.background = `linear-gradient(135deg, color-mix(in srgb, var(--color-avatar-${ci}) 25%, transparent), color-mix(in srgb, var(--color-avatar-${ci}) 8%, transparent))`;
    icon.textContent = mem.title.charAt(0).toUpperCase();

    const nameGroup = document.createElement('div');
    nameGroup.className = 'mem-card-name-group';

    const title = document.createElement('span');
    title.className = 'mem-card-title';
    title.textContent = mem.title;

    const badge = document.createElement('span');
    badge.className = `mem-type-badge mem-type-${mem.type || 'reference'}`;
    badge.textContent = this._typeLabel(mem.type);

    nameGroup.appendChild(title);
    nameGroup.appendChild(badge);
    top.appendChild(icon);
    top.appendChild(nameGroup);
    card.appendChild(top);

    // Scope + time
    const meta = document.createElement('div');
    meta.className = 'mem-card-meta';

    const scope = document.createElement('span');
    scope.className = 'mem-scope';
    const sd = SCOPE_DOT[mem.scope] || '#888';
    scope.innerHTML = `<span class="mem-scope-dot" style="background:${sd};"></span>${this._esc(this._scopeLabel(mem.scope))}`;
    meta.appendChild(scope);

    const time = document.createElement('span');
    time.className = 'mem-card-time';
    time.textContent = this._relativeTime(mem.updatedAt);
    meta.appendChild(time);

    card.appendChild(meta);

    // Content snippet
    if (mem.content) {
      const snippet = document.createElement('p');
      snippet.className = 'mem-card-snippet';
      snippet.textContent = mem.content;
      card.appendChild(snippet);
    }

    return card;
  }

  // ── Modal ──

  private _showModal(mem: MemoryEntry | null): void {
    const isNew = !mem;
    if (isNew) { this._showFormModal(null); }
    else { this._showDetailModal(mem!); }
  }

  private _showFormModal(mem: MemoryEntry | null): void {
    this._closeModal();
    const isNew = !mem;

    const body = document.createElement('div');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = t('memory.titlePlaceholder');
    titleInput.value = mem?.title || '';
    body.appendChild(new FormField({ label: t('memory.field.title'), input: titleInput }).element);

    const typeSelect = document.createElement('select');
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = this._typeLabel(t);
      if (mem?.type === t) opt.selected = true;
      typeSelect.appendChild(opt);
    }
    body.appendChild(new FormField({ label: t('memory.field.type'), input: typeSelect }).element);

    const scopeSelect = document.createElement('select');
    for (const s of ['team', 'agent', 'session']) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = this._scopeLabel(s);
      if (mem?.scope === s) opt.selected = true;
      scopeSelect.appendChild(opt);
    }
    body.appendChild(new FormField({ label: t('memory.field.scope'), input: scopeSelect }).element);

    const contentTa = document.createElement('textarea');
    contentTa.rows = 8;
    contentTa.value = mem?.content || '';
    contentTa.style.cssText = 'font-family:var(--font-mono);resize:vertical;';
    body.appendChild(new FormField({ label: t('memory.field.content'), input: contentTa }).element);

    const footer = document.createElement('div');
    const cancelBtn = new Button({ label: t('common.cancel'), onClick: () => dlg.close() });
    const saveBtn = new Button({ label: t('common.save'), variant: 'primary', onClick: () => this._handleSave(mem, titleInput, typeSelect, scopeSelect, contentTa, dlg) });
    footer.appendChild(cancelBtn.element);
    footer.appendChild(saveBtn.element);

    const dlg = new Dialog({
      title: isNew ? t('memory.createTitle') : t('memory.editTitle'),
      body,
      footer,
      onClose: () => this._closeModal(),
    });
    this._modalOverlay = dlg as any;
    dlg.show();
    setTimeout(() => titleInput.focus(), 100);
  }

  private _showDetailModal(mem: MemoryEntry): void {
    this._closeModal();

    const bodyFrag = document.createDocumentFragment();

    const typeBadge = document.createElement('span');
    typeBadge.className = `mem-type-badge mem-type-${mem.type || 'reference'}`;
    typeBadge.textContent = this._typeLabel(mem.type);
    bodyFrag.appendChild(typeBadge);

    const meta = document.createElement('div');
    meta.style.cssText = 'display:flex;gap:12px;font-size:10px;color:var(--cinema-text-edge);margin:8px 0 16px;';
    const sd = SCOPE_DOT[mem.scope] || '#888';
    meta.innerHTML = `
      <span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${sd};margin-right:4px;"></span>${this._esc(this._scopeLabel(mem.scope))}</span>
      <span>${this._esc(mem.agentId)}</span>
      <span>${new Date(mem.updatedAt).toLocaleString(getLocale())}</span>
    `;
    bodyFrag.appendChild(meta);

    const content = document.createElement('pre');
    content.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--cinema-text-overlay);white-space:pre-wrap;line-height:1.6;margin:0;';
    content.textContent = mem.content;
    bodyFrag.appendChild(content);

    const bodyEl = document.createElement('div');
    bodyEl.appendChild(bodyFrag);

    const footer = document.createElement('div');
    const editBtn = new Button({ label: t('common.edit'), onClick: () => { dlg.close(); this._showFormModal(mem); } });
    const delBtn = new Button({ label: t('common.delete'), variant: 'danger', onClick: async () => {
      if (await ConfirmDialog.show(t('memory.deleteConfirm', { title: mem.title }), t('memory.deleteTitle'))) {
        await this._deleteMemory(mem.id);
        dlg.close();
      }
    }});
    footer.appendChild(editBtn.element);
    footer.appendChild(delBtn.element);

    const dlg = new Dialog({
      title: this._esc(mem.title),
      body: bodyEl,
      footer,
      onClose: () => this._closeModal(),
    });
    this._modalOverlay = dlg as any;
    dlg.show();
  }

  private async _handleSave(mem: MemoryEntry | null, titleInput: HTMLInputElement, typeSelect: HTMLSelectElement, scopeSelect: HTMLSelectElement, contentTa: HTMLTextAreaElement, dlg: Dialog): Promise<void> {
    const title = titleInput.value.trim();
    if (!title) return;

    try {
      if (mem) {
        await fetch(`/api/v1/memory/${mem.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, type: typeSelect.value, scope: scopeSelect.value, content: contentTa.value }),
        });
      } else {
        await fetch('/api/v1/memory', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''), description: title, type: typeSelect.value, scope: scopeSelect.value, content: contentTa.value }),
        });
      }
      this._load();
      dlg.close();
    } catch (err) { ClientLogger.ui.error('Memory save failed', { error: (err as Error).message }); }
  }

  private async _deleteMemory(id: string): Promise<void> {
    try { await fetch(`/api/v1/memory/${id}`, { method: 'DELETE' }); } catch {}
    this._load();
  }

  private _closeModal(): void {
    if (this._modalOverlay) {
      this._modalOverlay = null;
    }
  }

  // ── Helpers ──

  private _relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t('memory.time.now');
    if (mins < 60) return t('memory.time.minutes', { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('memory.time.hours', { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 7) return t('memory.time.days', { count: days });
    if (days < 30) return t('memory.time.weeks', { count: Math.floor(days / 7) });
    return new Date(ts).toLocaleDateString(getLocale());
  }

  private _refreshLocale(): void {
    this._headerTitle.textContent = t('memory.title');
    this._searchInput.placeholder = t('common.search');
    this._createButton.label = t('memory.create');
    this._buildTabs();
    this._renderGrid();
  }

  private _typeLabel(type: string): string {
    const key = `memory.type.${type}` as
      | 'memory.type.all'
      | 'memory.type.user'
      | 'memory.type.feedback'
      | 'memory.type.project'
      | 'memory.type.reference';
    return TYPES.includes(type as typeof TYPES[number]) ? t(key) : type;
  }

  private _scopeLabel(scope: string): string {
    const labels = {
      team: t('memory.scope.team'),
      agent: t('memory.scope.agent'),
      personal: t('memory.scope.personal'),
      session: t('memory.scope.session'),
    };
    return labels[scope as keyof typeof labels] || scope;
  }

  private _esc(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
