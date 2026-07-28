// AnoClaw Cinema — persistent, collapsible session navigation tree.

import type { SessionNode, SessionStatus } from '../../types.js';
import { onLocaleChange, t } from '../../i18n/index.js';

const SVG_SEARCH = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3.5 3.5"/></svg>`;
const SVG_PLUS = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>`;
const SVG_DELETE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h12M5 4V2h6v2M12 6l-.5 7.5a1 1 0 0 1-1 .5h-5a1 1 0 0 1-1-.5L4 6"/></svg>`;
const SVG_CLOSE = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const SVG_CHEVRON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>`;
const SVG_COLLAPSE = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>`;
const SVG_EXPAND = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>`;
const SVG_GROUP = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"><path d="M3 4.5h10M3 8h10M3 11.5h10"/><circle cx="1.5" cy="4.5" r=".5" fill="currentColor" stroke="none"/><circle cx="1.5" cy="8" r=".5" fill="currentColor" stroke="none"/><circle cx="1.5" cy="11.5" r=".5" fill="currentColor" stroke="none"/></svg>`;

const COLLAPSED_STORAGE_KEY = 'anoclaw.sessions.sidebar.collapsed';
const EXPANDED_STORAGE_KEY = 'anoclaw.sessions.sidebar.expanded';
const COORDINATION_PREFIX = /^coordination\s*:/i;
const WORKING_STATUSES = new Set<SessionStatus>(['working', 'started', 'tool_executing']);

interface EdgeBarCallbacks {
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
}

interface SearchResult {
  sessionId: string;
  title: string;
  excerpt?: string;
}

export interface SessionTreeSummary {
  descendants: number;
  working: number;
  errors: number;
}

function flattenTree(nodes: SessionNode[]): SessionNode[] {
  const result: SessionNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children?.length) result.push(...flattenTree(node.children));
  }
  return result;
}

export function activeSessionPath(tree: SessionNode[], activeId: string | null): string[] {
  if (!activeId) return [];
  const visit = (nodes: SessionNode[], path: string[]): string[] | null => {
    for (const node of nodes) {
      const nextPath = [...path, node.id];
      if (node.id === activeId) return nextPath;
      const childPath = visit(node.children || [], nextPath);
      if (childPath) return childPath;
    }
    return null;
  };
  return visit(tree, []) || [];
}

export function visibleSessionNodes(
  tree: SessionNode[],
  activeId: string | null,
  expandedIds: ReadonlySet<string> = new Set(activeSessionPath(tree, activeId)),
): Array<{ node: SessionNode; depth: number }> {
  const visible: Array<{ node: SessionNode; depth: number }> = [];
  const collect = (nodes: SessionNode[], depth: number): void => {
    for (const node of nodes) {
      visible.push({ node, depth });
      if (node.children?.length && expandedIds.has(node.id)) collect(node.children, depth + 1);
    }
  };
  collect(tree, 0);
  return visible;
}

export function isCoordinationSession(node: SessionNode): boolean {
  return COORDINATION_PREFIX.test(node.title || '');
}

export function splitSessionChildren(children: SessionNode[]): {
  sessions: SessionNode[];
  coordination: SessionNode[];
} {
  const sessions: SessionNode[] = [];
  const coordination: SessionNode[] = [];
  for (const child of children) {
    (isCoordinationSession(child) ? coordination : sessions).push(child);
  }
  return { sessions, coordination };
}

export function summarizeSessionTree(node: SessionNode): SessionTreeSummary {
  const summary: SessionTreeSummary = { descendants: 0, working: 0, errors: 0 };
  const visit = (children: SessionNode[]): void => {
    for (const child of children) {
      summary.descendants++;
      if (WORKING_STATUSES.has(child.status)) summary.working++;
      if (child.status === 'error') summary.errors++;
      visit(child.children || []);
    }
  };
  visit(node.children || []);
  return summary;
}

