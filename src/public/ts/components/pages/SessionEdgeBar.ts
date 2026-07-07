// AnoClaw Cinema — SessionEdgeBar: left 48px session navigation
// Renders session dots (size = activity), hover tree overlay, sub-session dots.
// Search button opens filterable session list.

import type { SessionNode } from '../../types.js';

const SVG_SEARCH = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3.5 3.5"/></svg>`;
const SVG_PLUS = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v12M2 8h12"/></svg>`;
const SVG_DELETE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 4h12M5 4V2h6v2M12 6l-.5 7.5a1 1 0 0 1-1 .5h-5a1 1 0 0 1-1-.5L4 6"/></svg>`;
const SVG_CLOSE = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;

interface EdgeBarCallbacks {
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
}

function flattenTree(nodes: SessionNode[]): SessionNode[] {
  const result: SessionNode[] = [];
  for (const n of nodes) {
    result.push(n);
    if (n.children && n.children.length > 0) {
      result.push(...flattenTree(n.children));
    }
  }
  return result;
}

export class SessionEdgeBar {
  readonly element: HTMLElement;
  private _treeOverlay: HTMLElement | null = null;
  private _dots: Map<string, HTMLElement> = new Map();
  private _callbacks: EdgeBarCallbacks;
  private _activeId: string | null = null;
  private _tree: SessionNode[] = [];
  private _searchActive = false;
  private _overlayOpen = false;

  constructor(callbacks: EdgeBarCallbacks) {
    this._callbacks = callbacks;
    this.element = this._build();
  }

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cinema-edge-left';

