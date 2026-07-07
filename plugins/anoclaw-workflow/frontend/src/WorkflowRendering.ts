// WorkflowRendering.ts - SVG connection rendering, node DOM building, minimap, flow animation

import { type WorkflowNode, type WorkflowConnection, NODE_DEFS, type NodeTypeDef } from './WorkflowNodeTypes.js';

/** Escape HTML */
export function escapeHtml(s: string): string {
  const el = document.createElement('span'); el.textContent = s; return el.innerHTML;
}

/** Status color mapping */
const STATUS_COLORS: Record<string, string> = {
  idle: 'rgba(255,255,255,0.08)',
  queued: '#6a6b6c',
  running: '#ffc533',
  success: '#59d499',
  error: '#ff6161',
};

/** Status glow mapping for node border */
const STATUS_GLOWS: Record<string, string> = {
  running: '0 0 0 2px rgba(255,197,51,0.3), 0 0 12px rgba(255,197,51,0.15)',
  success: '0 0 0 2px rgba(89,212,153,0.3), 0 0 8px rgba(89,212,153,0.1)',
  error: '0 0 0 2px rgba(255,97,97,0.3), 0 0 8px rgba(255,97,97,0.1)',
};

/** Build a node DOM element */
export function renderNode(node: WorkflowNode, isSelected: boolean, callbacks: {
  onMoveStart: (e: MouseEvent) => void;
  onDelete: () => void;
  onTitleChange: (title: string) => void;
  onParamChange: (key: string, value: string) => void;
  onPortMouseDown: (portIndex: number, isOutput: boolean, e: MouseEvent) => void;
  onGroupSelect?: (nodeIds: string[]) => void;
}, selectedNodeIds?: Set<string>): HTMLElement {
  const def = NODE_DEFS[node.type] as NodeTypeDef | undefined;
  const el = document.createElement('div');
  el.className = 'workflow-node' + (isSelected ? ' workflow-node-selected' : '');
  el.style.left = node.x + 'px';
  el.style.top = node.y + 'px';
  el.setAttribute('data-node-id', node.id);

  const headerBg = def?.color || '#7c3aed';
  const typeLabel = def?.label || node.type;
  const iconSvg = def?.icon || '';

  // Status indicator
  const statusColor = STATUS_COLORS[node.status] || STATUS_COLORS.idle;
  const statusGlow = STATUS_GLOWS[node.status] || '';
  const isRunning = node.status === 'running';

  // Multi-select class
  if (selectedNodeIds?.has(node.id)) {
    el.classList.add('workflow-node-multi-selected');
  }

  el.innerHTML = `
    <div class="workflow-node-header" style="background:${headerBg};" data-drag-handle>
      <span class="workflow-node-status-dot" style="background:${statusColor};${isRunning ? 'animation:nodeStatusPulse 1s ease-in-out infinite;' : ''}"></span>
      <span class="workflow-node-type-icon">${iconSvg}</span>
      <span class="workflow-node-type-label">${typeLabel}</span>
      <span class="workflow-node-title">${escapeHtml(node.title)}</span>
      <button class="workflow-node-delete" data-delete-btn>&times;</button>
    </div>
    <div class="workflow-node-body" data-node-body>
      ${(def?.params || []).map(p => `
        <div class="workflow-node-param">
          <label class="workflow-node-param-label">${p.label}</label>
          ${renderParamInput(p.type, p.key, p.placeholder || '', (node.data?.[p.key] || node.params?.[p.key] || ''), p.options)}
        </div>`).join('')}
    </div>
    <div class="workflow-node-footer">
      <div class="workflow-ports-group ports-in-group">
        ${(node.inputLabels || []).map((label, i) => `
          <div class="workflow-port-wrapper">
            <div class="workflow-port" data-port="in" data-port-index="${i}" title="${escapeHtml(label)}"></div>
            <span class="workflow-port-label">${escapeHtml(label)}</span>
          </div>`).join('')}
      </div>
      <div class="workflow-ports-group ports-out-group">
        ${(node.outputLabels || []).map((label, i) => `
          <div class="workflow-port-wrapper">
            <span class="workflow-port-label">${escapeHtml(label)}</span>
            <div class="workflow-port" data-port="out" data-port-index="${i}" title="${escapeHtml(label)}"></div>
          </div>`).join('')}
      </div>
    </div>`;

  if (statusGlow) {
    el.style.boxShadow = statusGlow;
  }

  // Drag start on header (skip delete button and form controls)
  const header = el.querySelector('[data-drag-handle]') as HTMLElement;
  header?.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.workflow-node-delete') ||
        (e.target as HTMLElement).closest('textarea') ||
        (e.target as HTMLElement).closest('select') ||
        (e.target as HTMLElement).closest('input')) return;
    e.stopPropagation(); // Prevent nodesLayer handler from double-firing startNodeDrag
    callbacks.onMoveStart(e);
  });

  // Delete button
  el.querySelector('[data-delete-btn]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onDelete();
  });

  // Param changes
  el.querySelectorAll('.workflow-node-textarea, .workflow-node-select, .workflow-node-input').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.getAttribute('data-param-key')!;
      callbacks.onParamChange(key, (input as HTMLInputElement).value);
    });
  });

  // Port mouse down for connections
  el.querySelectorAll('[data-port]').forEach(port => {
    port.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const isOutput = port.getAttribute('data-port') === 'out';
      const portIndex = parseInt(port.getAttribute('data-port-index') || '0');
      callbacks.onPortMouseDown(portIndex, isOutput, e as MouseEvent);
    });
  });

  return el;
}

