// main.ts - Workflow plugin v3.0 entry point
// Full visual workflow editor: canvas with drag/pan/zoom, 14 node types, connections, palette, list,
// undo/redo, execution logs viewer, keyboard shortcuts, node grouping, import/export, search, snap-to-grid

import {
  type WorkflowNode, type WorkflowConnection, type WorkflowGroup,
  type WorkflowMeta, type WorkflowCanvasData,
  NODE_DEFS, PALETTE_GROUPS, STORAGE_KEY, MAX_ZOOM, MIN_ZOOM, GRID_SIZE,
  nextNodeId, nextGroupId, resetIdSeqs,
} from './WorkflowNodeTypes.js';

import { renderNode, renderConnections, renderMinimap } from './WorkflowRendering.js';
import { WorkflowCanvasController, type CanvasCallbacks } from './WorkflowCanvas.js';
import { buildList } from './WorkflowList.js';
import {
  loadStore, loadCanvasData, saveCanvasData,
  fetchWorkflows, createWorkflow as apiCreateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  startWorkflow as apiStartWorkflow,
  stopWorkflow as apiStopWorkflow,
} from './WorkflowPersistence.js';

class WorkflowPage {
  name = 'workflow';
  container: HTMLElement;

  private _workflows: WorkflowMeta[] = [];
  private _activeWfId: string | null = null;
  private _nodes: WorkflowNode[] = [];
  private _connections: WorkflowConnection[] = [];
  private _groups: WorkflowGroup[] = [];
  private _sessionMode: 'persistent' | 'ephemeral' = 'persistent';
  private _selectedNodeId: string | null = null;
  private _selectedConnId: string | null = null;
  private _selectedNodeIds: Set<string> = new Set(); // Multi-select

  // Clipboard for copy/paste
  private _clipboard: { nodes: WorkflowNode[]; connections: WorkflowConnection[] } | null = null;

  // Execution logs
  private _logsPanelEl: HTMLElement | null = null;
  private _logsVisible = false;
  private _logsPollTimer = 0;

  // Search
  private _searchOverlay: HTMLElement | null = null;
  private _searchVisible = false;

  // Execution state for flow animation
  private _executionState: any = null;

  // DOM
  private _toolbar!: HTMLElement;
  private _nodeCountEl!: HTMLElement;
  private _zoomLabelEl!: HTMLElement;
  private _wfNameEl!: HTMLElement;
  private _canvasContainer!: HTMLElement;
  private _canvas!: HTMLElement;
  private _svgLayer!: SVGSVGElement;
  private _nodesLayer!: HTMLElement;
  private _palette!: HTMLElement;
  private _placeholder!: HTMLElement;
  private _listEl: HTMLDivElement | null = null;
  private _contextMenu: HTMLElement | null = null;
  private _minimapCanvas!: HTMLCanvasElement;

  private _ctrl!: WorkflowCanvasController;

