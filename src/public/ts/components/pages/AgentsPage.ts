/**
 * AnoClaw Agents Page — d3-force simulation + SVG rendering (v5)
 *
 * Logseq-style graph: small colored circles, thin edges, text labels.
 * Powered by d3-force (forceCollide prevents overlap, tick events for smooth animation).
 * Click node → select. Double-click → floating edit panel. Drag nodes, zoom/pan.
 */
import { App } from '../../app.js';
import type { Page, AgentConfig } from '../../types.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { ToastManager } from '../../ToastManager.js';
import { ClientLogger } from '../../ClientLogger.js';
import { TalentPoolPanel } from './talent-pool/TalentPoolPanel.js';
import { showHireDialog } from './talent-pool/HireDialog.js';
import { showSaveToPoolDialog } from './talent-pool/SaveToPoolDialog.js';

declare const d3: any;

const STORAGE_KEY = 'anoclaw-agents-positions-v4';

const ROLE_STYLES: Record<string, { r: number; fill: string; stroke: string }> = {
  MainAgent: { r: 22, fill: '#c94b3a', stroke: '#e05545' },
  Manager:   { r: 16, fill: '#8b5cf6', stroke: '#a378f9' },
  Member:    { r: 12, fill: '#4b89ff', stroke: '#6ba3ff' },
};
const DEFAULT_STYLE = ROLE_STYLES['Member'];
const GHOST_R = 8;

interface SimNode { id: string; x: number; y: number; r: number; agent?: AgentConfig; isGhost?: boolean; parentId?: string; addRole?: string; }
interface SimLink { source: string | SimNode; target: string | SimNode; cls?: string; }

export class AgentsPage implements Page {
  name = 'agents';
  container: HTMLElement;

  private _active = false;
  private _sim: any = null;
  private _nodes: SimNode[] = [];
  private _links: SimLink[] = [];

  // SVG
  private _svg: SVGSVGElement | null = null;
  private _edgeGroup: SVGGElement | null = null;
  private _nodeGroup: SVGGElement | null = null;

  // Interaction
  private _selectedId = '';
  private _zm = 1; private _px = 0; private _py = 0;
  // Pan state
  private _panning = false;
  private _panStartX = 0; private _panStartY = 0;
  private _panStartPX = 0; private _panStartPY = 0;
  private _panCleanup: (() => void) | null = null;

  // Floating edit panel
  private _editPanel: HTMLElement | null = null;
  private _editingAgent: AgentConfig | null = null;

  // Context menu
  private _ctxMenu: HTMLElement | null = null;
  private _zoomLabel: HTMLElement | null = null;
  private _resizeObs: ResizeObserver | null = null;

  // Talent pool
  private _talentPool: TalentPoolPanel | null = null;
  private _talentBtn: HTMLElement | null = null;

  // Guard: prevent double reload when save triggers agentsChanged
  private _reloading = false;