    const search = document.createElement('div');
    search.className = 'edge-search';
    search.innerHTML = SVG_SEARCH;
    search.title = 'Search sessions';
    search.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._searchActive) return;
      this._searchActive = true;
      search.classList.add('active');
      this._showSearchOverlay();
    });
    el.appendChild(search);

    const label = document.createElement('div');
    label.className = 'edge-label';
    label.textContent = 'ACTIVE';
    el.appendChild(label);

    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'edge-dots';
    dotsContainer.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;flex:1;padding-top:4px;';
    el.appendChild(dotsContainer);
    (el as any)._dotsContainer = dotsContainer;

    const newBtn = document.createElement('button');
    newBtn.className = 'edge-new-btn';
    newBtn.innerHTML = SVG_PLUS;
    newBtn.title = 'New session';
    newBtn.addEventListener('click', () => this._callbacks.onNewSession());
    el.appendChild(newBtn);

    return el;
  }

  renderTree(tree: SessionNode[], activeId: string | null): void {
    this._tree = tree;
    this._activeId = activeId;

    const container = (this.element as any)._dotsContainer as HTMLElement | undefined;
    if (!container) return;

    // Collect visible nodes (active session's children expanded)
    const visibleIds = new Set<string>();
    const visible: Array<{ node: SessionNode; depth: number }> = [];

    const collect = (nodes: SessionNode[], depth: number) => {
      for (const n of nodes) {
        visibleIds.add(n.id);
        visible.push({ node: n, depth });
        if (n.children && n.children.length > 0 && n.id === activeId) {
          collect(n.children, depth + 1);
        }
      }
    };
    collect(tree, 0);

    // Remove dots for sessions no longer visible
    for (const [id, dot] of this._dots) {
      if (!visibleIds.has(id)) {
        dot.remove();
        this._dots.delete(id);
      }
    }

    // Update existing dots and create new ones
    for (const { node, depth } of visible) {
      let dot = this._dots.get(node.id);
      if (dot) {
        this._updateDot(dot, node, depth, activeId);
      } else {
        dot = this._createDot(node, depth, activeId);
        container.appendChild(dot);
        this._dots.set(node.id, dot);
      }
    }

    // Reorder children to match tree-walk order (handles inserted sessions)
    let orderIdx = 0;
    for (const { node } of visible) {
      const dot = this._dots.get(node.id)!;
      if (container.children[orderIdx] !== dot) {
        container.insertBefore(dot, container.children[orderIdx] || null);
      }
      orderIdx++;
    }

    // Refresh overlay content if open — don't close it
    if (this._overlayOpen && this._treeOverlay) {
      this._refreshOverlayContent();
    }
  }

  setActive(id: string): void {
    // Fast visual path: update dot active states before structural renderTree
    for (const [sid, dot] of this._dots) {
      if (sid === id) {
        dot.classList.add('active');
        dot.style.background = 'var(--color-primary, #ffffff)';
        dot.style.boxShadow = 'none';
      } else {
        dot.classList.remove('active');
        dot.style.background = '';
        dot.style.boxShadow = '';
      }
    }
    this.renderTree(this._tree, id);
  }

  private _createDot(node: SessionNode, depth: number, activeId: string | null): HTMLElement {
    const dot = document.createElement('div');
    dot.className = 'session-dot';
    if (node.id === activeId) dot.classList.add('active');
    if (depth > 0) dot.classList.add('child');

    const size = Math.max(4, 10 - depth * 2);
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    dot.style.background = node.id === activeId
      ? 'var(--color-primary, #ffffff)'
      : `rgba(255,255,255,${0.12 - depth * 0.03})`;
    dot.title = node.title;

    dot.addEventListener('click', () => this._callbacks.onSelectSession(node.id));
    dot.addEventListener('mouseenter', () => this._showTreeOverlay());

    return dot;
  }

  private _updateDot(dot: HTMLElement, node: SessionNode, depth: number, activeId: string | null): void {
    const isActive = node.id === activeId;
    dot.classList.toggle('active', isActive);
    dot.classList.toggle('child', depth > 0);

    const size = Math.max(4, 10 - depth * 2);
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    dot.style.background = isActive
      ? 'var(--color-primary, #ffffff)'
      : `rgba(255,255,255,${0.12 - depth * 0.03})`;
    dot.style.boxShadow = 'none';
    dot.title = node.title;
  }

  // ── Search overlay ──

  private _searchTimer: ReturnType<typeof setTimeout> | null = null;

  private _showSearchOverlay(): void {
    this._hideTreeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'cinema-tree-overlay';
    this._treeOverlay = overlay;

    // Search input row
    const searchRow = document.createElement('div');
    searchRow.style.cssText = 'display:flex;gap:6px;padding:0 0 6px;border-bottom:1px solid var(--hairline-cinema);margin-bottom:4px;';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search sessions & messages…';
    input.style.cssText = 'flex:1;background:transparent;border:none;color:white;font-size:12px;outline:none;padding:4px 0;';
    searchRow.appendChild(input);

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = SVG_CLOSE;
    closeBtn.style.cssText = 'background:none;border:none;color:var(--cinema-text-welcome);cursor:pointer;padding:2px;flex-shrink:0;';
    closeBtn.addEventListener('click', () => {
      this._hideSearchOverlay();
    });
    searchRow.appendChild(closeBtn);
    overlay.appendChild(searchRow);

    // Position overlay relative to the edge bar (same logic as hover overlay)
    const barRect = this.element.getBoundingClientRect();
    const topbarEl = document.getElementById('titlebar');
    const top = topbarEl ? topbarEl.getBoundingClientRect().bottom : 0;
    overlay.style.left = `${barRect.right + 4}px`;
    overlay.style.top = `${Math.max(top, 4)}px`;

    // Results area
    const results = document.createElement('div');
    results.style.cssText = 'max-height:calc(100vh - 180px);overflow-y:auto;';
    overlay.appendChild(results);

    const flat = flattenTree(this._tree);

    // Wrap flat data with matchType info
    interface FlatItem { id: string; title: string; matchType: 'title'; }
    const flatItems: FlatItem[] = flat.map(n => ({ id: n.id, title: n.title, matchType: 'title' as const }));

    const renderResults = (
      titleMatches: FlatItem[],
      contentMatches: Array<{ sessionId: string; title: string; matchType: 'content'; excerpt?: string }>,
      query: string,
    ) => {
      results.innerHTML = '';
      const shownIds = new Set<string>();

      // Title matches first
      for (const m of titleMatches) {
        if (shownIds.has(m.id)) continue;
        shownIds.add(m.id);
        const row = this._buildResultRow(m.id, m.title, undefined);
        results.appendChild(row);
      }

      // Content matches (with excerpt)
      for (const m of contentMatches) {
        if (shownIds.has(m.sessionId)) continue;
        shownIds.add(m.sessionId);
        const row = this._buildResultRow(m.sessionId, m.title, m.excerpt);
        results.appendChild(row);
      }

      if (shownIds.size === 0) {
        results.innerHTML = '<div style="color:var(--cinema-text-muted);font-size:11px;padding:16px;text-align:center;">No matching sessions</div>';
      }
    };

    // Local filter: instant title matches
    const doLocalFilter = (query: string) => {
      const q = query.toLowerCase();
      const titleMatches = q
        ? flatItems.filter(n => (n.title || '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
        : flatItems;
      renderResults(titleMatches, [], query);
    };

    // Debounced API fetch for content matches
    input.addEventListener('input', () => {
      const q = input.value.trim();
      doLocalFilter(q);

      if (this._searchTimer) clearTimeout(this._searchTimer);
      if (!q) return;

      this._searchTimer = setTimeout(async () => {
        try {
          const resp = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=15`);
          if (!resp.ok) return;
          const data = await resp.json();
          const contentMatches: Array<{ sessionId: string; title: string; matchType: 'content'; excerpt?: string }> =
            (data.results || []).filter((r: any) => r.matchType === 'content');

          const q2 = input.value.trim().toLowerCase();
          const titleMatches = q2
            ? flatItems.filter(n => (n.title || '').toLowerCase().includes(q2) || n.id.toLowerCase().includes(q2))
            : flatItems;
          renderResults(titleMatches, contentMatches, q2);
        } catch { /* ignore */ }
      }, 300);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this._hideSearchOverlay(); }
    });

    doLocalFilter('');

    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);

    const onClickOutside = (e: MouseEvent) => {
      if (!overlay.contains(e.target as Node) && !this.element.contains(e.target as Node)) {
        this._hideSearchOverlay();
        document.removeEventListener('click', onClickOutside);
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
  }

  private _buildResultRow(id: string, title: string, excerpt?: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cinema-tree-row';
    if (id === this._activeId) row.classList.add('active');

    const dot = document.createElement('div');
    dot.className = 'cinema-tree-dot';
    dot.style.background = id === this._activeId
      ? 'var(--color-primary, #ffffff)'
      : 'var(--cinema-text-welcome-desc)';
    row.appendChild(dot);

    const textCol = document.createElement('div');
    textCol.style.cssText = 'flex:1;min-width:0;';
    const name = document.createElement('div');
    name.textContent = title || id;
    name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;';
    textCol.appendChild(name);

    if (excerpt) {
      const snippet = document.createElement('div');
      snippet.textContent = excerpt;
      snippet.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--cinema-text-edge);margin-top:1px;';
      textCol.appendChild(snippet);
    }
    row.appendChild(textCol);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'cinema-tree-del-btn';
    delBtn.innerHTML = SVG_DELETE;
    delBtn.title = 'Archive session';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._hideSearchOverlay();
      this._callbacks.onDeleteSession(id);
    });
    row.appendChild(delBtn);

    row.addEventListener('click', () => {
      this._callbacks.onSelectSession(id);
      this._hideSearchOverlay();
    });

    return row;
  }

  private _hideSearchOverlay(): void {
    // Reset search button state
    const searchBtn = this.element.querySelector('.edge-search') as HTMLElement;
    if (searchBtn) searchBtn.classList.remove('active');
    this._searchActive = false;
    this._hideTreeOverlay();
  }

  // ── Hover tree overlay (no search, quick preview) ──

  private _showTreeOverlay(): void {
    if (this._searchActive) return; // don't steal focus from search
    this._hideTreeOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'cinema-tree-overlay';

    // Position overlay relative to the right edge of the left bar,
    // below the topbar — not hardcoded, works in two-panel layout.
    const barRect = this.element.getBoundingClientRect();
    const topbarEl = document.getElementById('titlebar');
    const top = topbarEl ? topbarEl.getBoundingClientRect().bottom : 0;
    overlay.style.left = `${barRect.right + 4}px`;
    overlay.style.top = `${Math.max(top, 4)}px`;

    this._renderOverlayRows(overlay, this._tree, 0);
    document.body.appendChild(overlay);
    this._treeOverlay = overlay;
    this._overlayOpen = true;

    // Close on click outside (NOT on mouseleave — mouseleave fires spuriously
    // when DOM changes during streaming output).
    const onClickOutside = (e: MouseEvent) => {
      if (!overlay.contains(e.target as Node) && !this.element.contains(e.target as Node)) {
        this._hideTreeOverlay();
        document.removeEventListener('click', onClickOutside);
      }
    };
    // Small delay so the current click doesn't immediately close it
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
  }

  private _hideTreeOverlay(): void {
    this._overlayOpen = false;
    if (this._treeOverlay) {
      this._treeOverlay.remove();
      this._treeOverlay = null;
    }
  }

  // ── Shared overlay row rendering ──

  private _renderOverlayRows(container: HTMLElement, nodes: SessionNode[], depth: number): void {
    for (const n of nodes) {
      const row = document.createElement('div');
      row.className = 'cinema-tree-row';
      if (n.id === this._activeId) row.classList.add('active');
      row.style.paddingLeft = `${8 + depth * 12}px`;

      const dot = document.createElement('div');
      dot.className = 'cinema-tree-dot';
      dot.style.background = n.id === this._activeId
        ? 'var(--color-primary, #ffffff)'
        : 'var(--cinema-text-welcome-desc)';
      row.appendChild(dot);

      const name = document.createElement('span');
      name.textContent = n.title || n.id;
      name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      row.appendChild(name);

      const delBtn = document.createElement('button');
      delBtn.className = 'cinema-tree-del-btn';
      delBtn.innerHTML = SVG_DELETE;
      delBtn.title = 'Archive session';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._hideTreeOverlay();
        this._callbacks.onDeleteSession(n.id);
      });
      row.appendChild(delBtn);

      row.addEventListener('click', () => {
        this._callbacks.onSelectSession(n.id);
        this._hideTreeOverlay();
      });
      container.appendChild(row);

      if (n.children && n.children.length > 0) {
        this._renderOverlayRows(container, n.children, depth + 1);
      }
    }
  }

  private _refreshOverlayContent(): void {
    const overlay = this._treeOverlay!;
    while (overlay.firstChild) {
      overlay.removeChild(overlay.firstChild);
    }
    this._renderOverlayRows(overlay, this._tree, 0);
  }
}