  private _initialZoomDone = false;
  private _minimapTimer = 0;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'wf-root';
    this._buildDOM();
    this._initCanvas();
    this._initKeyboardShortcuts();
    this._loadAndRender();
  }

  onEnter(): void {
    if (!this._initialZoomDone) {
      // zoomToFit is called after async load completes in _renderAll
    } else {
      this._ctrl.zoomToFit(this._nodes);
    }
  }
  onExit(): void {
    this._closeContextMenu();
    this._stopLogsPolling();
    this._hideSearchOverlay();
  }

  // ── Keyboard Shortcuts ──

  private _initKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      // Don't handle shortcuts when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+Z - Undo
      if (ctrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this._undo();
        return;
      }

      // Ctrl+Shift+Z or Ctrl+Y - Redo
      if ((ctrl && e.key === 'z' && e.shiftKey) || (ctrl && e.key === 'y')) {
        e.preventDefault();
        this._redo();
        return;
      }

      // Ctrl+C - Copy selected nodes
      if (ctrl && e.key === 'c' && (this._selectedNodeId || this._selectedNodeIds.size > 0)) {
        e.preventDefault();
        this._copySelectedNodes();
        return;
      }

      // Ctrl+V - Paste
      if (ctrl && e.key === 'v' && this._clipboard) {
        e.preventDefault();
        this._pasteNodes();
        return;
      }

      // Ctrl+D - Duplicate
      if (ctrl && e.key === 'd' && (this._selectedNodeId || this._selectedNodeIds.size > 0)) {
        e.preventDefault();
        this._duplicateSelectedNode();
        return;
      }

      // Delete/Backspace - Delete selected node or connection
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this._deleteSelected();
        return;
      }

      // Ctrl+S - Save (prevent default)
      if (ctrl && e.key === 's') {
        e.preventDefault();
        this._showToast('Auto-saved');
        return;
      }

      // Ctrl+F - Search nodes
      if (ctrl && e.key === 'f') {
        e.preventDefault();
        this._toggleSearchOverlay();
        return;
      }

      // Ctrl+G - Group selected nodes
      if (ctrl && e.key === 'g') {
        e.preventDefault();
        this._groupSelectedNodes();
        return;
      }

      // Ctrl+E - Export workflow
      if (ctrl && e.key === 'e') {
        e.preventDefault();
        this._exportWorkflow();
        return;
      }

      // L - Toggle logs panel
      if (e.key === 'l' && !ctrl) {
        e.preventDefault();
        this._toggleLogsPanel();
        return;
      }

      // Escape - Deselect all / close overlays
      if (e.key === 'Escape') {
        this._selectedNodeId = null;
        this._selectedConnId = null;
        this._selectedNodeIds.clear();
        this._updateNodeSelection();
        this._renderConnections();
        this._hideSearchOverlay();
        return;
      }

      // Ctrl+A - Select all
      if (ctrl && e.key === 'a') {
        e.preventDefault();
        this._selectAllNodes();
        return;
      }
    });
  }

  private _undo(): void {
    if (this._ctrl.undo()) {
      this._renderAll();
      this._showToast('Undo');
    }
  }

  private _redo(): void {
    if (this._ctrl.redo()) {
      this._renderAll();
      this._showToast('Redo');
    }
  }

  private _selectAllNodes(): void {
    this._selectedNodeIds.clear();
    for (const n of this._nodes) this._selectedNodeIds.add(n.id);
    this._updateNodeSelection();
    this._showToast(`Selected ${this._selectedNodeIds.size} nodes`);
  }

  private _copySelectedNodes(): void {
    const ids = this._selectedNodeIds.size > 0 ? this._selectedNodeIds :
                this._selectedNodeId ? new Set([this._selectedNodeId]) : new Set<string>();
    if (ids.size === 0) return;
    const copiedNodes = this._nodes.filter(n => ids.has(n.id));
    // Also copy connections between selected nodes
    const copiedConns = this._connections.filter(c => ids.has(c.fromNodeId) && ids.has(c.toNodeId));
    this._clipboard = {
      nodes: JSON.parse(JSON.stringify(copiedNodes)),
      connections: JSON.parse(JSON.stringify(copiedConns)),
    };
    this._showToast(`Copied ${copiedNodes.length} node(s)`);
  }

  private _pasteNodes(): void {
    if (!this._clipboard) return;
    this._ctrl.pushState('Paste nodes');
    const idMap = new Map<string, string>();
    for (const node of this._clipboard.nodes) {
      const newId = nextNodeId();
      idMap.set(node.id, newId);
      const newNode: WorkflowNode = {
        ...node,
        id: newId,
        x: node.x + 30,
        y: node.y + 30,
        title: node.title,
        data: { ...node.data },
      };
      this._nodes.push(newNode);
    }
    // Paste connections with remapped IDs
    for (const conn of this._clipboard.connections) {
      const newFrom = idMap.get(conn.fromNodeId);
      const newTo = idMap.get(conn.toNodeId);
      if (newFrom && newTo) {
        this._connections.push({
          id: 'c' + (++(this._ctrl as any)._connIdSeq),
          fromNodeId: newFrom, fromPortIndex: conn.fromPortIndex,
          toNodeId: newTo, toPortIndex: conn.toPortIndex,
        });
      }
    }
    this._persistCanvas();
    this._renderAll();
    this._showToast('Pasted node(s)');
  }

  private _duplicateSelectedNode(): void {
    if (this._selectedNodeId) {
      const node = this._nodes.find(n => n.id === this._selectedNodeId);
      if (!node) return;
      this._ctrl.pushState('Duplicate node');
      this._addNode(node.type, node.x + 30, node.y + 30);
      this._showToast('Duplicated node');
    } else if (this._selectedNodeIds.size > 0) {
      this._copySelectedNodes();
      this._pasteNodes();
    }
  }

  private _deleteSelected(): void {
    if (this._selectedNodeIds.size > 0) {
      this._ctrl.pushState('Delete nodes');
      const ids = new Set(this._selectedNodeIds);
      this._nodes = this._nodes.filter(n => !ids.has(n.id));
      this._connections = this._connections.filter(c => !ids.has(c.fromNodeId) && !ids.has(c.toNodeId));
      // Remove from groups
      for (const g of this._groups) {
        g.nodeIds = g.nodeIds.filter(id => !ids.has(id));
      }
      this._selectedNodeIds.clear();
      this._selectedNodeId = null;
      this._persistCanvas();
      this._renderAll();
    } else if (this._selectedNodeId) {
      this._ctrl.pushState('Delete node');
      this._nodes = this._nodes.filter(n => n.id !== this._selectedNodeId);
      this._connections = this._connections.filter(c => c.fromNodeId !== this._selectedNodeId && c.toNodeId !== this._selectedNodeId);
      // Remove from groups
      for (const g of this._groups) {
        g.nodeIds = g.nodeIds.filter(id => id !== this._selectedNodeId);
      }
      this._selectedNodeId = null;
      this._persistCanvas();
      this._renderAll();
    } else if (this._selectedConnId) {
      this._ctrl.pushState('Delete connection');
      this._connections = this._connections.filter(c => c.id !== this._selectedConnId);
      this._selectedConnId = null;
      this._persistCanvas();
      this._renderConnections();
    }
  }

  // ── Node Grouping ──

  private _groupSelectedNodes(): void {
    const ids = this._selectedNodeIds.size > 0 ? this._selectedNodeIds :
                this._selectedNodeId ? new Set([this._selectedNodeId]) : new Set<string>();
    if (ids.size < 2) {
      this._showToast('Select 2+ nodes to group');
      return;
    }
    this._ctrl.pushState('Group nodes');
    const groupId = nextGroupId();
    const group: WorkflowGroup = {
      id: groupId,
      title: `Group ${this._groups.length + 1}`,
      nodeIds: Array.from(ids),
      collapsed: false,
    };
    this._groups.push(group);
    for (const n of this._nodes) {
      if (ids.has(n.id)) n.groupId = groupId;
    }
    this._persistCanvas();
    this._renderAll();
    this._showToast(`Grouped ${ids.size} nodes`);
  }

  private _ungroupNode(nodeId: string): void {
    const node = this._nodes.find(n => n.id === nodeId);
    if (!node?.groupId) return;
    this._ctrl.pushState('Ungroup node');
    const group = this._groups.find(g => g.id === node.groupId);
    if (group) {
      group.nodeIds = group.nodeIds.filter(id => id !== nodeId);
      if (group.nodeIds.length === 0) {
        this._groups = this._groups.filter(g => g.id !== group.id);
      }
    }
    node.groupId = null;
    this._persistCanvas();
    this._renderAll();
  }

  // ── Import / Export ──

  private _exportWorkflow(): void {
    const wf = this._workflows.find(w => w.id === this._activeWfId);
    const data = {
      version: '3.0',
      workflow: {
        id: wf?.id,
        name: wf?.name || 'Exported Workflow',
        nodes: this._nodes,
        connections: this._connections,
        groups: this._groups,
      },
      exportedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(wf?.name || 'workflow').replace(/[^a-zA-Z0-9]/g, '_')}.workflow.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this._showToast('Workflow exported');
  }

  private _importWorkflow(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.workflow.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.workflow) {
          this._showToast('Invalid workflow file');
          return;
        }
        this._ctrl.pushState('Import workflow');
        this._nodes = data.workflow.nodes || [];
        this._connections = data.workflow.connections || [];
        this._groups = data.workflow.groups || [];
        resetIdSeqs(this._nodes, this._connections, this._groups, this._workflows);
        this._persistCanvas();
        this._renderAll();
        this._ctrl.zoomToFit(this._nodes);
        this._showToast(`Imported ${this._nodes.length} nodes`);
      } catch (err) {
        this._showToast('Failed to parse workflow file');
      }
    };
    input.click();
  }

  // ── Search ──

  private _toggleSearchOverlay(): void {
    if (this._searchVisible) {
      this._hideSearchOverlay();
    } else {
      this._showSearchOverlay();
    }
  }

  private _showSearchOverlay(): void {
    if (this._searchVisible) return;
    this._searchVisible = true;

    this._searchOverlay = document.createElement('div');
    this._searchOverlay.className = 'workflow-search-overlay';
    this._searchOverlay.innerHTML = `
      <div class="workflow-search-panel">
        <div class="workflow-search-header">
          <span class="workflow-search-title">Search Nodes</span>
          <button class="workflow-search-close" id="wf-search-close">&times;</button>
        </div>
        <div class="workflow-search-input-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="workflow-search-input" id="wf-search-input" placeholder="Search nodes by name or type... (Ctrl+F)" autofocus>
        </div>
        <div class="workflow-search-results" id="wf-search-results"></div>
      </div>`;

    document.body.appendChild(this._searchOverlay);

    const input = this._searchOverlay.querySelector('#wf-search-input') as HTMLInputElement;
    const resultsEl = this._searchOverlay.querySelector('#wf-search-results') as HTMLElement;

    input.focus();
    input.addEventListener('input', () => {
      const query = input.value.toLowerCase().trim();
      this._renderSearchResults(resultsEl, query);
    });
    this._renderSearchResults(resultsEl, '');

    this._searchOverlay.querySelector('#wf-search-close')?.addEventListener('click', () => this._hideSearchOverlay());
    this._searchOverlay.addEventListener('click', (e) => {
      if (e.target === this._searchOverlay) this._hideSearchOverlay();
    });
  }

  private _renderSearchResults(container: HTMLElement, query: string): void {
    const filtered = this._nodes.filter(n => {
      if (!query) return true;
      return n.title.toLowerCase().includes(query) ||
             n.type.toLowerCase().includes(query) ||
             (NODE_DEFS[n.type]?.label || '').toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      container.innerHTML = `<div class="workflow-search-empty">${query ? 'No matching nodes' : 'No nodes in workflow'}</div>`;
      return;
    }

    container.innerHTML = filtered.map(n => {
      const def = NODE_DEFS[n.type];
      return `<div class="workflow-search-item" data-node-id="${n.id}">
        <span class="workflow-search-dot" style="background:${def?.color || '#7c3aed'}"></span>
        <span class="workflow-search-name">${this._escapeHtml(n.title)}</span>
        <span class="workflow-search-type">${def?.label || n.type}</span>
      </div>`;
    }).join('');

    container.querySelectorAll('.workflow-search-item').forEach(item => {
      item.addEventListener('click', () => {
        const nodeId = (item as HTMLElement).dataset.nodeId!;
        this._selectedNodeId = nodeId;
        this._updateNodeSelection();
        // Pan to node
        const node = this._nodes.find(n => n.id === nodeId);
        if (node) {
          const rect = this._canvasContainer.getBoundingClientRect();
          this._ctrl.state.offsetX = rect.width / 2 - node.x * this._ctrl.state.zoom - 100;
          this._ctrl.state.offsetY = rect.height / 2 - node.y * this._ctrl.state.zoom - 60;
          this._ctrl.applyView();
        }
        this._hideSearchOverlay();
      });
    });
  }

  private _hideSearchOverlay(): void {
    this._searchVisible = false;
    if (this._searchOverlay) {
      this._searchOverlay.remove();
      this._searchOverlay = null;
    }
  }

  // ── Toast Notifications ──

  private _showToast(message: string, duration = 1500): void {
    const toast = document.createElement('div');
    toast.className = 'workflow-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  // ── DOM build ──

  private _buildDOM(): void {
    const root = this.container;
    root.innerHTML = `
      <div class="workflow-page">
        <div class="workflow-toolbar" id="wf-toolbar">
          <div class="workflow-toolbar-left">
            <span class="workflow-toolbar-title" id="wf-name-display">Workflow</span>
            <span class="workflow-node-count" id="wf-node-count">0</span>
          </div>
          <div class="workflow-toolbar-center">
            <button class="workflow-zoom-btn" id="wf-zoom-out" title="Zoom Out">−</button>
            <span class="workflow-zoom-label" id="wf-zoom-label">100%</span>
            <button class="workflow-zoom-btn" id="wf-zoom-in" title="Zoom In">+</button>
            <button class="workflow-zoom-btn" id="wf-zoom-fit" title="Fit to View">⊡</button>
          </div>
          <div class="workflow-toolbar-right" id="wf-toolbar-right"></div>
        </div>
        <div class="workflow-main" id="wf-main"></div>
      </div>`;

    this._toolbar = root.querySelector('#wf-toolbar')!;
    this._nodeCountEl = root.querySelector('#wf-node-count')!;
    this._zoomLabelEl = root.querySelector('#wf-zoom-label')!;
    this._wfNameEl = root.querySelector('#wf-name-display')!;

    // Main area: list | canvas | palette
    const main = root.querySelector('#wf-main')!;

    // Canvas area
    this._canvasContainer = document.createElement('div');
    this._canvasContainer.className = 'workflow-canvas-container';
    this._canvasContainer.id = 'wf-canvas-container';

    this._canvas = document.createElement('div');
    this._canvas.className = 'workflow-canvas';
    this._canvas.id = 'wf-canvas';

    this._svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this._svgLayer.setAttribute('class', 'workflow-connections');
    this._svgLayer.style.position = 'absolute';
    this._svgLayer.style.top = '0';
    this._svgLayer.style.left = '0';
    this._svgLayer.style.width = '100%';
    this._svgLayer.style.height = '100%';
    this._svgLayer.style.overflow = 'visible';
    this._canvas.appendChild(this._svgLayer);

    this._nodesLayer = document.createElement('div');
    this._nodesLayer.className = 'workflow-nodes-layer';
    this._nodesLayer.id = 'wf-nodes-layer';
    this._canvas.appendChild(this._nodesLayer);

    // Placeholder
    this._placeholder = document.createElement('div');
    this._placeholder.className = 'workflow-placeholder';
    this._placeholder.innerHTML = `<div>Drop nodes here</div><div class="workflow-placeholder-hint">Drag from palette or right-click</div>`;
    this._canvas.appendChild(this._placeholder);

    this._canvasContainer.appendChild(this._canvas);

    // Palette
    this._palette = document.createElement('div');
    this._palette.className = 'workflow-node-palette';
    this._palette.id = 'wf-palette';
    this._buildPalette();

    main.appendChild(this._canvasContainer);
    main.appendChild(this._palette);

    // Minimap
    this._minimapCanvas = document.createElement('canvas');
    this._minimapCanvas.className = 'workflow-minimap-canvas';
    this._minimapCanvas.width = 180;
    this._minimapCanvas.height = 120;
    const minimap = document.createElement('div');
    minimap.className = 'workflow-minimap';
    minimap.appendChild(this._minimapCanvas);
    this._canvasContainer.appendChild(minimap);

    // Toolbar actions
    root.querySelector('#wf-zoom-in')?.addEventListener('click', () => { this._ctrl.state.zoom = Math.min(MAX_ZOOM, this._ctrl.state.zoom + 0.2); this._refresh(); });
    root.querySelector('#wf-zoom-out')?.addEventListener('click', () => { this._ctrl.state.zoom = Math.max(MIN_ZOOM, this._ctrl.state.zoom - 0.2); this._refresh(); });
    root.querySelector('#wf-zoom-fit')?.addEventListener('click', () => this._ctrl.zoomToFit(this._nodes));
  }

  private _buildPalette(): void {
    let html = `
      <div class="workflow-palette-header">
        <span>Add Node</span>
      </div>
      <div class="workflow-palette-search-wrap">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="workflow-palette-search" id="wf-palette-search" placeholder="Filter nodes... (Ctrl+F)">
      </div>`;
    for (const group of PALETTE_GROUPS) {
      html += `<div class="workflow-palette-group-title" data-group-label="${group.label}">${group.label}</div>`;
      for (const type of group.types) {
        const def = NODE_DEFS[type];
        if (!def) continue;
        html += `
          <div class="workflow-palette-item" data-palette-type="${type}" data-palette-label="${(def.label + ' ' + group.label).toLowerCase()}" draggable="true">
            <span class="workflow-palette-dot" style="background:${def.color}"></span>
            <span class="workflow-palette-icon">${def.icon}</span>
            <span class="workflow-palette-label">${def.label}</span>
          </div>`;
      }
    }
    this._palette.innerHTML = html;

    // Palette search/filter
    const searchInput = this._palette.querySelector('#wf-palette-search') as HTMLInputElement;
    searchInput?.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase().trim();
      this._palette.querySelectorAll('.workflow-palette-item').forEach(item => {
        const label = (item as HTMLElement).dataset.paletteLabel || '';
        const type = (item as HTMLElement).dataset.paletteType || '';
        const matches = !query || label.includes(query) || type.includes(query);
        (item as HTMLElement).style.display = matches ? '' : 'none';
      });
      // Show/hide group titles based on whether they have visible children
      this._palette.querySelectorAll('.workflow-palette-group-title').forEach(titleEl => {
        const groupLabel = (titleEl as HTMLElement).dataset.groupLabel;
        const nextItems = PALETTE_GROUPS.find(g => g.label === groupLabel)?.types || [];
        const hasVisible = nextItems.some(t => {
          const itemEl = this._palette.querySelector(`[data-palette-type="${t}"]`) as HTMLElement;
          return itemEl && itemEl.style.display !== 'none';
        });
        (titleEl as HTMLElement).style.display = hasVisible ? '' : 'none';
      });
    });

    // Drag from palette to canvas
    this._palette.querySelectorAll('.workflow-palette-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        const type = (item as HTMLElement).dataset.paletteType!;
        (e as DragEvent).dataTransfer?.setData('text/plain', type);
      });
      // Click to add at canvas center
      item.addEventListener('click', () => {
        const type = (item as HTMLElement).dataset.paletteType!;
        const w = this._canvasContainer.clientWidth;
        const h = this._canvasContainer.clientHeight;
        const cx = (w / 2 - this._ctrl.state.offsetX) / this._ctrl.state.zoom;
        const cy = (h / 2 - this._ctrl.state.offsetY) / this._ctrl.state.zoom;
        this._addNode(type, Math.round(cx - 100), Math.round(cy - 30));
      });
    });

    this._canvasContainer.addEventListener('dragover', (e) => e.preventDefault());
    this._canvasContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      const type = (e as DragEvent).dataTransfer?.getData('text/plain');
      if (!type) return;
      const rect = this._canvasContainer.getBoundingClientRect();
      let x = ((e.clientX - rect.left) - this._ctrl.state.offsetX) / this._ctrl.state.zoom;
      let y = ((e.clientY - rect.top) - this._ctrl.state.offsetY) / this._ctrl.state.zoom;
      if (this._ctrl.snapToGrid) {
        x = Math.round(x / GRID_SIZE) * GRID_SIZE;
        y = Math.round(y / GRID_SIZE) * GRID_SIZE;
      }
      this._addNode(type, Math.round(x - 100), Math.round(y - 30));
    });
  }

  // ── Canvas init ──

  private _initCanvas(): void {
    const callbacks: CanvasCallbacks = {
      getNodes: () => this._nodes,
      getConnections: () => this._connections,
      onNodeMoved: (id, x, y) => {
        const n = this._nodes.find(n => n.id === id);
        if (n) { n.x = x; n.y = y; }
      },
      onConnectionCreated: (conn) => {
        this._ctrl.pushState('Create connection');
        this._connections.push(conn);
        this._persistCanvas();
        this._renderConnections();
      },
      onConnectionDisconnect: (nodeId, portIndex, isOutput) => {
        const before = this._connections.length;
        this._connections = this._connections.filter(c =>
          isOutput
            ? !(c.fromNodeId === nodeId && c.fromPortIndex === portIndex)
            : !(c.toNodeId === nodeId && c.toPortIndex === portIndex)
        );
        if (this._connections.length < before) {
          this._ctrl.pushState('Disconnect');
          this._persistCanvas();
          this._renderConnections();
        }
      },
      onConnectionSelected: (id) => { this._selectedConnId = id; this._selectedNodeId = null; this._renderConnections(); },
      onNodeSelected: (id) => { this._selectedNodeId = id; this._selectedConnId = null; this._updateNodeSelection(); },
      onCanvasContextMenu: (x, y) => this._showCanvasContextMenu(x, y),
      onNodeContextMenu: (id, x, y) => this._showNodeContextMenu(id, x, y),
      onUpdateView: () => this._refresh(),
      onStateChange: () => this._updateUndoRedoButtons(),
    };
    this._ctrl = new WorkflowCanvasController(this._canvasContainer, this._canvas, this._svgLayer, callbacks);

    // Right-click context menu on canvas
    this._canvasContainer.addEventListener('contextmenu', (e) => {
      const target = e.target as HTMLElement;
      const nodeEl = target.closest('.workflow-node') as HTMLElement;
      if (nodeEl) {
        e.preventDefault();
        const nodeId = nodeEl.getAttribute('data-node-id')!;
        this._showNodeContextMenu(nodeId, e.clientX, e.clientY);
      } else if (target.closest('.workflow-conn-path') || target.closest('.workflow-conn-hitarea')) {
        e.preventDefault();
        this._showConnContextMenu(e.clientX, e.clientY);
      } else if (!target.closest('.workflow-list-container')) {
        e.preventDefault();
        this._showCanvasContextMenu(e.clientX, e.clientY);
      }
    });

    // Override node drag to use canvas controller
    this._nodesLayer.addEventListener('mousedown', (e) => {
      const nodeEl = (e.target as HTMLElement).closest('.workflow-node') as HTMLElement;
      if (!nodeEl) return;

      e.stopPropagation(); // Prevent canvas-container from misinterpreting after DOM rebuild

      const nodeId = nodeEl.getAttribute('data-node-id')!;
      const node = this._nodes.find(n => n.id === nodeId);
      if (!node) return;

      // Check for port interaction
      const portEl = (e.target as HTMLElement).closest('[data-port]') as HTMLElement;
      if (portEl) {
        const isOutput = portEl.getAttribute('data-port') === 'out';
        const portIndex = parseInt(portEl.getAttribute('data-port-index') || '0');
        this._ctrl.startPortConnect(nodeId, portIndex, isOutput, e);
        return;
      }

      // Check for delete button or textarea - allow default behavior
      if ((e.target as HTMLElement).closest('.workflow-node-delete') ||
          (e.target as HTMLElement).closest('textarea') ||
          (e.target as HTMLElement).closest('select') ||
          (e.target as HTMLElement).closest('input')) return;

      // Multi-select with Shift
      if (e.shiftKey) {
        if (this._selectedNodeIds.has(nodeId)) {
          this._selectedNodeIds.delete(nodeId);
        } else {
          this._selectedNodeIds.add(nodeId);
        }
        this._selectedNodeId = null;
        this._selectedConnId = null;
        this._updateNodeSelection();
        return;
      }

      // Select then start drag - push state for undo on drag end
      this._selectedNodeId = nodeId;
      this._selectedConnId = null;
      this._selectedNodeIds.clear();
      this._updateNodeSelection();

      // Push undo state before drag starts
      const startX = node.x, startY = node.y;
      const origNode = { x: node.x, y: node.y };
      const origDrag = { active: true };

      this._ctrl.startNodeDrag(nodeId, node.x, node.y, e);

      // Register a one-shot mouseup to push undo state after drag
      const onUp = () => {
        window.removeEventListener('mouseup', onUp);
        if (origDrag.active) {
          origDrag.active = false;
          const moved = this._nodes.find(n => n.id === nodeId);
          if (moved && (moved.x !== origNode.x || moved.y !== origNode.y)) {
            this._ctrl.pushState('Move node');
          }
        }
      };
      window.addEventListener('mouseup', onUp);
    });

    // Wire up minimap click navigation
    renderMinimap(this._minimapCanvas, this._nodes, this._connections, 0, 0, 0, 0, 1, this._groups, (cx, cy, cw, ch) => {
      this._ctrl.navigateToMinimapPosition(cx, cy, cw, ch, this._nodes);
    });
  }

  // ── Data ──

  /** Save canvas to API before executing */
  private _saveToApi(): Promise<void> {
    if (!this._activeWfId) return Promise.resolve();
    return fetch('/api/v1/workflows/' + this._activeWfId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodes: this._nodes,
        connections: this._connections,
        groups: this._groups,
        sessionMode: this._sessionMode,
      }),
    }).then(() => {}).catch(() => {});
  }

  private async _loadAndRender(): Promise<void> {
    // Try API first
    const apiWfs = await fetchWorkflows();
    if (apiWfs.length > 0) {
      this._workflows = apiWfs;
      if (!this._activeWfId || !this._workflows.find(w => w.id === this._activeWfId)) {
        this._activeWfId = apiWfs[0].id;
      }
    } else {
      // Fallback to localStorage
      const store = loadStore();
      this._workflows = store.workflows;
      this._activeWfId = store.activeWorkflowId || (store.workflows[0]?.id || null);
    }

    if (!this._activeWfId && this._workflows.length === 0) {
      // Create default workflow
      const wf = await apiCreateWorkflow('My Workflow');
      if (wf) {
        this._workflows = [wf];
        this._activeWfId = wf.id;
      }
    }

    await this._loadCanvas();
    this._renderAll();
  }

  private async _loadCanvas(): Promise<void> {
    if (!this._activeWfId) { this._nodes = []; this._connections = []; this._groups = []; return; }

    // 1. Try localStorage first (fast, supports unsaved edits)
    const data = loadCanvasData(this._activeWfId);
    if (data) {
      this._nodes = data.nodes || [];
      this._connections = data.connections || [];
      this._groups = data.groups || [];
      this._sessionMode = (data.sessionMode === 'ephemeral' ? 'ephemeral' : 'persistent');
      resetIdSeqs(this._nodes, this._connections, this._groups, this._workflows);
      return;
    }

    // 2. Fallback: fetch workflow from API (server has the nodes/connections)
    try {
      const r = await fetch('/api/v1/workflows/' + this._activeWfId);
      if (r.ok) {
        const wf = await r.json();
        if (wf.nodes && wf.nodes.length > 0) {
          this._nodes = wf.nodes || [];
          this._connections = wf.connections || [];
          this._groups = wf.groups || [];
          resetIdSeqs(this._nodes, this._connections, this._groups, this._workflows);
          // Save to localStorage for future fast access
          saveCanvasData(this._activeWfId, { nodes: this._nodes, connections: this._connections, groups: this._groups });
          return;
        }
      }
    } catch { /* fall through to empty canvas */ }

    this._nodes = []; this._connections = []; this._groups = [];
  }

  private _persistCanvas(): void {
    if (!this._activeWfId) return;
    saveCanvasData(this._activeWfId, { nodes: this._nodes, connections: this._connections, groups: this._groups, sessionMode: this._sessionMode });
  }

  // ── Render ──

  private _renderAll(): void {
    this._renderToolbar();
    this._renderList();
    this._renderNodes();
    this._renderConnections();
    this._renderGroups();
    this._updatePlaceholder();
    this._ctrl.applyView();
    this._updateMinimap();
    this._updateUndoRedoButtons();
    if (!this._initialZoomDone && this._nodes.length > 0) {
      this._initialZoomDone = true;
      this._ctrl.zoomToFit(this._nodes);
    } else if (!this._initialZoomDone) {
      this._initialZoomDone = true;
    }
  }

  private _refresh(): void {
    this._ctrl.applyView();
    this._zoomLabelEl.textContent = Math.round(this._ctrl.state.zoom * 100) + '%';
    // Debounce minimap to avoid redundant paints during drag/pan
    if (!this._minimapTimer) {
      this._minimapTimer = requestAnimationFrame(() => {
        this._minimapTimer = 0;
        this._updateMinimap();
      });
    }
  }

  private _renderToolbar(): void {
    const wf = this._workflows.find(w => w.id === this._activeWfId);
    this._wfNameEl.textContent = wf?.name || 'No workflow';
    this._nodeCountEl.textContent = String(this._nodes.length);
    this._zoomLabelEl.textContent = Math.round(this._ctrl.state.zoom * 100) + '%';

    // Status + Run/Stop buttons
    const right = this._toolbar.querySelector('#wf-toolbar-right')!;
    const status = wf?.status || 'idle';
    const isSnap = this._ctrl.snapToGrid;
    right.innerHTML = `
      ${status === 'idle' ? '<button class="plugin-btn" id="wf-run-btn" style="color:#59d499;border-color:rgba(89,212,153,0.3);">Run</button>' : ''}
      ${status === 'running' ? '<button class="plugin-btn plugin-btn-danger" id="wf-stop-btn">Stop</button>' : ''}
      <button class="workflow-zoom-btn" id="wf-logs-btn" title="Toggle Logs (L)" style="font-size:12px;width:auto;padding:0 6px;">📋</button>
      <button class="workflow-zoom-btn" id="wf-undo-btn" title="Undo (Ctrl+Z)" style="font-size:12px;width:auto;padding:0 6px;opacity:0.4;">↶</button>
      <button class="workflow-zoom-btn" id="wf-redo-btn" title="Redo (Ctrl+Shift+Z)" style="font-size:12px;width:auto;padding:0 6px;opacity:0.4;">↷</button>
      <button class="workflow-zoom-btn ${isSnap ? 'active' : ''}" id="wf-snap-btn" title="Toggle Snap to Grid" style="font-size:11px;width:auto;padding:0 6px;${isSnap ? 'color:var(--color-accent);' : ''}">⊞</button>
      <button class="workflow-zoom-btn" id="wf-search-btn" title="Search (Ctrl+F)" style="font-size:12px;width:auto;padding:0 6px;">🔍</button>
      <button class="workflow-zoom-btn" id="wf-import-btn" title="Import Workflow" style="font-size:12px;width:auto;padding:0 6px;">📂</button>
      <button class="workflow-zoom-btn" id="wf-export-btn" title="Export Workflow (Ctrl+E)" style="font-size:12px;width:auto;padding:0 6px;">💾</button>
      <span class="workflow-status-badge" style="background:${status === 'running' ? 'rgba(255,197,51,0.12)' : status === 'completed' ? 'rgba(89,212,153,0.12)' : status === 'error' ? 'rgba(255,97,97,0.12)' : 'rgba(255,255,255,0.06)'};color:${status === 'running' ? '#ffc533' : status === 'completed' ? '#59d499' : status === 'error' ? '#ff6161' : 'var(--color-text-tertiary)'};">${status}</span>
      <select id="wf-session-mode" style="margin-left:4px;font-size:10px;background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-hairline);border-radius:6px;padding:2px 4px;">
        <option value="persistent" ${this._sessionMode === 'persistent' ? 'selected' : ''}>Persistent session</option>
        <option value="ephemeral" ${this._sessionMode === 'ephemeral' ? 'selected' : ''}>Ephemeral session</option>
      </select>`;
    right.querySelector('#wf-run-btn')?.addEventListener('click', async () => {
      if (this._activeWfId) { await this._saveToApi(); apiStartWorkflow(this._activeWfId).then(() => this._loadAndRender()); }
    });
    right.querySelector('#wf-stop-btn')?.addEventListener('click', () => { if (this._activeWfId) apiStopWorkflow(this._activeWfId).then(() => this._loadAndRender()); });
    right.querySelector('#wf-session-mode')?.addEventListener('change', async (e) => {
      this._sessionMode = (e.target as HTMLSelectElement).value as 'persistent' | 'ephemeral';
      this._persistCanvas();
      await this._saveToApi();
    });
    right.querySelector('#wf-logs-btn')?.addEventListener('click', () => this._toggleLogsPanel());
    right.querySelector('#wf-undo-btn')?.addEventListener('click', () => this._undo());
    right.querySelector('#wf-redo-btn')?.addEventListener('click', () => this._redo());
    right.querySelector('#wf-snap-btn')?.addEventListener('click', () => {
      this._ctrl.toggleSnapToGrid();
      this._renderToolbar();
      this._showToast(this._ctrl.snapToGrid ? 'Snap-to-grid ON' : 'Snap-to-grid OFF');
    });
    right.querySelector('#wf-search-btn')?.addEventListener('click', () => this._toggleSearchOverlay());
    right.querySelector('#wf-import-btn')?.addEventListener('click', () => this._importWorkflow());
    right.querySelector('#wf-export-btn')?.addEventListener('click', () => this._exportWorkflow());

    this._updateUndoRedoButtons();
  }

  private _updateUndoRedoButtons(): void {
    const undoBtn = this._toolbar.querySelector('#wf-undo-btn') as HTMLElement | null;
    const redoBtn = this._toolbar.querySelector('#wf-redo-btn') as HTMLElement | null;
    if (undoBtn) undoBtn.style.opacity = this._ctrl.canUndo ? '1' : '0.4';
    if (redoBtn) redoBtn.style.opacity = this._ctrl.canRedo ? '1' : '0.4';
  }

  private _renderList(): void {
    const main = this.container.querySelector('#wf-main')!;
    if (this._listEl) this._listEl.remove();
    this._listEl = buildList(this._workflows, this._activeWfId, {
      onSelect: async (id) => { this._activeWfId = id; await this._loadCanvas(); this._renderAll(); },
      onAdd: async () => { const wf = await apiCreateWorkflow('New Workflow'); if (wf) { this._workflows.push(wf); this._activeWfId = wf.id; await this._loadCanvas(); this._renderAll(); } },
      onDelete: async (id) => { await apiDeleteWorkflow(id); this._workflows = this._workflows.filter(w => w.id !== id); if (this._activeWfId === id) { this._activeWfId = this._workflows[0]?.id || null; await this._loadCanvas(); } this._renderAll(); },
    });
    main.insertBefore(this._listEl, this._canvasContainer);
  }

  private _renderNodes(): void {
    this._nodesLayer.innerHTML = '';
    for (const node of this._nodes) {
      // Skip nodes inside collapsed groups
      if (node.groupId) {
        const group = this._groups.find(g => g.id === node.groupId);
        if (group?.collapsed) continue;
      }
      const el = renderNode(node, node.id === this._selectedNodeId, {
        onMoveStart: (e) => { this._selectedNodeId = node.id; this._selectedConnId = null; this._selectedNodeIds.clear(); this._updateNodeSelection(); this._ctrl.startNodeDrag(node.id, node.x, node.y, e); },
        onDelete: () => {
          this._ctrl.pushState('Delete node');
          this._nodes = this._nodes.filter(n => n.id !== node.id);
          this._connections = this._connections.filter(c => c.fromNodeId !== node.id && c.toNodeId !== node.id);
          this._persistCanvas();
          this._renderAll();
        },
        onTitleChange: (title) => { node.title = title; this._persistCanvas(); },
        onParamChange: (key, value) => {
          this._ctrl.pushState('Change parameter');
          node.data = node.data || {};
          node.data[key] = value;
          this._persistCanvas();
        },
        onPortMouseDown: (portIndex, isOutput, e) => this._ctrl.startPortConnect(node.id, portIndex, isOutput, e),
      }, this._selectedNodeIds);
      this._nodesLayer.appendChild(el);
    }
  }

  /** Lightweight selection update - toggle class without full DOM rebuild */
  private _updateNodeSelection(): void {
    this._nodesLayer.querySelectorAll('.workflow-node').forEach(el => {
      const id = el.getAttribute('data-node-id');
      el.classList.toggle('workflow-node-selected', id === this._selectedNodeId);
      el.classList.toggle('workflow-node-multi-selected', !!id && this._selectedNodeIds.has(id));
    });
  }

  private _renderConnections(): void {
    renderConnections(this._svgLayer, this._connections, this._nodes, this._selectedConnId, (id) => {
      this._selectedConnId = id; this._selectedNodeId = null; this._renderConnections();
    }, this._executionState, this._nodesLayer, this._ctrl.state.zoom);
  }

  private _renderGroups(): void {
    // Remove existing group overlays
    this._nodesLayer.querySelectorAll('.workflow-group-container').forEach(el => el.remove());

    for (const group of this._groups) {
      if (group.collapsed) {
        // Render collapsed group as a single container node
        const groupNodes = this._nodes.filter(n => group.nodeIds.includes(n.id));
        if (groupNodes.length === 0) continue;

        const minX = Math.min(...groupNodes.map(n => n.x));
        const minY = Math.min(...groupNodes.map(n => n.y));
        const maxX = Math.max(...groupNodes.map(n => n.x + 200));
        const maxY = Math.max(...groupNodes.map(n => n.y + 120));
        const padding = 16;

        const container = document.createElement('div');
        container.className = 'workflow-group-container workflow-group-collapsed';
        container.style.left = (minX - padding) + 'px';
        container.style.top = (minY - padding - 28) + 'px';
        container.style.width = (maxX - minX + padding * 2) + 'px';
        container.style.height = (maxY - minY + padding * 2 + 28) + 'px';
        container.innerHTML = `
          <div class="workflow-group-header">
            <span class="workflow-group-title">${this._escapeHtml(group.title)}</span>
            <span class="workflow-group-count">${groupNodes.length} nodes</span>
            <button class="workflow-group-expand" title="Expand">&times;</button>
          </div>`;

        container.querySelector('.workflow-group-expand')?.addEventListener('click', () => {
          this._ctrl.pushState('Expand group');
          group.collapsed = false;
          this._persistCanvas();
          this._renderAll();
        });

        container.addEventListener('dblclick', () => {
          this._ctrl.pushState('Expand group');
          group.collapsed = false;
          this._persistCanvas();
          this._renderAll();
        });

        this._nodesLayer.appendChild(container);
      } else {
        // Render expanded group as a background rectangle
        const groupNodes = this._nodes.filter(n => group.nodeIds.includes(n.id));
        if (groupNodes.length === 0) continue;

        const minX = Math.min(...groupNodes.map(n => n.x));
        const minY = Math.min(...groupNodes.map(n => n.y));
        const maxX = Math.max(...groupNodes.map(n => n.x + 200));
        const maxY = Math.max(...groupNodes.map(n => n.y + 120));
        const padding = 12;

        const container = document.createElement('div');
        container.className = 'workflow-group-container workflow-group-expanded';
        container.style.left = (minX - padding) + 'px';
        container.style.top = (minY - padding - 24) + 'px';
        container.style.width = (maxX - minX + padding * 2) + 'px';
        container.style.height = (maxY - minY + padding * 2 + 24) + 'px';
        container.innerHTML = `
          <div class="workflow-group-header">
            <span class="workflow-group-title">${this._escapeHtml(group.title)}</span>
            <button class="workflow-group-collapse" title="Collapse">−</button>
          </div>`;

        container.querySelector('.workflow-group-collapse')?.addEventListener('click', () => {
          this._ctrl.pushState('Collapse group');
          group.collapsed = true;
          this._persistCanvas();
          this._renderAll();
        });

        this._nodesLayer.appendChild(container);
      }
    }
  }

  private _updatePlaceholder(): void {
    this._placeholder.style.display = this._nodes.length === 0 ? '' : 'none';
  }

  private _updateMinimap(): void {
    const containerRect = this._canvasContainer.getBoundingClientRect();
    renderMinimap(this._minimapCanvas, this._nodes, this._connections, containerRect.width, containerRect.height, this._ctrl.state.offsetX, this._ctrl.state.offsetY, this._ctrl.state.zoom, this._groups);
  }

  // ── Execution Logs Panel ──

  private _toggleLogsPanel(): void {
    if (this._logsVisible) {
      this._hideLogsPanel();
    } else {
      this._showLogsPanel();
    }
  }

  private _showLogsPanel(): void {
    if (this._logsVisible) return;
    this._logsVisible = true;

    this._logsPanelEl = document.createElement('div');
    this._logsPanelEl.className = 'workflow-logs-panel';
    this._logsPanelEl.innerHTML = `
      <div class="workflow-logs-header">
        <span class="workflow-logs-header-title">Execution Logs</span>
        <div class="workflow-logs-header-actions">
          <button class="workflow-logs-header-btn" id="wf-logs-refresh" title="Refresh">↻</button>
          <button class="workflow-logs-header-btn" id="wf-logs-clear" title="Clear">✕</button>
          <button class="workflow-logs-header-btn" id="wf-logs-close" title="Close">−</button>
        </div>
      </div>
      <div class="workflow-logs-body" id="wf-logs-body">
        <div style="padding:12px;color:var(--color-text-tertiary);">No logs yet. Run a workflow to see execution logs.</div>
      </div>`;

    this._canvasContainer.appendChild(this._logsPanelEl);

    this._logsPanelEl.querySelector('#wf-logs-close')?.addEventListener('click', () => this._hideLogsPanel());
    this._logsPanelEl.querySelector('#wf-logs-clear')?.addEventListener('click', () => {
      const body = this._logsPanelEl?.querySelector('#wf-logs-body');
      if (body) body.innerHTML = '<div style="padding:12px;color:var(--color-text-tertiary);">Logs cleared.</div>';
    });
    this._logsPanelEl.querySelector('#wf-logs-refresh')?.addEventListener('click', () => this._fetchLogs());

    // Initial fetch
    this._fetchLogs();

    // Poll for updates while running
    this._startLogsPolling();
  }

  private _hideLogsPanel(): void {
    this._logsVisible = false;
    this._stopLogsPolling();
    if (this._logsPanelEl) {
      this._logsPanelEl.remove();
      this._logsPanelEl = null;
    }
  }

  private _startLogsPolling(): void {
    this._stopLogsPolling();
    this._logsPollTimer = window.setInterval(() => {
      const wf = this._workflows.find(w => w.id === this._activeWfId);
      if (wf?.status === 'running') {
        this._fetchLogs();
      }
    }, 2000);
  }

  private _stopLogsPolling(): void {
    if (this._logsPollTimer) {
      clearInterval(this._logsPollTimer);
      this._logsPollTimer = 0;
    }
  }

  private async _fetchLogs(): Promise<void> {
    if (!this._activeWfId) return;
    try {
      const r = await fetch(`/api/v1/workflows/${this._activeWfId}/logs`);
      if (!r.ok) return;
      const data = await r.json();
      const logs = data.logs || [];
      const execState = data.executionState;

      // Store execution state for flow animation
      this._executionState = execState;

      // Update node statuses from execution state
      if (execState?.nodeResults) {
        for (const node of this._nodes) {
          if (execState.currentNodeId === node.id && execState.status === 'running') {
            node.status = 'running';
          } else if (execState.nodeResults[node.id] !== undefined) {
            const result = execState.nodeResults[node.id];
            node.status = result?.error ? 'error' : 'success';
          } else {
            node.status = 'idle';
          }
        }
        this._renderNodes();
        this._renderConnections();
      }

      const body = this._logsPanelEl?.querySelector('#wf-logs-body');
      if (!body) return;

      if (logs.length === 0) {
        body.innerHTML = '<div style="padding:12px;color:var(--color-text-tertiary);">No logs yet. Run a workflow to see execution logs.</div>';
        return;
      }

      // Add execution state header if running
      let html = '';
      if (execState?.status === 'running' && execState?.currentNodeId) {
        const currentNode = this._nodes.find(n => n.id === execState.currentNodeId);
        html += `<div class="workflow-log-entry" style="background:rgba(255,197,51,0.08);position:sticky;top:0;">
          <span class="workflow-log-level" style="color:#ffc533;">RUN</span>
          <span class="workflow-log-msg">Running: ${currentNode?.title || execState.currentNodeId}</span>
        </div>`;
      }

      for (const log of logs) {
        const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
        const level = log.level || 'info';
        const msg = log.message || JSON.stringify(log);
        html += `<div class="workflow-log-entry">
          <span class="workflow-log-time">${time}</span>
          <span class="workflow-log-level ${level}">${level}</span>
          <span class="workflow-log-msg">${this._escapeHtml(msg)}</span>
        </div>`;
      }
      body.innerHTML = html;
      body.scrollTop = body.scrollHeight;
    } catch {
      // Silently ignore fetch errors
    }
  }

  private _escapeHtml(s: string): string {
    const el = document.createElement('span'); el.textContent = s;
    return el.innerHTML;
  }

  // ── Node operations ──

  private _addNode(type: string, x: number, y: number): void {
    const def = NODE_DEFS[type];
    if (!def) return;
    let posX = Math.max(0, x);
    let posY = Math.max(0, y);
    if (this._ctrl.snapToGrid) {
      posX = Math.round(posX / GRID_SIZE) * GRID_SIZE;
      posY = Math.round(posY / GRID_SIZE) * GRID_SIZE;
    }
    const node: WorkflowNode = {
      id: nextNodeId(), type, x: posX, y: posY,
      title: def.defaultTitle, description: '', status: 'idle',
      params: {}, groupId: null,
      inputLabels: [...def.inputLabels], outputLabels: [...def.outputLabels],
    };
    this._nodes.push(node);
    this._selectedNodeId = node.id;

    // Push undo state
    this._ctrl.pushState(`Add ${def.label}`);

    this._persistCanvas();

    // Incremental: append single node DOM instead of full _renderAll
    const el = renderNode(node, true, {
      onMoveStart: (e) => { this._selectedNodeId = node.id; this._selectedConnId = null; this._updateNodeSelection(); this._ctrl.startNodeDrag(node.id, node.x, node.y, e); },
      onDelete: () => {
        this._ctrl.pushState('Delete node');
        this._nodes = this._nodes.filter(n => n.id !== node.id);
        this._connections = this._connections.filter(c => c.fromNodeId !== node.id && c.toNodeId !== node.id);
        this._persistCanvas();
        this._renderAll();
      },
      onTitleChange: (title) => { node.title = title; this._persistCanvas(); },
      onParamChange: (key, value) => {
        this._ctrl.pushState('Change parameter');
        node.data = node.data || {};
        node.data[key] = value;
        this._persistCanvas();
      },
      onPortMouseDown: (portIndex, isOutput, e) => this._ctrl.startPortConnect(node.id, portIndex, isOutput, e),
    }, this._selectedNodeIds);
    this._updateNodeSelection();
    this._nodesLayer.appendChild(el);
    this._nodeCountEl.textContent = String(this._nodes.length);
    this._updatePlaceholder();
    this._renderConnections();
    this._updateMinimap();
    this._ctrl.applyView();
  }

  // ── Context menus ──

  private _showCanvasContextMenu(x: number, y: number): void {
    this._closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'workflow-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // Build menu from all available node types grouped by palette groups
    let html = '';
    for (const group of PALETTE_GROUPS) {
      for (const type of group.types) {
        const def = NODE_DEFS[type];
        if (!def) continue;
        html += `<div class="workflow-context-item" data-action="add-${type}">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${def.color};margin-right:6px;"></span>
          ${def.label}
        </div>`;
      }
    }
    html += '<div class="workflow-context-divider"></div>';
    html += '<div class="workflow-context-item" data-action="import">Import Workflow</div>';
    html += '<div class="workflow-context-item" data-action="export">Export Workflow</div>';
    if (this._nodes.length > 0) html += '<div class="workflow-context-item" data-action="fit">Fit to View</div>';
    menu.innerHTML = html;
    document.body.appendChild(menu);
    this._contextMenu = menu;

    menu.querySelectorAll('[data-action]').forEach(item => {
      item.addEventListener('click', () => {
        const action = (item as HTMLElement).dataset.action!;
        this._closeContextMenu();
        if (action === 'fit') { this._ctrl.zoomToFit(this._nodes); return; }
        if (action === 'import') { this._importWorkflow(); return; }
        if (action === 'export') { this._exportWorkflow(); return; }
        const rect = this._canvasContainer.getBoundingClientRect();
        const cx = (x - rect.left - this._ctrl.state.offsetX) / this._ctrl.state.zoom;
        const cy = (y - rect.top - this._ctrl.state.offsetY) / this._ctrl.state.zoom;
        this._addNode(action.replace('add-', ''), cx - 100, cy - 30);
      });
    });

    setTimeout(() => document.addEventListener('click', () => this._closeContextMenu(), { once: true }), 0);
  }

  private _showNodeContextMenu(nodeId: string, x: number, y: number): void {
    this._closeContextMenu();
    const node = this._nodes.find(n => n.id === nodeId);
    const hasGroup = node?.groupId;
    const menu = document.createElement('div');
    menu.className = 'workflow-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.innerHTML = `
      <div class="workflow-context-item" data-action="duplicate">Duplicate</div>
      <div class="workflow-context-item" data-action="copy">Copy <span class="workflow-shortcut-hint">Ctrl+C</span></div>
      ${hasGroup ? '<div class="workflow-context-item" data-action="ungroup">Ungroup</div>' : ''}
      <div class="workflow-context-divider"></div>
      <div class="workflow-context-item workflow-context-item-danger" data-action="delete">Delete Node <span class="workflow-shortcut-hint">Del</span></div>`;
    document.body.appendChild(menu);
    this._contextMenu = menu;

    menu.querySelector('[data-action="duplicate"]')?.addEventListener('click', () => {
      this._closeContextMenu();
      const node = this._nodes.find(n => n.id === nodeId);
      if (node) {
        this._ctrl.pushState('Duplicate node');
        this._addNode(node.type, node.x + 30, node.y + 30);
      }
    });
    menu.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
      this._closeContextMenu();
      this._selectedNodeId = nodeId;
      this._copySelectedNodes();
    });
    menu.querySelector('[data-action="ungroup"]')?.addEventListener('click', () => {
      this._closeContextMenu();
      this._ungroupNode(nodeId);
    });
    menu.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      this._closeContextMenu();
      this._ctrl.pushState('Delete node');
      this._nodes = this._nodes.filter(n => n.id !== nodeId);
      this._connections = this._connections.filter(c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId);
      this._persistCanvas();
      this._renderAll();
    });

    setTimeout(() => document.addEventListener('click', () => this._closeContextMenu(), { once: true }), 0);
  }

  private _showConnContextMenu(x: number, y: number): void {
    this._closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'workflow-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.innerHTML = `
      <div class="workflow-context-item workflow-context-item-danger" data-action="delete-conn">Delete Connection <span class="workflow-shortcut-hint">Del</span></div>`;
    document.body.appendChild(menu);
    this._contextMenu = menu;

    menu.querySelector('[data-action="delete-conn"]')?.addEventListener('click', () => {
      this._closeContextMenu();
      this._ctrl.pushState('Delete connection');
      this._connections = this._connections.filter(c => c.id !== this._selectedConnId);
      this._selectedConnId = null;
      this._persistCanvas();
      this._renderConnections();
    });

    setTimeout(() => document.addEventListener('click', () => this._closeContextMenu(), { once: true }), 0);
  }

  private _closeContextMenu(): void {
    if (this._contextMenu) { this._contextMenu.remove(); this._contextMenu = null; }
  }
}

// Bootstrap
const page = new WorkflowPage();
document.body.appendChild(page.container);
page.onEnter();
