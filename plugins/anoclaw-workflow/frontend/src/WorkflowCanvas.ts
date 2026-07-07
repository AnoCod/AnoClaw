// WorkflowCanvas.ts - Pan/zoom, node drag, port connection controller, undo/redo, snap-to-grid

import { type WorkflowNode, type WorkflowConnection, MIN_ZOOM, MAX_ZOOM, GRID_SIZE, nextConnId } from './WorkflowNodeTypes.js';
import { getPortPosition, renderConnections, updateConnectionPaths } from './WorkflowRendering.js';

export interface CanvasState {
  offsetX: number; offsetY: number; zoom: number;
}

export interface CanvasCallbacks {
  getNodes: () => WorkflowNode[];
  getConnections: () => WorkflowConnection[];
  onNodeMoved: (nodeId: string, x: number, y: number) => void;
  onConnectionCreated: (conn: WorkflowConnection) => void;
  onConnectionDisconnect: (nodeId: string, portIndex: number, isOutput: boolean) => void;
  onConnectionSelected: (connId: string) => void;
  onNodeSelected: (nodeId: string | null) => void;
  onCanvasContextMenu: (x: number, y: number) => void;
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void;
  onUpdateView: () => void;
  onStateChange?: () => void; // Called when undo/redo stack changes
}

/** Snapshot of canvas state for undo/redo */
export interface CanvasSnapshot {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  description: string;
}

export class WorkflowCanvasController {
  private _container: HTMLElement;
  private _canvas: HTMLElement;
  private _svgLayer: SVGSVGElement;
  private _cb: CanvasCallbacks;

  state: CanvasState = { offsetX: 0, offsetY: 0, zoom: 1 };

  /** Snap-to-grid toggle */
  snapToGrid = false;

  // Drag state
  private _dragging: { type: 'canvas' } | { type: 'node'; nodeId: string; startX: number; startY: number; nodeStartX: number; nodeStartY: number } | null = null;
  private _connectDragging: { fromNodeId: string; fromPortIndex: number; fromX: number; fromY: number; tempPath: SVGPathElement; sourceNodeId: string; sourcePortIndex: number; sourceIsOutput: boolean } | null = null;
  private _selectedConnId: string | null = null;
  private _hasMoved = false;

  // Undo/Redo history
  private _undoStack: CanvasSnapshot[] = [];
  private _redoStack: CanvasSnapshot[] = [];
  private _maxHistorySize = 50;

  constructor(container: HTMLElement, canvas: HTMLElement, svgLayer: SVGSVGElement, cb: CanvasCallbacks) {
    this._container = container;
    this._canvas = canvas;
    this._svgLayer = svgLayer;
    this._cb = cb;

    // Pan on mouse drag (canvas background)
    this._container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.workflow-node') || target.closest('.workflow-conn-path') ||
          target.closest('.workflow-conn-hitarea') || target.closest('.workflow-port') ||
          target.closest('.workflow-context-menu') || target.closest('.workflow-group-container')) return;
      this._dragging = { type: 'canvas' };
      this._hasMoved = false;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      this._hasMoved = true;

      if (this._dragging.type === 'canvas') {
        this.state.offsetX += e.movementX;
        this.state.offsetY += e.movementY;
        this._cb.onUpdateView();
      } else if (this._dragging.type === 'node') {
        const dx = (e.clientX - this._dragging.startX) / this.state.zoom;
        const dy = (e.clientY - this._dragging.startY) / this.state.zoom;
        let newX = Math.round(this._dragging.nodeStartX + dx);
        let newY = Math.round(this._dragging.nodeStartY + dy);
        // Snap to grid
        if (this.snapToGrid) {
          newX = Math.round(newX / GRID_SIZE) * GRID_SIZE;
          newY = Math.round(newY / GRID_SIZE) * GRID_SIZE;
        }
        const _nd = this._dragging as { nodeId: string };
        const el = this._container.querySelector(`[data-node-id="${_nd.nodeId}"]`) as HTMLElement;
        if (el) { el.style.left = newX + 'px'; el.style.top = newY + 'px'; }
        // Sync model position during drag so mouseup-outside-iframe doesn't leave stale model
        const node = this._cb.getNodes().find(n => n.id === _nd.nodeId);
        if (node) { node.x = newX; node.y = newY; }
        // Update connections to follow dragged node
        updateConnectionPaths(this._svgLayer, this._cb.getConnections(), this._cb.getNodes(), this._container.querySelector('#wf-nodes-layer') as HTMLElement, this.state.zoom);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this._dragging) return;

      if (this._dragging.type === 'node' && this._hasMoved) {
        const _nd2 = this._dragging as { nodeId: string };
        const el = this._container.querySelector(`[data-node-id="${_nd2.nodeId}"]`) as HTMLElement | null;
        if (el) {
          const newX = parseInt(el.style.left) || 0;
          const newY = parseInt(el.style.top) || 0;
          this._cb.onNodeMoved(_nd2.nodeId, newX, newY);
        } else {
          // Element was removed during drag - persist model position if available
          const node = this._cb.getNodes().find(n => n.id === _nd2.nodeId);
          if (node) this._cb.onNodeMoved(node.id, node.x, node.y);
        }
      }