function renderParamInput(type: string, key: string, placeholder: string, value: string, options?: Array<{ value: string; label: string }>): string {
  const v = escapeHtml(value || '');
  const ph = escapeHtml(placeholder);
  if (type === 'textarea') {
    return `<textarea class="workflow-node-textarea" data-param-key="${key}" placeholder="${ph}" rows="3">${v}</textarea>`;
  }
  if (type === 'select' && options) {
    return `<select class="workflow-node-select" data-param-key="${key}">${options.map(o => `<option value="${o.value}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
  }
  return `<input class="workflow-node-input" type="${type === 'number' ? 'number' : 'text'}" data-param-key="${key}" placeholder="${ph}" value="${v}">`;
}

/** Render SVG connections layer with flow animation support */
export function renderConnections(svg: SVGSVGElement, connections: WorkflowConnection[], nodes: WorkflowNode[], selectedId: string | null, onSelect: (id: string) => void, executionState?: any, nodesLayer?: HTMLElement, zoom?: number): void {
  svg.innerHTML = '';
  // Defs for flow animation gradient
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="flow-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffc533" stop-opacity="0"/>
      <stop offset="50%" stop-color="#ffc533" stop-opacity="1"/>
      <stop offset="100%" stop-color="#ffc533" stop-opacity="0"/>
    </linearGradient>
  `;
  svg.appendChild(defs);

  // Determine active connections from execution state
  const activeConnKeys = new Set<string>();
  if (executionState?.status === 'running' && executionState?.currentNodeId) {
    for (const conn of connections) {
      if (conn.fromNodeId === executionState.currentNodeId || conn.toNodeId === executionState.currentNodeId) {
        activeConnKeys.add(`${conn.fromNodeId}->${conn.toNodeId}`);
      }
    }
  }

  for (const conn of connections) {
    const fromNode = nodes.find(n => n.id === conn.fromNodeId);
    const toNode = nodes.find(n => n.id === conn.toNodeId);
    if (!fromNode || !toNode) continue;

    const fromPort = getPortPosition(fromNode, conn.fromPortIndex, false, nodesLayer, zoom);
    const toPort = getPortPosition(toNode, conn.toPortIndex, true, nodesLayer, zoom);
    if (!fromPort || !toPort) continue;

    const isSelected = conn.id === selectedId;
    const connKey = `${conn.fromNodeId}->${conn.toNodeId}`;
    const isActive = activeConnKeys.has(connKey);

    const d = bezierPath(fromPort.x, fromPort.y, toPort.x, toPort.y);

    // Hit area (wider, transparent)
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'workflow-conn-hitarea');
    hit.addEventListener('click', () => onSelect(conn.id));
    svg.appendChild(hit);

    // Visible path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'workflow-conn-path' + (isSelected ? ' workflow-conn-selected' : '') + (isActive ? ' workflow-conn-active' : ''));
    path.addEventListener('click', () => onSelect(conn.id));
    svg.appendChild(path);

    // Flow animation overlay for active connections
    if (isActive) {
      const flowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      flowPath.setAttribute('d', d);
      flowPath.setAttribute('class', 'workflow-conn-flow');
      flowPath.setAttribute('stroke', 'url(#flow-gradient)');
      flowPath.setAttribute('fill', 'none');
      flowPath.setAttribute('stroke-width', '3');
      svg.appendChild(flowPath);
    }
  }
}

/** Lightweight update of connection path geometry - only touches d attributes, no DOM rebuild */
export function updateConnectionPaths(svg: SVGSVGElement, connections: WorkflowConnection[], nodes: WorkflowNode[], nodesLayer?: HTMLElement, zoom?: number): void {
  const hitAreas = svg.querySelectorAll('.workflow-conn-hitarea');
  const paths = svg.querySelectorAll('.workflow-conn-path');
  let i = 0;
  for (const conn of connections) {
    const fromNode = nodes.find(n => n.id === conn.fromNodeId);
    const toNode = nodes.find(n => n.id === conn.toNodeId);
    if (!fromNode || !toNode) continue;
    const fromPort = getPortPosition(fromNode, conn.fromPortIndex, false, nodesLayer, zoom);
    const toPort = getPortPosition(toNode, conn.toPortIndex, true, nodesLayer, zoom);
    if (!fromPort || !toPort) continue;
    const d = bezierPath(fromPort.x, fromPort.y, toPort.x, toPort.y);
    if (hitAreas[i]) hitAreas[i].setAttribute('d', d);
    if (paths[i]) paths[i].setAttribute('d', d);
    i++;
  }
}

export function getPortPosition(node: WorkflowNode, portIndex: number, isInput: boolean, nodesLayer?: HTMLElement, zoom?: number): { x: number; y: number } | null {
  // Measure actual DOM position when available
  if (nodesLayer && zoom !== undefined) {
    const nodeEl = nodesLayer.querySelector(`[data-node-id="${node.id}"]`) as HTMLElement | null;
    if (nodeEl) {
      const portEl = nodeEl.querySelector(`[data-port="${isInput ? 'in' : 'out'}"][data-port-index="${portIndex}"]`) as HTMLElement | null;
      if (portEl) {
        const nodeRect = nodeEl.getBoundingClientRect();
        const portRect = portEl.getBoundingClientRect();
        const localX = isInput
          ? (portRect.left - nodeRect.left) / zoom
          : (portRect.right - nodeRect.left) / zoom;
        const localY = (portRect.top + portRect.height / 2 - nodeRect.top) / zoom;
        return { x: node.x + localX, y: node.y + localY };
      }
    }
  }
  // Fallback
  const nodeW = 200;
  const headerH = 36;
  const bodyH = (NODE_DEFS[node.type]?.params.length || 0) * 60 + 20;
  const footerH = 28;
  const totalH = headerH + bodyH + footerH;
  const portSpacing = 20;
  const portH = headerH + bodyH + 6 + portIndex * portSpacing;

  return {
    x: node.x + (isInput ? 0 : nodeW),
    y: node.y + Math.min(portH, totalH - 12),
  };
}

/** Cubic bezier path string */
export function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1) * 0.5;
  const cx1 = x1 + dx;
  const cx2 = x2 - dx;
  return `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
}