function readBooleanPreference(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function readExpandedPreference(): Set<string> {
  try {
    const value = globalThis.localStorage?.getItem(EXPANDED_STORAGE_KEY);
    const parsed = value ? JSON.parse(value) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function writePreference(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'working':
    case 'started':
    case 'tool_executing':
      return t('session.status.working');
    case 'paused':
      return t('session.status.paused');
    case 'error':
      return t('session.status.error');
    case 'Idle':
      return t('session.status.idle');
    case 'Archived':
      return t('session.status.archived');
    default:
      return t('session.status.active');
  }
}

function displayTitle(node: SessionNode): string {
  const title = (node.title || node.id).trim();
  if (isCoordinationSession(node)) return title.replace(COORDINATION_PREFIX, '').trim() || t('session.coordinationUpdate');
  return title;
}

export class SessionEdgeBar {
  readonly element: HTMLElement;

  private _callbacks: EdgeBarCallbacks;
  private _tree: SessionNode[] = [];
  private _activeId: string | null = null;
  private _activePathIds = new Set<string>();
  private _expandedIds = readExpandedPreference();
  private _collapsed = readBooleanPreference(COLLAPSED_STORAGE_KEY);
  private _treeContainer!: HTMLElement;
  private _searchPanel!: HTMLElement;
  private _searchInput!: HTMLInputElement;
  private _searchButton!: HTMLButtonElement;
  private _collapseButton!: HTMLButtonElement;
  private _collapseLabel!: HTMLElement;
  private _searchQuery = '';
  private _contentResults: SearchResult[] = [];
  private _searchTimer: ReturnType<typeof setTimeout> | null = null;
  private _searchAbortController: AbortController | null = null;
  private _searchRequestSeq = 0;

  constructor(callbacks: EdgeBarCallbacks) {
    this._callbacks = callbacks;
    this.element = this._build();
    this._applyCollapsedState(false);
    onLocaleChange(() => this._refreshLocale());
  }

  private _build(): HTMLElement {
    const sidebar = document.createElement('aside');
    sidebar.className = 'cinema-edge-left';
    sidebar.setAttribute('aria-label', t('session.navigation'));

    const header = document.createElement('div');
    header.className = 'edge-sidebar-header';

    const title = document.createElement('div');
    title.className = 'edge-sidebar-title';
    title.textContent = t('session.sessions');
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'edge-sidebar-actions';

    this._searchButton = this._iconButton(SVG_SEARCH, t('session.search'), 'edge-sidebar-action edge-search');
    this._searchButton.setAttribute('aria-expanded', 'false');
    this._searchButton.addEventListener('click', () => {
      if (this._collapsed) this._setCollapsed(false);
      this._setSearchOpen(this._searchPanel.hidden);
    });
    actions.appendChild(this._searchButton);

    const newButton = this._iconButton(SVG_PLUS, t('session.new'), 'edge-sidebar-action edge-new-btn');
    newButton.addEventListener('click', () => this._callbacks.onNewSession());
    actions.appendChild(newButton);

    header.appendChild(actions);
    sidebar.appendChild(header);

    this._searchPanel = document.createElement('div');
    this._searchPanel.className = 'edge-session-search';
    this._searchPanel.hidden = true;

    this._searchInput = document.createElement('input');
    this._searchInput.type = 'search';
    this._searchInput.placeholder = t('session.searchPlaceholder');
    this._searchInput.setAttribute('aria-label', t('session.searchPlaceholder'));
    this._searchInput.addEventListener('input', () => this._onSearchInput());
    this._searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this._setSearchOpen(false);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this._treeContainer.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
      }
    });
    this._searchPanel.appendChild(this._searchInput);

    const closeSearch = this._iconButton(SVG_CLOSE, t('session.closeSearch'), 'edge-search-close');
    closeSearch.addEventListener('click', () => this._setSearchOpen(false));
    this._searchPanel.appendChild(closeSearch);
    sidebar.appendChild(this._searchPanel);

    this._treeContainer = document.createElement('div');
    this._treeContainer.className = 'edge-session-tree';
    this._treeContainer.setAttribute('role', 'tree');
    this._treeContainer.setAttribute('aria-label', t('session.sessions'));
    sidebar.appendChild(this._treeContainer);

    const footer = document.createElement('div');
    footer.className = 'edge-sidebar-footer';
    this._collapseButton = this._iconButton(SVG_COLLAPSE, t('session.collapseNavigation'), 'edge-sidebar-collapse');
    this._collapseButton.setAttribute('aria-expanded', 'true');
    this._collapseLabel = document.createElement('span');
    this._collapseLabel.textContent = t('session.collapse');
    this._collapseButton.appendChild(this._collapseLabel);
    this._collapseButton.addEventListener('click', () => this._setCollapsed(!this._collapsed));
    footer.appendChild(this._collapseButton);
    sidebar.appendChild(footer);

    return sidebar;
  }

  private _iconButton(svg: string, title: string, className: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.innerHTML = svg;
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
  }

  private _refreshLocale(): void {
    this.element.setAttribute('aria-label', t('session.navigation'));
    const title = this.element.querySelector<HTMLElement>('.edge-sidebar-title');
    if (title) title.textContent = t('session.sessions');
    this._searchButton.title = t('session.search');
    this._searchButton.setAttribute('aria-label', t('session.search'));
    const newButton = this.element.querySelector<HTMLButtonElement>('.edge-new-btn');
    if (newButton) {
      newButton.title = t('session.new');
      newButton.setAttribute('aria-label', t('session.new'));
    }
    this._searchInput.placeholder = t('session.searchPlaceholder');
    this._searchInput.setAttribute('aria-label', t('session.searchPlaceholder'));
    const closeSearch = this.element.querySelector<HTMLButtonElement>('.edge-search-close');
    if (closeSearch) {
      closeSearch.title = t('session.closeSearch');
      closeSearch.setAttribute('aria-label', t('session.closeSearch'));
    }
    this._treeContainer.setAttribute('aria-label', t('session.sessions'));
    this._applyCollapsedState(false);
    this._renderContent();
  }

  renderTree(tree: SessionNode[], activeId: string | null): void {
    const activeChanged = activeId !== this._activeId;
    this._tree = tree;
    this._activeId = activeId;
    this._activePathIds = new Set(activeSessionPath(tree, activeId));

    const existingIds = new Set(flattenTree(tree).map(node => node.id));
    for (const id of [...this._expandedIds]) {
      if (!existingIds.has(id) && !id.startsWith('coordination:')) this._expandedIds.delete(id);
    }

    if (activeChanged && activeId) {
      for (const id of this._activePathIds) this._expandedIds.add(id);
      const activeNode = flattenTree(tree).find(node => node.id === activeId);
      const activeParentId = activeNode?.parentId || activeNode?.parentSessionId || null;
      if (activeNode && isCoordinationSession(activeNode) && activeParentId) {
        this._expandedIds.add(this._coordinationGroupId(activeParentId));
      }
      this._saveExpandedState();
    }

    this._renderContent();
  }

  setActive(id: string): void {
    this.renderTree(this._tree, id);
  }

  private _renderContent(): void {
    this._treeContainer.replaceChildren();

    if (this._searchQuery) {
      this._renderSearchResults();
      return;
    }

    if (!this._tree.length) {
      if (!this._collapsed) {
        const empty = document.createElement('div');
        empty.className = 'edge-session-empty';
        empty.textContent = t('session.none');
        this._treeContainer.appendChild(empty);
      }
      return;
    }

    if (this._collapsed) {
      this._renderCollapsedRoots();
      return;
    }

    this._tree.forEach((node, index) => {
      this._treeContainer.appendChild(this._renderNode(node, 0, index === 0 && !this._activeId));
    });
  }

  private _renderCollapsedRoots(): void {
    for (const root of this._tree) {
      const summary = summarizeSessionTree(root);
      const activeBranch = this._activePathIds.has(root.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-rail-item';
      button.classList.toggle('active', activeBranch);
      button.title = `${displayTitle(root)} · ${this._summaryText(root, summary)}`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-current', activeBranch ? 'page' : 'false');

      const status = document.createElement('span');
      status.className = `session-tree-status status-${this._statusClass(root.status, summary)}`;
      button.appendChild(status);

      if (summary.descendants > 0) {
        const count = document.createElement('span');
        count.className = 'session-rail-count';
        count.textContent = summary.descendants > 99 ? '99+' : String(summary.descendants);
        button.appendChild(count);
      }

      button.addEventListener('click', () => this._callbacks.onSelectSession(root.id));
      this._treeContainer.appendChild(button);
    }
  }

  private _renderNode(node: SessionNode, depth: number, focusable = false): HTMLElement {
    const { sessions, coordination } = splitSessionChildren(node.children || []);
    const hasChildren = sessions.length > 0 || coordination.length > 0;
    const expanded = hasChildren && this._expandedIds.has(node.id);
    const summary = summarizeSessionTree(node);

    const wrapper = document.createElement('div');
    wrapper.className = 'session-tree-node';
    wrapper.dataset.sessionId = node.id;

    const row = document.createElement('div');
    row.className = 'session-tree-row';
    row.classList.toggle('active', node.id === this._activeId);
    row.classList.toggle('active-path', node.id !== this._activeId && this._activePathIds.has(node.id));
    row.dataset.sessionId = node.id;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(node.id === this._activeId));
    if (hasChildren) row.setAttribute('aria-expanded', String(expanded));
    row.tabIndex = node.id === this._activeId || focusable ? 0 : -1;
    row.style.setProperty('--session-depth', String(depth));
    row.title = node.title || node.id;

    const toggle = this._iconButton(SVG_CHEVRON, expanded ? t('session.collapseBranch') : t('session.expandBranch'), 'session-tree-toggle');
    toggle.classList.toggle('expanded', expanded);
    toggle.disabled = !hasChildren;
    toggle.tabIndex = -1;
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this._toggleNode(node.id);
    });
    row.appendChild(toggle);

    const status = document.createElement('span');
    status.className = `session-tree-status status-${this._statusClass(node.status, summary)}`;
    status.title = statusLabel(node.status);
    row.appendChild(status);

    const copy = document.createElement('span');
    copy.className = 'session-tree-copy';

    const title = document.createElement('span');
    title.className = 'session-tree-title';
    title.textContent = displayTitle(node);
    copy.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'session-tree-meta';
    meta.textContent = depth === 0
      ? this._summaryText(node, summary)
      : [node.agentName, statusLabel(node.status)].filter(Boolean).join(' · ');
    copy.appendChild(meta);
    row.appendChild(copy);

    if (depth === 0 && summary.descendants > 0) {
      const count = document.createElement('span');
      count.className = 'session-tree-count';
      count.textContent = String(summary.descendants);
      count.title = t('session.childCount', { count: summary.descendants });
      row.appendChild(count);
    }

    const archive = this._iconButton(SVG_DELETE, t('session.archive'), 'session-tree-archive');
    archive.tabIndex = -1;
    row.setAttribute('aria-keyshortcuts', 'Delete');
    archive.addEventListener('click', (event) => {
      event.stopPropagation();
      this._callbacks.onDeleteSession(node.id);
    });
    row.appendChild(archive);

    row.addEventListener('click', () => this._callbacks.onSelectSession(node.id));
    row.addEventListener('keydown', (event) => this._handleNodeKeydown(event, node, hasChildren, expanded));
    wrapper.appendChild(row);

    if (expanded) {
      const children = document.createElement('div');
      children.className = 'session-tree-children';
      children.setAttribute('role', 'group');
      for (const child of sessions) children.appendChild(this._renderNode(child, depth + 1));
      if (coordination.length) children.appendChild(this._renderCoordinationGroup(node, coordination, depth + 1));
      wrapper.appendChild(children);
    }

    return wrapper;
  }

  private _renderCoordinationGroup(parent: SessionNode, nodes: SessionNode[], depth: number): HTMLElement {
    const groupId = this._coordinationGroupId(parent.id);
    const expanded = this._expandedIds.has(groupId);
    const containsActive = nodes.some(node => this._activePathIds.has(node.id));
    const wrapper = document.createElement('div');
    wrapper.className = 'session-tree-node session-tree-coordination';

    const row = document.createElement('div');
    row.className = 'session-tree-row session-tree-group-row';
    row.classList.toggle('active-path', containsActive);
    row.dataset.groupId = groupId;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-expanded', String(expanded));
    row.tabIndex = -1;
    row.style.setProperty('--session-depth', String(depth));

    const toggle = this._iconButton(SVG_CHEVRON, expanded ? t('session.collapseCoordination') : t('session.expandCoordination'), 'session-tree-toggle');
    toggle.classList.toggle('expanded', expanded);
    toggle.tabIndex = -1;
    row.appendChild(toggle);

    const icon = document.createElement('span');
    icon.className = 'session-tree-group-icon';
    icon.innerHTML = SVG_GROUP;
    row.appendChild(icon);

    const copy = document.createElement('span');
    copy.className = 'session-tree-copy';
    const title = document.createElement('span');
    title.className = 'session-tree-title';
    title.textContent = t('session.coordinationHistory');
    copy.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'session-tree-meta';
    meta.textContent = t('session.systemActivity');
    copy.appendChild(meta);
    row.appendChild(copy);

    const count = document.createElement('span');
    count.className = 'session-tree-count';
    count.textContent = String(nodes.length);
    row.appendChild(count);

    const toggleGroup = (): void => {
      if (expanded) this._expandedIds.delete(groupId);
      else this._expandedIds.add(groupId);
      this._saveExpandedState();
      this._renderContent();
      this._focusGroup(groupId);
    };
    row.addEventListener('click', toggleGroup);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        if ((event.key === 'ArrowRight' && expanded) || (event.key === 'ArrowLeft' && !expanded)) return;
        toggleGroup();
      } else {
        this._moveTreeFocus(event, row);
      }
    });
    wrapper.appendChild(row);

    if (expanded) {
      const children = document.createElement('div');
      children.className = 'session-tree-children';
      children.setAttribute('role', 'group');
      for (const node of nodes) children.appendChild(this._renderNode(node, depth + 1));
      wrapper.appendChild(children);
    }
    return wrapper;
  }

  private _summaryText(node: SessionNode, summary: SessionTreeSummary): string {
    const parts: string[] = [];
    if (node.agentName) parts.push(node.agentName);
    if (summary.working > 0) parts.push(t('session.summaryWorking', { count: summary.working }));
    if (summary.errors > 0) parts.push(t('session.summaryErrors', { count: summary.errors }));
    if (summary.working === 0 && summary.errors === 0) {
      if (summary.descendants > 0) parts.push(t('session.summarySessions', { count: summary.descendants }));
      else parts.push(statusLabel(node.status));
    }
    return parts.join(' · ');
  }

  private _statusClass(status: SessionStatus, summary?: SessionTreeSummary): string {
    if (status === 'error' || (summary?.errors || 0) > 0) return 'error';
    if (WORKING_STATUSES.has(status) || (summary?.working || 0) > 0) return 'working';
    if (status === 'paused') return 'paused';
    if (status === 'Idle' || status === 'Archived') return 'idle';
    return 'active';
  }

  private _toggleNode(id: string): void {
    if (this._expandedIds.has(id)) this._expandedIds.delete(id);
    else this._expandedIds.add(id);
    this._saveExpandedState();
    this._renderContent();
    this._focusSession(id);
  }

  private _handleNodeKeydown(
    event: KeyboardEvent,
    node: SessionNode,
    hasChildren: boolean,
    expanded: boolean,
  ): void {
    const row = event.currentTarget as HTMLElement;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this._callbacks.onSelectSession(node.id);
      return;
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      this._callbacks.onDeleteSession(node.id);
      return;
    }
    if (event.key === 'ArrowRight' && hasChildren) {
      event.preventDefault();
      if (!expanded) this._toggleNode(node.id);
      else this._focusNextTreeItem(row);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (expanded) {
        this._toggleNode(node.id);
      } else {
        const parentId = node.parentId || node.parentSessionId || null;
        if (parentId) this._focusSession(parentId);
      }
      return;
    }
    this._moveTreeFocus(event, row);
  }

  private _moveTreeFocus(event: KeyboardEvent, current: HTMLElement): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...this._treeContainer.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    if (!items.length) return;
    const currentIndex = Math.max(0, items.indexOf(current));
    let nextIndex = currentIndex;
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === 'ArrowDown') nextIndex = Math.min(items.length - 1, currentIndex + 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    items[nextIndex]?.focus();
  }

  private _focusNextTreeItem(current: HTMLElement): void {
    const items = [...this._treeContainer.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const index = items.indexOf(current);
    items[index + 1]?.focus();
  }

  private _focusSession(id: string): void {
    requestAnimationFrame(() => {
      const row = [...this._treeContainer.querySelectorAll<HTMLElement>('[data-session-id]')]
        .find(item => item.classList.contains('session-tree-row') && item.dataset.sessionId === id);
      row?.focus();
    });
  }

  private _focusGroup(id: string): void {
    requestAnimationFrame(() => {
      const row = [...this._treeContainer.querySelectorAll<HTMLElement>('[data-group-id]')]
        .find(item => item.dataset.groupId === id);
      row?.focus();
    });
  }

  private _setCollapsed(collapsed: boolean): void {
    if (collapsed === this._collapsed) return;
    this._collapsed = collapsed;
    writePreference(COLLAPSED_STORAGE_KEY, String(collapsed));
    this._applyCollapsedState(true);
  }

  private _applyCollapsedState(render: boolean): void {
    this.element.classList.toggle('is-collapsed', this._collapsed);
    this.element.setAttribute('data-collapsed', String(this._collapsed));
    this._collapseButton.innerHTML = this._collapsed ? SVG_EXPAND : SVG_COLLAPSE;
    this._collapseLabel = document.createElement('span');
    this._collapseLabel.textContent = this._collapsed ? t('session.expand') : t('session.collapse');
    this._collapseButton.appendChild(this._collapseLabel);
    this._collapseButton.title = this._collapsed ? t('session.expandNavigation') : t('session.collapseNavigation');
    this._collapseButton.setAttribute('aria-label', this._collapseButton.title);
    this._collapseButton.setAttribute('aria-expanded', String(!this._collapsed));
    if (this._collapsed) this._setSearchOpen(false, false);
    if (render) this._renderContent();
  }

  private _setSearchOpen(open: boolean, focus = true): void {
    this._searchPanel.hidden = !open;
    this._searchButton.classList.toggle('active', open);
    this._searchButton.setAttribute('aria-expanded', String(open));
    if (!open) {
      this._searchInput.value = '';
      this._searchQuery = '';
      this._contentResults = [];
      this._cancelSearchRequest();
      this._renderContent();
      return;
    }
    if (focus) requestAnimationFrame(() => this._searchInput.focus());
  }

  private _onSearchInput(): void {
    const query = this._searchInput.value.trim();
    this._searchQuery = query;
    this._contentResults = [];
    this._cancelSearchRequest();
    this._renderContent();
    if (!query) return;

    const requestSeq = ++this._searchRequestSeq;
    this._searchTimer = setTimeout(async () => {
      this._searchTimer = null;
      const controller = new AbortController();
      this._searchAbortController = controller;
      try {
        const response = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}&limit=20`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        if (controller.signal.aborted || requestSeq !== this._searchRequestSeq || query !== this._searchQuery) return;
        this._contentResults = (data.results || [])
          .filter((item: any) => item?.sessionId)
          .map((item: any) => ({
            sessionId: String(item.sessionId),
            title: String(item.title || item.sessionId),
            excerpt: item.excerpt ? String(item.excerpt) : undefined,
          }));
        this._renderContent();
      } catch {
        // Local title results remain available when content search is unavailable.
      } finally {
        if (this._searchAbortController === controller) this._searchAbortController = null;
      }
    }, 300);
  }

  private _cancelSearchRequest(): void {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    if (this._searchAbortController) {
      this._searchAbortController.abort();
      this._searchAbortController = null;
    }
    this._searchRequestSeq++;
  }

  private _renderSearchResults(): void {
    const query = this._searchQuery.toLocaleLowerCase();
    const flat = flattenTree(this._tree);
    const nodeMap = new Map(flat.map(node => [node.id, node]));
    const localMatches = flat.filter(node => {
      const haystack = `${node.title} ${node.agentName || ''} ${node.id}`.toLocaleLowerCase();
      return haystack.includes(query);
    });
    const results: SearchResult[] = localMatches.map(node => ({
      sessionId: node.id,
      title: displayTitle(node),
    }));
    const seen = new Set(results.map(result => result.sessionId));
    for (const result of this._contentResults) {
      if (!seen.has(result.sessionId)) {
        seen.add(result.sessionId);
        results.push(result);
      }
    }

    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'edge-session-empty';
      empty.textContent = t('session.noMatches');
      this._treeContainer.appendChild(empty);
      return;
    }

    for (const [index, result] of results.slice(0, 50).entries()) {
      const node = nodeMap.get(result.sessionId);
      const row = document.createElement('div');
      row.className = 'session-search-result';
      row.classList.toggle('active', result.sessionId === this._activeId);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(result.sessionId === this._activeId));
      row.tabIndex = result.sessionId === this._activeId || (index === 0 && !this._activeId) ? 0 : -1;

      const status = document.createElement('span');
      status.className = `session-tree-status status-${node ? this._statusClass(node.status) : 'idle'}`;
      row.appendChild(status);

      const copy = document.createElement('span');
      copy.className = 'session-tree-copy';
      const title = document.createElement('span');
      title.className = 'session-tree-title';
      title.textContent = result.title;
      copy.appendChild(title);
      const meta = document.createElement('span');
      meta.className = 'session-tree-meta';
      meta.textContent = result.excerpt || [node?.agentName, node ? statusLabel(node.status) : t('session.messageMatch')].filter(Boolean).join(' · ');
      copy.appendChild(meta);
      row.appendChild(copy);

      row.addEventListener('click', () => this._callbacks.onSelectSession(result.sessionId));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this._callbacks.onSelectSession(result.sessionId);
        } else {
          this._moveTreeFocus(event, row);
        }
      });
      this._treeContainer.appendChild(row);
    }
  }

  private _coordinationGroupId(parentId: string): string {
    return `coordination:${parentId}`;
  }

  private _saveExpandedState(): void {
    writePreference(EXPANDED_STORAGE_KEY, JSON.stringify([...this._expandedIds]));
  }
}