  // Pending create defaults (from ghost button click)
  private _createDefaults: { parentAgentId: string; role: string } | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'ag-page';
    this.container.style.cssText = 'position:relative;flex:1;overflow:hidden;background:#0d0d11;';
    this.container.setAttribute('data-page', 'agents');
    this._initTalentPool();
  }

  private _initTalentPool(): void {
    this._talentPool = new TalentPoolPanel(this.container);
    this._talentPool.on('hire', async (tpl: any) => {
      const agents = App.getInstance().agentVM.agents;
      const result = await showHireDialog(tpl, agents);
      if (!result) return;

      try {
        const resp = await fetch(`/api/v1/talent-pool/templates/${result.templateId}/hire`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parentAgentId: result.parentAgentId,
            role: result.role,
            name: result.name,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          ToastManager.getInstance().error(data.error || 'Hire failed');
          return;
        }
        ToastManager.getInstance().success(`${result.name} has joined the team!`);
        App.getInstance().agentVM.loadAgents().then(() => this._load());
      } catch (err) {
        ToastManager.getInstance().error('Hire failed: network error');
        ClientLogger.ui.error('hireTemplate', { error: String(err) });
      }
    });
  }

  // ═══ Lifecycle ═══════════════════════════════════════════

  onEnter(): void {
    this._active = true;
    const pa = document.getElementById('page-area');
    if (pa) pa.style.overflow = 'visible';
    this.container.addEventListener('wheel', this._onWheel, { passive: false });
    this._load();
    App.getInstance().agentVM.on('agentsChanged', this._onAgentsChanged);
  }

  onExit(): void {
    this._active = false;
    App.getInstance().agentVM.off('agentsChanged', this._onAgentsChanged);
    this.container.removeEventListener('wheel', this._onWheel);
    this._savePositions();
    if (this._sim) { this._sim.stop(); this._sim = null; }
    if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; }
    if (this._panCleanup) { this._panCleanup(); this._panCleanup = null; }
    const pa = document.getElementById('page-area');
    if (pa) pa.style.overflow = '';
    this._closeEditPanel();
    this._closeCtxMenu();
    this._talentPool?.close();
    if (this._talentBtn) this._talentBtn.classList.remove('active');
  }

  private _onAgentsChanged = (): void => {
    if (!this._active) return;
    if (this._reloading) return;
    this._savePositions();
    this._load();
  };

  // ═══ Load ════════════════════════════════════════════════

  private async _load(): Promise<void> {
    if (this._sim) { this._sim.stop(); this._sim = null; }
    // Clean up pan listeners from previous SVG
    if (this._panCleanup) { this._panCleanup(); this._panCleanup = null; }
    this.container.innerHTML = '';
    this._closeEditPanel();

    const agents = App.getInstance().agentVM.agents;
    if (!agents || agents.length === 0) {
      this.container.innerHTML = `<div class="ag-empty"><span>No agents configured</span><button class="ag-empty-btn" id="ag-create-first">Create Agent</button></div>`;
      this.container.querySelector('#ag-create-first')!.addEventListener('click', () => this._openEditPanel(null));
      return;
    }

    const stored = this._loadPositions();
    const cw = this.container.clientWidth || 800, ch = this.container.clientHeight || 600;

    // --- Layered tree layout ---
    // CEO at top center, Managers in middle row, Members below their manager
    const nodes: SimNode[] = [];
    const links: SimLink[] = [];

    const managers = agents.filter(a => a.role === 'Manager');
    const members = agents.filter(a => a.role === 'Member');
    const ceo = agents.find(a => a.role === 'MainAgent');
    const managerCols = managers.length || 1;

    // Initial Y layers for clean starting positions; simulation settles them naturally
    const ceoY = ch * 0.18;
    const mgrY = ch * 0.45;
    const mbrY = ch * 0.72;

    const mgrSpacing = Math.min(180, cw / Math.max(managerCols + 1, 2));
    const mgrStartX = (cw - mgrSpacing * (managers.length - 1)) / 2;

    // Build managers and their members into columns
    const mgrXMap = new Map<string, number>();

    for (let i = 0; i < managers.length; i++) {
      const m = managers[i];
      const mx = mgrStartX + i * mgrSpacing;
      mgrXMap.set(m.id, mx);

      const saved = stored.get(m.id);
      nodes.push({
        id: m.id, agent: m,
        x: saved?.x ?? mx,
        y: saved?.y ?? mgrY + (Math.random() - 0.5) * 20,
        r: ROLE_STYLES.Manager.r,
      });

      // Link to CEO
      if (ceo) {
        links.push({ source: ceo.id, target: m.id, cls: 'ceo-edge' });
      }
    }

    // CEO
    if (ceo) {
      const saved = stored.get(ceo.id);
      nodes.push({
        id: ceo.id, agent: ceo,
        x: saved?.x ?? cw / 2 + (Math.random() - 0.5) * 20,
        y: saved?.y ?? ceoY,
        r: ROLE_STYLES.MainAgent.r,
      });
    }

    // Members under their manager
    for (const m of members) {
      const parentMgr = managers.find(mgr => mgr.id === m.parentAgentId);
      const baseX = parentMgr && mgrXMap.has(parentMgr.id) ? mgrXMap.get(parentMgr.id)! : cw / 2;

      const saved = stored.get(m.id);
      nodes.push({
        id: m.id, agent: m,
        x: saved?.x ?? baseX + (Math.random() - 0.5) * 60,
        y: saved?.y ?? mbrY + (Math.random() - 0.5) * 20,
        r: ROLE_STYLES.Member.r,
      });

      if (m.parentAgentId) {
        const cls = managers.some(mgr => mgr.id === m.parentAgentId) ? 'mgr-edge' : '';
        links.push({ source: m.parentAgentId, target: m.id, cls });
      }
    }

    // Ghost add nodes — always show under CEO and each Manager
    if (ceo) {
      nodes.push({ id: `add-mgr-${ceo.id}`, x: cw / 2 + 80, y: ceoY + 50, r: GHOST_R, isGhost: true, parentId: ceo.id, addRole: 'Manager' });
      links.push({ source: ceo.id, target: `add-mgr-${ceo.id}`, cls: 'mgr-edge' });
    }
    for (const m of managers) {
      const mx = mgrXMap.get(m.id) || cw / 2;
      nodes.push({ id: `add-mbr-${m.id}`, x: mx + 50, y: mgrY + 50, r: GHOST_R, isGhost: true, parentId: m.id, addRole: 'Member' });
      links.push({ source: m.id, target: `add-mbr-${m.id}`, cls: 'mgr-edge' });
    }

    this._nodes = nodes;
    this._links = links;

    this._buildSVG();
    this._startSim(cw, ch);
  }

  private _startSim(w: number, h: number): void {
    if (typeof d3 === 'undefined') {
      this._renderAll();
      return;
    }

    // Layer Y targets: CEO near top, managers middle, members bottom
    const ceoY = h * 0.18;
    const mgrY = h * 0.45;
    const mbrY = h * 0.72;

    // X grouping: push nodes toward their parent's x (via team clustering)
    // Group managers by index for x-spread
    const mgrIds = this._nodes.filter(n => n.agent?.role === 'Manager').map(n => n.id);
    const mgrGroup = new Map<string, number>();
    mgrIds.forEach((id, i) => mgrGroup.set(id, i));

    this._sim = d3.forceSimulation(this._nodes as any)
      .force('link', d3.forceLink(this._links).id((d: any) => d.id).distance((l: any) => {
        if (l.cls === 'ceo-edge') return 140;
        if (l.cls === 'mgr-edge') return 110;
        return 100;
      }).strength(0.3))
      .force('charge', d3.forceManyBody().strength(-200).distanceMax(400))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collide', d3.forceCollide().radius((d: any) => d.r + 20).strength(0.5))
      .alphaDecay(0.02)
      .velocityDecay(0.3)
      .on('tick', () => {
        for (const n of this._nodes) {
          const m = 40;
          if (n.x < -w) n.x = -w;
          if (n.x > w * 2) n.x = w * 2;
          if (n.y < m) n.y = m;
          if (n.y > h + 100) n.y = h + 100;
        }
        this._updatePositions();
      });

    this._renderAll();
  }

  // ═══ SVG construction ════════════════════════════════════

  private _buildSVG(): void {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'ag-svg');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;';

    // SVG background rect for pan capture (covers entire viewport)
    const bgRect = document.createElementNS(svgNS, 'rect');
    bgRect.setAttribute('width', '100%');
    bgRect.setAttribute('height', '100%');
    bgRect.setAttribute('fill', 'transparent');
    svg.appendChild(bgRect);

    // Pan: mousedown on empty background
    bgRect.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return;
      this._panning = true;
      this._panStartX = e.clientX;
      this._panStartY = e.clientY;
      this._panStartPX = this._px;
      this._panStartPY = this._py;
      svg.style.cursor = 'grabbing';
    });

    // Window-level pan move/end
    const onPanMove = (e: MouseEvent) => {
      if (!this._panning) return;
      this._px = this._panStartPX + (e.clientX - this._panStartX);
      this._py = this._panStartPY + (e.clientY - this._panStartY);
      this._applyView();
    };
    const onPanEnd = () => {
      if (!this._panning) return;
      this._panning = false;
      svg.style.cursor = 'grab';
    };
    window.addEventListener('mousemove', onPanMove);
    window.addEventListener('mouseup', onPanEnd);
    // Store cleanup refs for page lifecycle
    this._panCleanup = () => {
      window.removeEventListener('mousemove', onPanMove);
      window.removeEventListener('mouseup', onPanEnd);
    };
    (svg as any)._panCleanup = this._panCleanup;

    // Defs — glow filters
    const defs = document.createElementNS(svgNS, 'defs');
    for (const [role, st] of Object.entries(ROLE_STYLES)) {
      const filter = document.createElementNS(svgNS, 'filter');
      filter.setAttribute('id', `glow-${role}`);
      filter.innerHTML = `<feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>`;
      defs.appendChild(filter);
    }
    svg.appendChild(defs);

    // Edge group
    this._edgeGroup = document.createElementNS(svgNS, 'g');
    this._edgeGroup.setAttribute('class', 'ag-edges');
    svg.appendChild(this._edgeGroup);

    // Node group
    this._nodeGroup = document.createElementNS(svgNS, 'g');
    this._nodeGroup.setAttribute('class', 'ag-nodes');
    svg.appendChild(this._nodeGroup);

    // Click on background → deselect
    svg.addEventListener('click', (e) => {
      if (e.target === svg) { this._selectNode(''); this._closeEditPanel(); }
    });

    this.container.appendChild(svg);

    // Zoom controls
    const zc = document.createElement('div');
    zc.className = 'ag-zoom-controls';
    zc.innerHTML = `<button id="zoom-out" class="ag-zoom-btn ico">&#8722;</button><button id="zoom-reset" class="ag-zoom-btn reset">100%</button><button id="zoom-in" class="ag-zoom-btn ico">+</button>`;
    this.container.appendChild(zc);
    this._zoomLabel = zc.querySelector('#zoom-reset')!;
    zc.querySelector('#zoom-in')!.addEventListener('click', () => this._adjustZoom(1.2));
    zc.querySelector('#zoom-out')!.addEventListener('click', () => this._adjustZoom(0.8));
    zc.querySelector('#zoom-reset')!.addEventListener('click', () => this._resetView());

    // Talent pool button
    const tb = document.createElement('button');
    tb.className = 'ag-talent-btn';
    tb.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--color-info);"></span> Talent Pool';
    tb.addEventListener('click', () => {
      tb.classList.toggle('active');
      this._talentPool?.toggle();
    });
    this.container.appendChild(tb);
    this._talentBtn = tb;

    this._svg = svg;

    // ResizeObserver — restart sim when container size changes
    this._resizeObs = new ResizeObserver(() => {
      if (!this._sim || !this._active) return;
      const w = this.container.clientWidth, h = this.container.clientHeight;
      this._sim.force('center', d3.forceCenter(w / 2, h / 2));
      this._sim.alpha(0.3).restart();
    });
    this._resizeObs.observe(this.container);

    // Global listeners — wheel on container (not SVG) for reliable cross-browser support
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ═══ Render ═══════════════════════════════════════════════

  private _renderAll(): void {
    if (!this._edgeGroup || !this._nodeGroup) return;
    const svgNS = 'http://www.w3.org/2000/svg';

    // Build node groups once — drag handlers wired here
    this._nodeGroup.innerHTML = '';
    this._edgeGroup.innerHTML = '';

    for (const n of this._nodes) {
      const g = document.createElementNS(svgNS, 'g');
      g.setAttribute('class', 'ag-node-g');
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      g.dataset.nodeId = n.id;

      if (n.isGhost) {
        // Invisible larger hit area for easy clicking
        const hitArea = document.createElementNS(svgNS, 'circle');
        hitArea.setAttribute('r', '18');
        hitArea.setAttribute('fill', 'transparent');
        hitArea.style.cursor = 'pointer';
        g.appendChild(hitArea);

        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('r', String(GHOST_R));
        circle.setAttribute('class', 'ag-node ag-node-ghost');
        circle.style.pointerEvents = 'none';
        g.appendChild(circle);
        const plus = document.createElementNS(svgNS, 'text');
        plus.setAttribute('class', 'ag-node-plus'); plus.setAttribute('text-anchor', 'middle');
        plus.setAttribute('dy', '5'); plus.textContent = '+';
        plus.style.pointerEvents = 'none';
        g.appendChild(plus);
        const lbl = document.createElementNS(svgNS, 'text');
        lbl.setAttribute('class', 'ag-node-label'); lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('dy', String(GHOST_R + 14)); lbl.textContent = n.addRole || '';
        lbl.style.pointerEvents = 'none';
        g.appendChild(lbl);
        // Click ghost → open edit panel to create
        g.style.cursor = 'pointer';
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          const parent = App.getInstance().agentVM.agents.find(a => a.id === n.parentId);
          if (parent) {
            // Build a partial agent config with role and parent pre-set
            const partial: any = {
              role: n.addRole || 'Member',
              parentAgentId: n.parentId,
              name: `New ${n.addRole || 'Member'}`,
              model: parent.model || '',
            };
            this._createDefaults = { parentAgentId: n.parentId!, role: n.addRole || 'Member' };
            this._openEditPanel(partial);
          }
        });
      } else {
        const style = n.agent ? (ROLE_STYLES[n.agent.role] || DEFAULT_STYLE) : DEFAULT_STYLE;
        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('r', String(style.r));
        circle.setAttribute('class', `ag-node ag-node-${n.agent?.role || 'Member'}`);
        circle.setAttribute('fill', style.fill);
        circle.setAttribute('stroke', style.stroke);
        circle.setAttribute('filter', `url(#glow-${n.agent?.role || 'Member'})`);
        if (n.id === this._selectedId) circle.classList.add('selected');
        g.appendChild(circle);
        const lbl = document.createElementNS(svgNS, 'text');
        lbl.setAttribute('class', 'ag-node-label'); lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('dy', String(style.r + 15));
        const name = n.agent?.name || '';
        lbl.textContent = name.length > 16 ? name.slice(0, 15) + '...' : name;
        lbl.style.pointerEvents = 'none';
        g.appendChild(lbl);

        // Click → open edit panel
        g.style.cursor = 'pointer';
        g.addEventListener('click', (e) => { e.stopPropagation(); this._selectNode(n.id); if (n.agent) this._openEditPanel(n.agent); });
        // Right-click → context menu
        g.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this._selectNode(n.id); this._showContextMenu(e.clientX, e.clientY, n.agent || null); });
      }

      // Drag
      this._wireNodeDrag(g, n);

      this._nodeGroup!.appendChild(g);
    }

    this._applyView();
  }

  /** Update positions only (called on d3-force tick) */
  private _updatePositions(): void {
    if (!this._edgeGroup || !this._nodeGroup) return;
    const svgNS = 'http://www.w3.org/2000/svg';

    // Rebuild edges
    this._edgeGroup.innerHTML = '';
    for (const l of this._links) {
      const s = typeof l.source === 'object' ? l.source : this._nodes.find(n => n.id === l.source);
      const t = typeof l.target === 'object' ? l.target : this._nodes.find(n => n.id === l.target);
      if (!s || !t) continue;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(s.x)); line.setAttribute('y1', String(s.y));
      line.setAttribute('x2', String(t.x)); line.setAttribute('y2', String(t.y));
      line.setAttribute('class', `ag-edge ${l.cls || ''}`);
      this._edgeGroup.appendChild(line);
    }

    // Update node positions
    const groups = this._nodeGroup.children;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] as SVGGElement;
      const n = this._nodes[i];
      if (!n) continue;
      g.setAttribute('transform', `translate(${n.x},${n.y})`);
      // Update selection state
      if (!n.isGhost) {
        const circle = g.querySelector('circle');
        if (circle) circle.classList.toggle('selected', n.id === this._selectedId);
      }
    }
    this._applyView();
  }

  private _applyView(): void {
    if (!this._nodeGroup || !this._edgeGroup) return;
    const t = `translate(${this._px},${this._py}) scale(${this._zm})`;
    this._edgeGroup.setAttribute('transform', t);
    this._nodeGroup.setAttribute('transform', t);
  }

  // ═══ Node Drag ═══════════════════════════════════════════

  private _wireNodeDrag(g: SVGGElement, node: SimNode): void {
    let dragging = false;
    let sx = 0, sy = 0, ox = 0, oy = 0;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = node.x; oy = node.y;
      if (this._sim) {
        this._sim.alphaTarget(0.3).restart();
      }
      g.setAttribute('data-dragging', 'true');
      if (this._svg) this._svg.style.cursor = 'grabbing';
    };

    g.addEventListener('mousedown', onDown);

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = (e.clientX - sx) / this._zm;
      const dy = (e.clientY - sy) / this._zm;
      node.x = ox + dx;
      node.y = oy + dy;
      // Pin node during drag
      if (node.agent) {
        (node as any).fx = node.x;
        (node as any).fy = node.y;
      }
      this._updatePositions();
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      g.removeAttribute('data-dragging');
      if (this._svg) this._svg.style.cursor = 'grab';
      // Release pin
      if (node.agent) {
        (node as any).fx = null;
        (node as any).fy = null;
      }
      if (this._sim) this._sim.alphaTarget(0);
      this._savePositions();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    (g as any)._dragCleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }

  // ═══ Zoom / Pan ══════════════════════════════════════════

  private _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Zoom toward cursor position
    const rect = this.container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const oldZm = this._zm;
    const newZm = Math.min(2.5, Math.max(0.15, this._zm * (e.deltaY > 0 ? 0.9 : 1.1)));
    // Adjust pan so the point under the cursor stays fixed
    this._px = mx - (mx - this._px) * (newZm / oldZm);
    this._py = my - (my - this._py) * (newZm / oldZm);
    this._zm = newZm;
    this._applyView();
    if (this._zoomLabel) this._zoomLabel.textContent = Math.round(this._zm * 100) + '%';
  };

  private _adjustZoom(d: number): void {
    this._zm = Math.min(2.5, Math.max(0.15, this._zm * d));
    this._applyView();
    if (this._zoomLabel) this._zoomLabel.textContent = Math.round(this._zm * 100) + '%';
  }

  private _resetView(): void {
    this._zm = 1; this._px = 0; this._py = 0;
    this._applyView();
    if (this._zoomLabel) this._zoomLabel.textContent = '100%';
  }

  // ═══ Selection ═══════════════════════════════════════════

  private _selectNode(id: string): void {
    this._selectedId = id;
    this._updatePositions();
  }

  // ═══ Edit panel ══════════════════════════════════════════

  private _toolMetaCache: Promise<{ tools: Array<{ name: string; group: string; displayName: string; description: string }>; groups: string[] }> | null = null;

  private _fetchToolMeta(): Promise<{ tools: Array<{ name: string; group: string; displayName: string; description: string }>; groups: string[] }> {
    if (this._toolMetaCache) return this._toolMetaCache;
    this._toolMetaCache = fetch('/api/v1/tools').then(r => r.json()).then(d => ({
      tools: d.tools || [],
      groups: d.groups || [],
    })).catch(() => { this._toolMetaCache = null; return { tools: [], groups: [] }; });
    return this._toolMetaCache;
  }

  private async _openEditPanel(agent: AgentConfig | null): Promise<void> {
    this._closeEditPanel();
    this._editingAgent = agent;
    // If called without a parent context, clear create defaults
    if (!agent) this._createDefaults = null;

    const panel = document.createElement('div');
    panel.className = 'ag-edit-panel';
    panel.style.top = '60px'; panel.style.right = '20px';
    panel.innerHTML = '<div class="ag-edit-body" style="text-align:center;padding:40px;">Loading tools...</div>';
    this.container.appendChild(panel);
    this._editPanel = panel;

    // Fetch tools async, then build form
    const meta = await this._fetchToolMeta();
    if (this._editPanel !== panel) return; // closed already
    if (!agent) this._editingAgent = null; // may have changed

    const isNew = !agent;
    const title = isNew ? 'Create Agent' : `Edit: ${agent!.name}`;
    const nameVal = agent?.name || '';
    const roleVal = agent?.role || 'Member';
    const modelVal = agent?.model || '';
    const promptVal = agent?.agentPrompt || '';
    const allowedSet = new Set(agent?.allowedTools || []);

    // Group tools
    const byGroup = new Map<string, typeof meta.tools>();
    for (const t of meta.tools) {
      const g = t.group || 'Other';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(t);
    }
    const groupOrder = meta.groups.length > 0 ? meta.groups : [...byGroup.keys()];

    // Build checkboxes HTML
    let toolsHtml = '';
    for (const g of groupOrder) {
      const items = byGroup.get(g);
      if (!items || items.length === 0) continue;
      toolsHtml += `<fieldset class="ag-tool-group"><legend>${this._esc(g)}</legend>`;
      for (const t of items) {
        const checked = allowedSet.has(t.name) ? ' checked' : '';
        toolsHtml += `<label class="ag-tool-item"><input type="checkbox" value="${this._esc(t.name)}"${checked}> <span class="ag-tool-name">${this._esc(t.displayName || t.name)}</span><span class="ag-tool-desc">${this._esc(t.description).slice(0, 60)}</span></label>`;
      }
      toolsHtml += '</fieldset>';
    }

    panel.innerHTML = `
      <div class="ag-edit-header">
        <h3>${title}</h3>
        <button class="ag-edit-close">&times;</button>
      </div>
      <div class="ag-edit-body">
        <label>Name</label>
        <input type="text" id="ag-edit-name" value="${this._esc(nameVal)}" placeholder="Agent name">
        <label>Role</label>
        <select id="ag-edit-role">
          <option value="MainAgent" ${roleVal === 'MainAgent' ? 'selected' : ''}>CEO</option>
          <option value="Manager" ${roleVal === 'Manager' ? 'selected' : ''}>Manager</option>
          <option value="Member" ${roleVal === 'Member' ? 'selected' : ''}>Member</option>
        </select>
        <label>Model</label>
        <input type="text" id="ag-edit-model" value="${this._esc(modelVal)}" placeholder="e.g. claude-sonnet-4-6">
        <label>System Prompt</label>
        <textarea id="ag-edit-prompt" rows="4" placeholder="Agent system prompt">${this._esc(promptVal)}</textarea>
        <label>Allowed Tools</label>
        <div class="ag-tool-groups">${toolsHtml}</div>
      </div>
      <div class="ag-edit-footer">
        ${!isNew ? '<button class="ag-edit-btn-delete">Delete</button>' : ''}
        <button class="ag-edit-btn-cancel">Cancel</button>
        <button class="ag-edit-btn-save">Save</button>
      </div>
    `;

    panel.querySelector('.ag-edit-close')!.addEventListener('click', () => this._closeEditPanel());
    panel.querySelector('.ag-edit-btn-cancel')!.addEventListener('click', () => this._closeEditPanel());
    panel.querySelector('.ag-edit-btn-save')!.addEventListener('click', () => this._saveEdit());
    if (!isNew) {
      panel.querySelector('.ag-edit-btn-delete')!.addEventListener('click', () => this._deleteEdit());
    }
    const onEsc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { this._closeEditPanel(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
  }

  private _closeEditPanel(): void {
    if (this._editPanel) { this._editPanel.remove(); this._editPanel = null; }
    this._editingAgent = null;
    this._createDefaults = null;
  }

  private async _saveEdit(): Promise<void> {
    const panel = this._editPanel!;
    const name = (panel.querySelector('#ag-edit-name') as HTMLInputElement).value.trim();
    const role = (panel.querySelector('#ag-edit-role') as HTMLSelectElement).value;
    const model = (panel.querySelector('#ag-edit-model') as HTMLInputElement).value.trim();
    const agentPrompt = (panel.querySelector('#ag-edit-prompt') as HTMLTextAreaElement).value.trim();
    const checks = panel.querySelectorAll<HTMLInputElement>('.ag-tool-item input[type="checkbox"]:checked');
    const allowedTools = Array.from(checks).map(cb => cb.value);

    if (!name) { ToastManager.getInstance().error('Name is required'); return; }

    try {
      const vm = App.getInstance().agentVM;
      this._reloading = true;
      if (this._editingAgent && this._editingAgent.id) {
        // Editing existing agent
        await vm.updateAgent(this._editingAgent.id, { name, role, model, allowedTools, agentPrompt } as any);
        ToastManager.getInstance().success(`Updated ${name}`);
      } else {
        // Creating new agent — include parentAgentId if set via ghost
        const createPayload: any = { name, role, model, allowedTools, agentPrompt };
        if (this._createDefaults) {
          createPayload.parentAgentId = this._createDefaults.parentAgentId;
        }
        const result = await vm.createAgent(createPayload);
        if (!result) { this._reloading = false; ToastManager.getInstance().error('Create failed'); return; }
        ToastManager.getInstance().success(`Created ${name}`);
      }
      this._closeEditPanel();
      this._createDefaults = null;
      this._savePositions();
      await vm.loadAgents();
      this._load();
      this._reloading = false;
    } catch (err) { this._reloading = false; ToastManager.getInstance().error('Save failed'); ClientLogger.ui.error('AgentsPage saveEdit', { error: String(err) }); }
  }

  private async _deleteEdit(): Promise<void> {
    if (!this._editingAgent) return;
    const agent = this._editingAgent;
    const ok = await ConfirmDialog.show(`Delete ${agent.name}? Child agents will be reassigned to root.`);
    if (!ok) return;
    try {
      const resp = await fetch(`/api/v1/agents/${agent.id}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      ToastManager.getInstance().success(`Deleted ${agent.name}`);
      this._closeEditPanel();
      App.getInstance().agentVM.loadAgents().then(() => this._load());
    } catch (err) { ToastManager.getInstance().error('Delete failed'); ClientLogger.ui.error('AgentsPage delete', { error: String(err) }); }
  }

  // ═══ Context menu ═════════════════════════════════════════

  private _showContextMenu(x: number, y: number, agent: AgentConfig | null): void {
    this._closeCtxMenu();
    const menu = document.createElement('div'); menu.className = 'ag-ctx-menu'; menu.style.left = x + 'px'; menu.style.top = y + 'px';
    const items: Array<{ label: string; action: () => void; sep?: boolean }> = [];
    if (agent) {
      items.push({ label: 'Edit', action: () => { this._createDefaults = null; this._openEditPanel(agent); } });
      items.push({ label: 'Add Manager', action: () => { this._createDefaults = { parentAgentId: agent.id, role: 'Manager' }; this._openEditPanel({ name: 'New Manager', role: 'Manager', parentAgentId: agent.id, model: agent.model } as any); } });
      items.push({ label: 'Add Member', action: () => { this._createDefaults = { parentAgentId: agent.id, role: 'Member' }; this._openEditPanel({ name: 'New Member', role: 'Member', parentAgentId: agent.id, model: agent.model } as any); } });
      items.push({ label: '', action: () => {}, sep: true });
      items.push({ label: 'Save to Talent Pool', action: () => this._saveAgentToPool(agent) });
      items.push({ label: '', action: () => {}, sep: true });
      items.push({ label: 'Delete', action: () => this._confirmDelete(agent) });
    } else {
      items.push({ label: 'Create Agent', action: () => this._openEditPanel(null) });
    }
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'ag-ctx-sep'; menu.appendChild(s); continue; }
      const row = document.createElement('div'); row.className = 'ag-ctx-item'; row.textContent = it.label;
      row.addEventListener('click', () => { it.action(); this._closeCtxMenu(); });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    this._ctxMenu = menu;
    const closer = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { this._closeCtxMenu(); document.removeEventListener('click', closer, true); } };
    setTimeout(() => document.addEventListener('click', closer, true), 10);
  }

  private _closeCtxMenu(): void {
    if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
  }

  // ═══ CRUD ════════════════════════════════════════════════

  private async _createChild(parent: AgentConfig, role: string): Promise<void> {
    try {
      const resp = await fetch('/api/v1/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `New ${role}`, role, parentAgentId: parent.id, model: parent.model || '', allowedTools: [] }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      ToastManager.getInstance().success(`Created ${role}`);
      App.getInstance().agentVM.loadAgents().then(() => this._load());
    } catch (err) { ToastManager.getInstance().error('Failed to create'); ClientLogger.ui.error('AgentsPage createChild', { error: String(err) }); }
  }

  private async _confirmDelete(agent: AgentConfig): Promise<void> {
    const ok = await ConfirmDialog.show(`Delete ${agent.name}? Child agents will be reassigned to root.`);
    if (!ok) return;
    try {
      const resp = await fetch(`/api/v1/agents/${agent.id}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      ToastManager.getInstance().success(`Deleted ${agent.name}`);
      App.getInstance().agentVM.loadAgents().then(() => this._load());
    } catch (err) { ToastManager.getInstance().error('Delete failed'); ClientLogger.ui.error('AgentsPage delete', { error: String(err) }); }
  }

  // ═══ Talent Pool Integration ════════════════════════════════

  private async _saveAgentToPool(agent: AgentConfig): Promise<void> {
    try {
      const gRes = await fetch('/api/v1/talent-pool/groups');
      if (!gRes.ok) { ToastManager.getInstance().error('Failed to load talent pool groups'); return; }
      const gData = await gRes.json();
      const groups = gData.groups || [];
      if (groups.length === 0) {
        ToastManager.getInstance().error('Create a domain in Talent Pool first');
        this._talentPool?.open();
        return;
      }

      const result = await showSaveToPoolDialog(agent, groups);
      if (!result) return;

      const resp = await fetch('/api/v1/talent-pool/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: result.agentId,
          groupId: result.groupId,
          name: result.name,
          description: result.description,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      ToastManager.getInstance().success(`Saved "${result.name}" to Talent Pool`);
      if (this._talentPool?.visible) {
        this._talentPool.close();
        this._talentPool.open();
      }
    } catch (err) {
      ToastManager.getInstance().error('Save failed');
      ClientLogger.ui.error('saveAgentToPool', { error: String(err) });
    }
  }

  // ═══ Persistence ═════════════════════════════════════════

  private _loadPositions(): Map<string, { x: number; y: number }> {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) return new Map(Object.entries(JSON.parse(raw)));
    } catch { /* ignore */ }
    return new Map();
  }

  private _savePositions(): void {
    const data: Record<string, { x: number; y: number }> = {};
    for (const n of this._nodes) data[n.id] = { x: n.x, y: n.y };
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
  }

  private _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }
}