/** Render minimap with interactive click-to-navigate */
export function renderMinimap(
  canvas: HTMLCanvasElement,
  nodes: WorkflowNode[],
  conns: WorkflowConnection[],
  viewportW: number, viewportH: number,
  offsetX: number, offsetY: number,
  zoom: number,
  groups?: Array<{ id: string; title: string; nodeIds: string[]; collapsed: boolean }>,
  onClick?: (canvasX: number, canvasY: number, canvasW: number, canvasH: number) => void
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Resolve CSS variables for Canvas2D (var() doesn't work in canvas)
  const style = getComputedStyle(document.documentElement);
  const cssVar = (name: string, fallback: string) => style.getPropertyValue(name)?.trim() || fallback;
  const bgColor = cssVar('--color-bg', '#07080a');

  // Raycast dark surface
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, w, h);

  // Find bounds
  let minX = 0, minY = 0, maxX = 2000, maxY = 1500;
  if (nodes.length > 0) {
    minX = Math.min(...nodes.map(n => n.x)); minY = Math.min(...nodes.map(n => n.y));
    maxX = Math.max(...nodes.map(n => n.x + 200)); maxY = Math.max(...nodes.map(n => n.y + 120));
  }
  const bw = maxX - minX + 40, bh = maxY - minY + 40;
  const scaleX = w / bw, scaleY = h / bh;
  const scale = Math.min(scaleX, scaleY);

  // Groups (background rectangles)
  if (groups && groups.length > 0) {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#57c1ff';
    for (const g of groups) {
      const groupNodes = nodes.filter(n => g.nodeIds.includes(n.id));
      if (groupNodes.length === 0) continue;
      const gx = Math.min(...groupNodes.map(n => n.x));
      const gy = Math.min(...groupNodes.map(n => n.y));
      const gw = Math.max(...groupNodes.map(n => n.x + 200)) - gx + 20;
      const gh = Math.max(...groupNodes.map(n => n.y + 120)) - gy + 20;
      ctx.fillRect((gx - minX + 10) * scale, (gy - minY + 10) * scale, gw * scale, gh * scale);
    }
    ctx.globalAlpha = 1;
  }

  // Connections
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  for (const c of conns) {
    const fn = nodes.find(n => n.id === c.fromNodeId);
    const tn = nodes.find(n => n.id === c.toNodeId);
    if (!fn || !tn) continue;
    ctx.beginPath();
    ctx.moveTo((fn.x - minX + 120) * scale, (fn.y - minY + 60) * scale);
    ctx.lineTo((tn.x - minX + 120) * scale, (tn.y - minY + 60) * scale);
    ctx.stroke();
  }

  // Nodes with status colors
  for (const n of nodes) {
    const def = NODE_DEFS[n.type];
    const statusCol = n.status === 'running' ? 'rgba(255,197,51,0.7)' :
                      n.status === 'success' ? 'rgba(89,212,153,0.7)' :
                      n.status === 'error' ? 'rgba(255,97,97,0.7)' :
                      def?.color ? def.color + '88' : 'rgba(255,255,255,0.3)';
    ctx.fillStyle = statusCol;
    ctx.fillRect((n.x - minX + 20) * scale, (n.y - minY + 20) * scale, 200 * scale, 100 * scale);
  }

  // Viewport
  const vx = (-offsetX / zoom - minX + 20) * scale;
  const vy = (-offsetY / zoom - minY + 20) * scale;
  const vw = viewportW / zoom * scale;
  const vh = viewportH / zoom * scale;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(vx, vy, vw, vh);

  // Wire up click handler (only once)
  if (onClick && !canvas.dataset.clickWired) {
    canvas.dataset.clickWired = '1';
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      onClick(cx, cy, w, h);
    });
  }
}