      if (!this._hasMoved && this._dragging.type === 'canvas') {
        this._cb.onNodeSelected(null);
      }

      // Clear connection drag
      if (this._connectDragging) {
        this._connectDragging.tempPath.remove();
        this._connectDragging = null;
      }

      this._dragging = null;
    });

    document.addEventListener('mouseleave', () => {
      if (this._dragging || this._connectDragging) {
        if (this._connectDragging) { this._connectDragging.tempPath.remove(); this._connectDragging = null; }
        this._dragging = null;
      }
    });

    // Zoom on wheel
    this._container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.state.zoom + delta));
      if (newZoom === this.state.zoom) return;

      // Zoom towards mouse position
      const rect = this._container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const scale = newZoom / this.state.zoom;
      this.state.offsetX = mx - (mx - this.state.offsetX) * scale;
      this.state.offsetY = my - (my - this.state.offsetY) * scale;
      this.state.zoom = newZoom;
      this._cb.onUpdateView();
    }, { passive: false });
  }

  /** Toggle snap-to-grid */
  toggleSnapToGrid(): boolean {
    this.snapToGrid = !this.snapToGrid;
    return this.snapToGrid;
  }

  // ── Undo/Redo History ──

  /** Push current state to undo stack */
  pushState(description: string): void {
    const nodes = this._cb.getNodes();
    const connections = this._cb.getConnections();
    const snapshot: CanvasSnapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      connections: JSON.parse(JSON.stringify(connections)),
      description,
    };
    this._undoStack.push(snapshot);
    if (this._undoStack.length > this._maxHistorySize) {
      this._undoStack.shift();
    }
    // Clear redo stack when new action is performed
    this._redoStack = [];
    this._cb.onStateChange?.();
  }

  /** Undo last action */
  undo(): boolean {
    if (this._undoStack.length === 0) return false;
    const snapshot = this._undoStack.pop()!;

    // Save current state to redo stack
    const currentNodes = this._cb.getNodes();
    const currentConns = this._cb.getConnections();
    this._redoStack.push({
      nodes: JSON.parse(JSON.stringify(currentNodes)),
      connections: JSON.parse(JSON.stringify(currentConns)),
      description: snapshot.description,
    });

    // Restore snapshot
    this._restoreSnapshot(snapshot);
    this._cb.onStateChange?.();
    return true;
  }

  /** Redo last undone action */
  redo(): boolean {
    if (this._redoStack.length === 0) return false;
    const snapshot = this._redoStack.pop()!;

    // Save current state to undo stack
    const currentNodes = this._cb.getNodes();
    const currentConns = this._cb.getConnections();
    this._undoStack.push({
      nodes: JSON.parse(JSON.stringify(currentNodes)),
      connections: JSON.parse(JSON.stringify(currentConns)),
      description: snapshot.description,
    });

    // Restore snapshot
    this._restoreSnapshot(snapshot);
    this._cb.onStateChange?.();
    return true;
  }

  /** Restore a snapshot by replacing the nodes and connections arrays */
  private _restoreSnapshot(snapshot: CanvasSnapshot): void {
    const nodes = this._cb.getNodes();
    const connections = this._cb.getConnections();

    // Clear existing arrays (mutate in place so references stay valid)
    nodes.length = 0;
    connections.length = 0;

    // Copy snapshot data into existing arrays
    for (const n of snapshot.nodes) nodes.push(n);
    for (const c of snapshot.connections) connections.push(c);
  }

  /** Check if undo/redo is available */
  get canUndo(): boolean { return this._undoStack.length > 0; }
  get canRedo(): boolean { return this._redoStack.length > 0; }
  get undoDescription(): string | null { return this._undoStack.length > 0 ? this._undoStack[this._undoStack.length - 1].description : null; }
  get redoDescription(): string | null { return this._redoStack.length > 0 ? this._redoStack[this._redoStack.length - 1].description : null; }

  /** Start dragging a node */
  startNodeDrag(nodeId: string, x: number, y: number, e: MouseEvent): void {
    this._dragging = { type: 'node', nodeId, startX: e.clientX, startY: e.clientY, nodeStartX: x, nodeStartY: y };
    this._hasMoved = false;
  }

  /** Start port connection drag */
  startPortConnect(nodeId: string, portIndex: number, isOutput: boolean, e: MouseEvent): void {
    const node = this._cb.getNodes().find(n => n.id === nodeId);
    if (!node) return;

    const portPos = getPortPosition(node, portIndex, !isOutput, this._container.querySelector('#wf-nodes-layer') as HTMLElement, this.state.zoom);
    if (!portPos) return;

    // Remove existing temp path
    if (this._connectDragging) {
      this._connectDragging.tempPath.remove();
    }

    const fromNodeId = isOutput ? nodeId : '';
    const fromPortIndex = isOutput ? portIndex : -1;

    // Create temp path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'workflow-temp-path');
    const startX = portPos.x;
    const startY = portPos.y;
    path.setAttribute('d', `M ${startX} ${startY} L ${startX} ${startY}`);
    this._svgLayer.appendChild(path);

    this._connectDragging = {
      fromNodeId: isOutput ? nodeId : '',
      fromPortIndex: isOutput ? portIndex : 0,
      fromX: startX,
      fromY: startY,
      tempPath: path,
      sourceNodeId: nodeId,
      sourcePortIndex: portIndex,
      sourceIsOutput: isOutput,
    };

    const onMove = (ev: MouseEvent) => {
      if (!this._connectDragging) return;
      const rect = this._container.getBoundingClientRect();
      const mx = (ev.clientX - rect.left - this.state.offsetX) / this.state.zoom;
      const my = (ev.clientY - rect.top - this.state.offsetY) / this.state.zoom;
      const cx1 = this._connectDragging.fromX + Math.abs(mx - this._connectDragging.fromX) * 0.5;
      const cx2 = mx - Math.abs(mx - this._connectDragging.fromX) * 0.5;
      this._connectDragging.tempPath.setAttribute('d',
        `M ${this._connectDragging.fromX} ${this._connectDragging.fromY} C ${cx1} ${this._connectDragging.fromY}, ${cx2} ${my}, ${mx} ${my}`);
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!this._connectDragging) return;
      this._connectDragging.tempPath.remove();

      // Find target port under mouse
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const portEl = target?.closest('[data-port]') as HTMLElement | null;
      if (portEl && this._connectDragging.fromNodeId) {
        const isTargetOutput = portEl.getAttribute('data-port') === 'out';
        if (isTargetOutput !== isOutput) {
          const targetNodeEl = portEl.closest('.workflow-node') as HTMLElement;
          const toNodeId = targetNodeEl?.getAttribute('data-node-id');
          const toPortIndex = parseInt(portEl.getAttribute('data-port-index') || '0');
          if (toNodeId && toNodeId !== this._connectDragging.fromNodeId) {
            const conn: WorkflowConnection = {
              id: nextConnId(),
              fromNodeId: isOutput ? this._connectDragging.fromNodeId : toNodeId,
              fromPortIndex: isOutput ? this._connectDragging.fromPortIndex : toPortIndex,
              toNodeId: isOutput ? toNodeId : this._connectDragging.fromNodeId,
              toPortIndex: isOutput ? toPortIndex : this._connectDragging.fromPortIndex,
            };
            this._cb.onConnectionCreated(conn);
          }
        }
      } else {
        // Dropped on empty canvas - disconnect existing connection on this port
        this._cb.onConnectionDisconnect(
          this._connectDragging.sourceNodeId,
          this._connectDragging.sourcePortIndex,
          this._connectDragging.sourceIsOutput,
        );
      }
      this._connectDragging = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  /** Set selected connection */
  setSelectedConnection(id: string | null): void {
    this._selectedConnId = id;
  }

  /** Apply view transform */
  applyView(): void {
    this._canvas.style.transform = `translate(${this.state.offsetX}px, ${this.state.offsetY}px) scale(${this.state.zoom})`;
  }

  /** Zoom to fit all nodes */
  zoomToFit(nodes: WorkflowNode[]): void {
    if (nodes.length === 0) {
      this.state.zoom = 1; this.state.offsetX = 0; this.state.offsetY = 0;
      this.applyView();
      return;
    }
    const containerRect = this._container.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + 240); maxY = Math.max(maxY, n.y + 160);
    }
    const w = maxX - minX + 80, h = maxY - minY + 80;
    const scale = Math.min(containerRect.width / w, containerRect.height / h, 1.5);
    this.state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    this.state.offsetX = (containerRect.width - w * this.state.zoom) / 2 - minX * this.state.zoom + 40 * this.state.zoom;
    this.state.offsetY = (containerRect.height - h * this.state.zoom) / 2 - minY * this.state.zoom + 40 * this.state.zoom;
    this.applyView();
  }

  /** Navigate minimap click to canvas position */
  navigateToMinimapPosition(canvasClickX: number, canvasClickY: number, canvasW: number, canvasH: number, nodes: WorkflowNode[]): void {
    if (nodes.length === 0) return;

    let minX = Math.min(...nodes.map(n => n.x));
    let minY = Math.min(...nodes.map(n => n.y));
    let maxX = Math.max(...nodes.map(n => n.x + 200));
    let maxY = Math.max(...nodes.map(n => n.y + 120));
    const bw = maxX - minX + 40;
    const bh = maxY - minY + 40;
    const scaleX = canvasW / bw;
    const scaleY = canvasH / bh;
    const scale = Math.min(scaleX, scaleY);

    // Convert minimap click to canvas coordinates
    const worldX = canvasClickX / scale + minX - 20;
    const worldY = canvasClickY / scale + minY - 20;

    // Center viewport on clicked position
    const containerRect = this._container.getBoundingClientRect();
    this.state.offsetX = containerRect.width / 2 - worldX * this.state.zoom;
    this.state.offsetY = containerRect.height / 2 - worldY * this.state.zoom;
    this.applyView();
  }
}
