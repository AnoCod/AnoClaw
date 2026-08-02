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
import { CoordinationStore } from '../../viewmodel/CoordinationStore.js';
import { onLocaleChange, t } from '../../i18n/index.js';

declare const d3: any;

const STORAGE_KEY = 'anoclaw-agents-positions-v4';

const ROLE_STYLES: Record<string, { r: number; fill: string; stroke: string }> = {
  MainAgent: { r: 22, fill: '#ff6161', stroke: '#ff8a8a' },
  Manager:   { r: 16, fill: '#57c1ff', stroke: '#9bdcff' },
  Member:    { r: 12, fill: '#59d499', stroke: '#9be8c3' },
};
const DEFAULT_STYLE = ROLE_STYLES['Member'];
const GHOST_R = 8;

interface SimNode { id: string; x: number; y: number; r: number; agent?: AgentConfig; isGhost?: boolean; parentId?: string; addRole?: string; }
interface SimLink { source: string | SimNode; target: string | SimNode; cls?: string; }
interface AgentToolMeta {
  name: string;
  group: string;
  displayName: string;
  description: string;
  source?: 'builtin' | 'plugin' | 'external';
  pluginName?: string;
}

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
  private _coordination = CoordinationStore.getInstance();
  private _onCoordinationChanged = () => {
    if (this._active) this._renderAll();
  };

  // Pending create defaults (from ghost button click)
  private _createDefaults: { parentAgentId: string; role: string } | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'ag-page';
    this.container.style.cssText = 'position:relative;flex:1;overflow:hidden;';
    this.container.setAttribute('data-page', 'agents');
    this._initTalentPool();

    // Auto-refresh talent pool on external changes
    const sse = App.getInstance().sseClient;
    sse.on('talent_pool_changed', () => this._talentPool?.reload());
    onLocaleChange(() => this._refreshLocale());
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
          ToastManager.getInstance().error(data.error || t('agents.toast.hireFailed'));
          return;
        }
        ToastManager.getInstance().success(t('agents.toast.joined', { name: result.name }));
        App.getInstance().agentVM.loadAgents().then(() => this._load());
      } catch (err) {
        ToastManager.getInstance().error(t('agents.toast.hireNetwork'));
        ClientLogger.ui.error('hireTemplate', { error: String(err) });
      }
    });
  }

  // ═══ Lifecycle ═══════════════════════════════════════════

  onEnter(): void {
    this._active = true;
    this.container.addEventListener('wheel', this._onWheel, { passive: false });
    this._load();
    App.getInstance().agentVM.on('agentsChanged', this._onAgentsChanged);
    this._coordination.on('changed', this._onCoordinationChanged);
    const activeSessionId = App.getInstance().conversationVM.getActiveSessionId();
    if (activeSessionId) void this._coordination.loadForSession(activeSessionId);
  }

  onExit(): void {
    this._active = false;
    App.getInstance().agentVM.off('agentsChanged', this._onAgentsChanged);
    this._coordination.off('changed', this._onCoordinationChanged);
    this.container.removeEventListener('wheel', this._onWheel);
    this._savePositions();
    if (this._sim) { this._sim.stop(); this._sim = null; }
    if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; }
    if (this._panCleanup) { this._panCleanup(); this._panCleanup = null; }
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
      this.container.innerHTML = `
        <div class="ag-empty">
          <span class="ag-empty-title">${t('agents.emptyTitle')}</span>
          <span class="ag-empty-desc">${t('agents.emptyDescription')}</span>
          <button class="ag-empty-btn" id="ag-create-first">${t('agents.createCeo')}</button>
        </div>
      `;
      this.container.querySelector('#ag-create-first')!.addEventListener('click', () => this._openEditPanel(this._firstAgentDraft()));
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
    tb.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--color-info);"></span> ${t('agents.talentPool')}`;
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
        lbl.setAttribute('dy', String(GHOST_R + 14)); lbl.textContent = this._roleLabel(n.addRole || '');
        lbl.style.pointerEvents = 'none';
        g.appendChild(lbl);
        // Click ghost → open edit panel to create
        g.style.cursor = 'pointer';
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          const parent = App.getInstance().agentVM.agents.find(a => a.id === n.parentId);
          if (parent) {
            const partial = this._childDraft(parent, n.addRole || 'Member');
            this._createDefaults = { parentAgentId: n.parentId!, role: n.addRole || 'Member' };
            this._openEditPanel(partial);
          }
        });
      } else {
        const activeSessionId = App.getInstance().conversationVM.getActiveSessionId();
        const coordination = activeSessionId
          ? this._coordination.stateForSession(activeSessionId)
          : undefined;
        const activeTeam = coordination?.teams.find((team) => team.state === 'active');
        const coordinatedTask = coordination?.tasks.find(
          (task) => task.assigneeAgentId === n.id && !['completed', 'failed', 'cancelled'].includes(task.status),
        );
        const style = n.agent ? (ROLE_STYLES[n.agent.role] || DEFAULT_STYLE) : DEFAULT_STYLE;
        const issue = n.agent ? App.getInstance().agentVM.agentRunnableProblem(n.agent) : null;
        if (issue) {
          g.classList.add('ag-node-g--issue');
          const titleEl = document.createElementNS(svgNS, 'title');
          titleEl.textContent = issue;
          g.appendChild(titleEl);
        }
        const ring = document.createElementNS(svgNS, 'circle');
        ring.setAttribute('r', String(style.r + 7));
        ring.setAttribute('class', 'ag-node-focus-ring');
        ring.setAttribute('stroke', style.stroke);
        g.appendChild(ring);

        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('r', String(style.r));
        circle.setAttribute('class', `ag-node ag-node-${n.agent?.role || 'Member'}`);
        circle.setAttribute('fill', style.fill);
        circle.setAttribute('stroke', style.stroke);
        if (n.id === this._selectedId) {
          circle.classList.add('selected');
          g.classList.add('ag-node-g--selected');
        }
        g.appendChild(circle);
        if (issue) {
          const badge = document.createElementNS(svgNS, 'circle');
          badge.setAttribute('class', 'ag-node-issue-badge');
          badge.setAttribute('cx', String(style.r - 2));
          badge.setAttribute('cy', String(-style.r + 2));
          badge.setAttribute('r', '6');
          g.appendChild(badge);
          const marker = document.createElementNS(svgNS, 'text');
          marker.setAttribute('class', 'ag-node-issue-mark');
          marker.setAttribute('x', String(style.r - 2));
          marker.setAttribute('y', String(-style.r + 5));
          marker.textContent = '!';
          g.appendChild(marker);
        }
        if (activeTeam?.memberAgentIds.includes(n.id)) {
          const badge = document.createElementNS(svgNS, 'text');
          badge.setAttribute('class', `ag-team-badge ag-team-badge-${coordinatedTask?.status || 'idle'}`);
          badge.setAttribute('x', String(style.r + 7));
          badge.setAttribute('y', String(-style.r - 2));
          badge.textContent = coordinatedTask ? this._taskStatusLabel(coordinatedTask.status) : t('agents.team');
          const badgeTitle = document.createElementNS(svgNS, 'title');
          badgeTitle.textContent = coordinatedTask
            ? `${activeTeam.name}: ${coordinatedTask.subject} (${this._taskStatusLabel(coordinatedTask.status)})`
            : `${activeTeam.name}: ${t('agents.teamIdle')}`;
          badge.appendChild(badgeTitle);
          g.appendChild(badge);
        }
        const lbl = document.createElementNS(svgNS, 'text');
        lbl.setAttribute('class', 'ag-node-label'); lbl.setAttribute('text-anchor', 'middle');
        lbl.setAttribute('dy', String(style.r + 15));
        const name = n.agent?.name || '';
        lbl.textContent = name.length > 16 ? name.slice(0, 15) + '...' : name;
        lbl.style.pointerEvents = 'none';
        g.appendChild(lbl);

        // Click → open edit panel
        g.style.cursor = 'pointer';
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          this._selectNode(n.id);
          this._pulseNode(n.id);
          if (n.agent) this._openEditPanel(n.agent);
        });
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
        g.classList.toggle('ag-node-g--selected', n.id === this._selectedId);
        const circle = g.querySelector('.ag-node');
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
    // Don't zoom if scrolling inside the edit panel
    if ((e.target as HTMLElement).closest('.ag-edit-panel')) return;
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

  private _pulseNode(id: string): void {
    if (!this._nodeGroup) return;
    const group = this._nodeGroup.querySelector<SVGGElement>(`.ag-node-g[data-node-id="${CSS.escape(id)}"]`);
    if (!group) return;
    group.classList.remove('ag-node-g--pulsing');
    void group.getBoundingClientRect();
    group.classList.add('ag-node-g--pulsing');
    window.setTimeout(() => group.classList.remove('ag-node-g--pulsing'), 520);
  }

  // ═══ Edit panel ══════════════════════════════════════════

  private _toolMetaCache: Promise<{ tools: AgentToolMeta[]; groups: string[] }> | null = null;

  private _fetchToolMeta(): Promise<{ tools: AgentToolMeta[]; groups: string[] }> {
    if (this._toolMetaCache) return this._toolMetaCache;
    this._toolMetaCache = fetch('/api/v1/tools').then(r => r.json()).then(d => ({
      tools: d.tools || [],
      groups: d.groups || [],
    })).catch(() => { this._toolMetaCache = null; return { tools: [], groups: [] }; });
    return this._toolMetaCache;
  }

  private _toolSource(tool: AgentToolMeta): 'builtin' | 'plugin' | 'external' {
    return tool.source || 'builtin';
  }

  private _toolSourceRank(tool: AgentToolMeta): number {
    const source = this._toolSource(tool);
    if (source === 'builtin') return 0;
    if (source === 'plugin') return 1;
    return 2;
  }

  private async _openEditPanel(agent: AgentConfig | null): Promise<void> {
    this._closeEditPanel();
    this._editingAgent = agent;
    // If called without a parent context, clear create defaults
    if (!agent) this._createDefaults = null;

    const panel = document.createElement('div');
    panel.className = 'ag-edit-panel';
    panel.innerHTML = `<div class="ag-edit-body ag-tools-loading" style="text-align:center;padding:40px;">${t('agents.loadingTools')}</div>`;
    this.container.appendChild(panel);
    this._editPanel = panel;

    // Fetch tools async, then build form
    const meta = await this._fetchToolMeta();
    if (this._editPanel !== panel) return; // closed already
    if (!agent) this._editingAgent = null; // may have changed

    const isNew = !agent;
    const title = isNew ? t('agents.createTitle') : t('agents.editTitle', { name: agent!.name });
    const nameVal = agent?.name || '';
    const roleVal = agent?.role || 'Member';
    const providerVal = agent?.provider || 'openai-compatible';
    const apiUrlVal = agent?.apiUrl || (providerVal === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com');
    const modelVal = agent?.model || '';
    const contextWindowVal = agent?.contextWindow || 128000;
    const maxTurnsVal = agent?.maxTurns ?? 0;
    const temperatureVal = agent?.temperature ?? 0.7;
    const promptVal = agent?.agentPrompt || '';
    const allowedSet = new Set(agent?.allowedTools || []);

    // Build checkboxes HTML — grid layout, full descriptions
    const selectedToolCount = meta.tools.filter(t => allowedSet.has(t.name)).length;
    const sortedTools = [...meta.tools].sort((a, b) => {
      const sourceDiff = this._toolSourceRank(a) - this._toolSourceRank(b);
      if (sourceDiff !== 0) return sourceDiff;
      const pluginDiff = (a.pluginName || '').localeCompare(b.pluginName || '');
      if (pluginDiff !== 0) return pluginDiff;
      const groupDiff = (a.group || 'Other').localeCompare(b.group || 'Other');
      if (groupDiff !== 0) return groupDiff;
      return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    });

    const nativeTools = sortedTools.filter(t => this._toolSource(t) !== 'plugin');
    const pluginGroups = new Map<string, AgentToolMeta[]>();
    for (const tool of sortedTools) {
      if (this._toolSource(tool) !== 'plugin') continue;
      const pluginName = tool.pluginName || t('agents.tools.unknownPlugin');
      if (!pluginGroups.has(pluginName)) pluginGroups.set(pluginName, []);
      pluginGroups.get(pluginName)!.push(tool);
    }

    const renderTool = (tool: AgentToolMeta): string => {
      const checked = allowedSet.has(tool.name) ? ' checked' : '';
      const displayName = tool.displayName || tool.name;
      const group = tool.group || t('agents.tools.other');
      const description = tool.description || '';
      const sourceLabel = this._toolSource(tool) === 'plugin'
        ? (tool.pluginName || t('agents.tools.pluginGeneric'))
        : t('agents.tools.native');
      const searchText = `${displayName} ${tool.name} ${group} ${description} ${sourceLabel}`.toLowerCase();
      return `<label class="ag-tool-card ag-tool-row${checked ? ' ag-tool-card--on' : ''}" data-search="${this._esc(searchText)}">
        <input type="checkbox" value="${this._esc(tool.name)}"${checked}>
        <span class="ag-tool-check" aria-hidden="true"></span>
        <span class="ag-tool-card-main">
          <span class="ag-tool-card-name">${this._esc(displayName)}</span>
          <span class="ag-tool-card-desc">${this._esc(description)}</span>
        </span>
        <span class="ag-tool-card-group">${this._esc(group)}</span>
      </label>`;
    };

    const renderSection = (title: string, tools: AgentToolMeta[], kind: string, pluginName = ''): string => {
      if (tools.length === 0) return '';
      return `<section class="ag-tool-section" data-kind="${this._esc(kind)}" data-plugin-name="${this._esc(pluginName)}">
        <div class="ag-tool-section-head">
          <span class="ag-tool-section-title">${this._esc(title)}</span>
          <span class="ag-tool-section-count">${t('agents.tools.count', { count: tools.length })}</span>
        </div>
        <div class="ag-tool-section-items">${tools.map(renderTool).join('')}</div>
      </section>`;
    };

    let toolsHtml = renderSection(t('agents.tools.native'), nativeTools, 'builtin');
    for (const [pluginName, tools] of pluginGroups) {
      toolsHtml += renderSection(t('agents.tools.plugin', { name: pluginName }), tools, 'plugin', pluginName);
    }

    panel.innerHTML = `
      <div class="ag-edit-header">
        <h3>${this._esc(title)}</h3>
        <button class="ag-edit-close" title="${t('agents.action.close')}" aria-label="${t('agents.action.close')}">&times;</button>
      </div>
      <div class="ag-edit-body">
        <div class="ag-edit-form">
          <div class="ag-field">
            <label for="ag-edit-name">${t('agents.field.name')}</label>
            <input type="text" id="ag-edit-name" value="${this._esc(nameVal)}" placeholder="${t('agents.placeholder.name')}">
          </div>
          <div class="ag-field">
            <label for="ag-edit-role">${t('agents.field.role')}</label>
            <select id="ag-edit-role">
              <option value="MainAgent" ${roleVal === 'MainAgent' ? 'selected' : ''}>${t('agents.role.ceo')}</option>
              <option value="Manager" ${roleVal === 'Manager' ? 'selected' : ''}>${t('agents.role.manager')}</option>
              <option value="Member" ${roleVal === 'Member' ? 'selected' : ''}>${t('agents.role.member')}</option>
            </select>
          </div>
          <div class="ag-field">
            <label for="ag-edit-provider">${t('agents.field.provider')}</label>
            <select id="ag-edit-provider">
              <option value="openai-compatible" ${providerVal !== 'ollama' ? 'selected' : ''}>OpenAI-compatible</option>
              <option value="ollama" ${providerVal === 'ollama' ? 'selected' : ''}>Ollama</option>
            </select>
          </div>
          <div class="ag-field">
            <label for="ag-edit-api-url">${t('agents.field.apiUrl')}</label>
            <input type="text" id="ag-edit-api-url" value="${this._esc(apiUrlVal)}" placeholder="https://api.openai.com">
          </div>
          <div class="ag-field">
            <label for="ag-edit-api-key">${t('agents.field.apiKey')}</label>
            <input type="password" id="ag-edit-api-key" value="" placeholder="${isNew ? t('agents.placeholder.apiKeyNew') : t('agents.placeholder.apiKeyExisting')}" autocomplete="off">
            ${!isNew && agent?.apiKey ? `<div class="ag-secret-note">${t('agents.secretSaved')}</div>` : ''}
          </div>
          <div class="ag-field">
            <label for="ag-edit-model">${t('agents.field.model')}</label>
            <input type="text" id="ag-edit-model" value="${this._esc(modelVal)}" placeholder="${t('agents.placeholder.model')}">
          </div>
          <div class="ag-field ag-field-grid">
            <span>
              <label for="ag-edit-context">${t('agents.field.context')}</label>
              <input type="number" id="ag-edit-context" value="${contextWindowVal}" min="1000" step="1000">
            </span>
            <span>
              <label for="ag-edit-max-turns">${t('agents.field.maxTurns')}</label>
              <input type="number" id="ag-edit-max-turns" value="${maxTurnsVal}" min="0" step="1">
            </span>
            <span>
              <label for="ag-edit-temperature">${t('agents.field.temperature')}</label>
              <input type="number" id="ag-edit-temperature" value="${temperatureVal}" min="0" max="2" step="0.1">
            </span>
          </div>
          <div class="ag-field ag-field-prompt">
            <label for="ag-edit-prompt">${t('agents.field.systemPrompt')}</label>
            <textarea id="ag-edit-prompt" rows="10" placeholder="${t('agents.placeholder.systemPrompt')}">${this._esc(promptVal)}</textarea>
          </div>
        </div>
        <section class="ag-tools-panel" aria-label="${t('agents.tools.allowed')}">
          <div class="ag-tools-head">
            <div>
              <label for="ag-tool-search">${t('agents.tools.allowed')}</label>
              <span class="ag-tools-count"><span id="ag-tool-count">${selectedToolCount}</span><span class="ag-tools-count-label">${t('agents.tools.selectedSuffix', { total: meta.tools.length })}</span></span>
            </div>
            <div class="ag-tools-actions">
              <button type="button" class="ag-tools-select-visible">${t('agents.tools.selectVisible')}</button>
              <button type="button" class="ag-tools-clear">${t('agents.tools.clear')}</button>
            </div>
          </div>
          <input type="search" id="ag-tool-search" class="ag-tool-search" placeholder="${t('agents.tools.search')}">
          <div class="ag-tool-list">${toolsHtml}</div>
          <div class="ag-tool-empty" hidden>${t('agents.tools.noMatch')}</div>
        </section>
      </div>
      <div class="ag-edit-footer">
        ${!isNew ? `<button class="ag-edit-btn-delete">${t('common.delete')}</button>` : ''}
        <button class="ag-edit-btn-test" type="button">${t('agents.action.test')}</button>
        <button class="ag-edit-btn-cancel">${t('common.cancel')}</button>
        <button class="ag-edit-btn-save">${t('common.save')}</button>
      </div>
    `;

    panel.querySelector('.ag-edit-close')!.addEventListener('click', () => this._closeEditPanel());
    panel.querySelector('.ag-edit-btn-cancel')!.addEventListener('click', () => this._closeEditPanel());
    panel.querySelector('.ag-edit-btn-test')!.addEventListener('click', () => this._testConnection());
    panel.querySelector('.ag-edit-btn-save')!.addEventListener('click', () => this._saveEdit());
    this._wireProviderDefaults(panel, isNew);
    if (!isNew) {
      panel.querySelector('.ag-edit-btn-delete')!.addEventListener('click', () => this._deleteEdit());
    }
    this._wireToolPicker(panel);
    const onEsc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { this._closeEditPanel(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);
  }

  private _wireProviderDefaults(panel: HTMLElement, isNew: boolean): void {
    const providerEl = panel.querySelector<HTMLSelectElement>('#ag-edit-provider');
    const apiUrlEl = panel.querySelector<HTMLInputElement>('#ag-edit-api-url');
    const modelEl = panel.querySelector<HTMLInputElement>('#ag-edit-model');
    if (!providerEl || !apiUrlEl || !modelEl) return;

    providerEl.addEventListener('change', () => {
      if (providerEl.value === 'ollama') {
        if (!apiUrlEl.value || apiUrlEl.value === 'https://api.openai.com') apiUrlEl.value = 'http://localhost:11434';
        if (isNew && !modelEl.value) modelEl.value = 'llama3.1';
      } else if (!apiUrlEl.value || apiUrlEl.value === 'http://localhost:11434') {
        apiUrlEl.value = 'https://api.openai.com';
      }
    });
  }

  private _childDraft(parent: AgentConfig, role: string): any {
    return {
      role,
      parentAgentId: parent.id,
      name: t('agents.newRole', { role: this._roleLabel(role) }),
      provider: parent.provider || 'openai-compatible',
      apiUrl: parent.apiUrl || '',
      model: parent.model || '',
      contextWindow: parent.contextWindow || 128000,
      maxTurns: parent.maxTurns ?? 0,
      temperature: parent.temperature ?? 0.7,
    };
  }

  private _firstAgentDraft(): any {
    return {
      name: 'CEO',
      role: 'MainAgent',
      provider: 'openai-compatible',
      apiUrl: 'https://api.openai.com',
      model: '',
      contextWindow: 128000,
      maxTurns: 0,
      temperature: 0.7,
      agentPrompt: 'You are the CEO of this AnoClaw workspace. Understand the user goal, coordinate specialist agents when useful, and keep the work moving with clear, verified outcomes.',
    };
  }

  private _rootAgentDraft(): any {
    const mainAgent = App.getInstance().agentVM.agents.find(a => a.role === 'MainAgent');
    return mainAgent ? this._childDraft(mainAgent, 'Manager') : this._firstAgentDraft();
  }

  private _hierarchyError(role: string, parentAgentId: string | null): string | null {
    const agents = App.getInstance().agentVM.agents;
    if (role === 'MainAgent') return parentAgentId ? t('agents.validation.ceoNoParent') : null;
    if (!parentAgentId) return t('agents.validation.parentRequired', { role: this._roleLabel(role) });
    const parent = agents.find(a => a.id === parentAgentId);
    if (!parent) return t('agents.validation.parentMissing');
    if (role === 'Manager' && parent.role !== 'MainAgent') return t('agents.validation.managerParent');
    if (role === 'Member' && parent.role !== 'Manager') return t('agents.validation.memberParent');
    return null;
  }

  private _wireToolPicker(panel: HTMLElement): void {
    const cards = Array.from(panel.querySelectorAll<HTMLLabelElement>('.ag-tool-card'));
    const sections = Array.from(panel.querySelectorAll<HTMLElement>('.ag-tool-section'));
    const checks = Array.from(panel.querySelectorAll<HTMLInputElement>('.ag-tool-card input[type="checkbox"]'));
    const countEl = panel.querySelector<HTMLElement>('#ag-tool-count');
    const searchInput = panel.querySelector<HTMLInputElement>('#ag-tool-search');
    const emptyEl = panel.querySelector<HTMLElement>('.ag-tool-empty');

    const updateCount = () => {
      const selected = checks.filter(cb => cb.checked).length;
      if (countEl) countEl.textContent = String(selected);
      for (const card of cards) {
        const cb = card.querySelector<HTMLInputElement>('input[type="checkbox"]');
        card.classList.toggle('ag-tool-card--on', !!cb?.checked);
      }
    };

    const applyFilter = () => {
      const query = (searchInput?.value || '').trim().toLowerCase();
      let visible = 0;
      for (const section of sections) {
        let sectionVisible = 0;
        const sectionCards = Array.from(section.querySelectorAll<HTMLLabelElement>('.ag-tool-card'));
        for (const card of sectionCards) {
          const haystack = card.dataset.search || '';
          const matches = !query || haystack.includes(query);
          card.hidden = !matches;
          if (matches) {
            sectionVisible++;
            visible++;
          }
        }
        section.hidden = sectionVisible === 0;
      }
      if (emptyEl) emptyEl.hidden = visible > 0;
    };

    for (const cb of checks) {
      cb.addEventListener('change', updateCount);
    }
    searchInput?.addEventListener('input', applyFilter);
    panel.querySelector('.ag-tools-select-visible')?.addEventListener('click', () => {
      for (const card of cards) {
        if (card.hidden) continue;
        const cb = card.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (cb) cb.checked = true;
      }
      updateCount();
    });
    panel.querySelector('.ag-tools-clear')?.addEventListener('click', () => {
      for (const cb of checks) cb.checked = false;
      updateCount();
    });

    updateCount();
    applyFilter();
  }

  private _closeEditPanel(): void {
    if (this._editPanel) { this._editPanel.remove(); this._editPanel = null; }
    this._editingAgent = null;
    this._createDefaults = null;
  }

  private _descendantCount(agentId: string): number {
    const agents = App.getInstance().agentVM.agents;
    const seen = new Set<string>();
    const queue = [agentId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const agent of agents) {
        if (agent.parentAgentId !== current || seen.has(agent.id)) continue;
        seen.add(agent.id);
        queue.push(agent.id);
      }
    }
    return seen.size;
  }

  private async _saveEdit(): Promise<void> {
    const panel = this._editPanel!;
    const name = (panel.querySelector('#ag-edit-name') as HTMLInputElement).value.trim();
    const role = (panel.querySelector('#ag-edit-role') as HTMLSelectElement).value;
    const provider = (panel.querySelector('#ag-edit-provider') as HTMLSelectElement).value;
    const apiUrl = (panel.querySelector('#ag-edit-api-url') as HTMLInputElement).value.trim();
    const apiKey = (panel.querySelector('#ag-edit-api-key') as HTMLInputElement).value.trim();
    const model = (panel.querySelector('#ag-edit-model') as HTMLInputElement).value.trim();
    const contextWindow = Number((panel.querySelector('#ag-edit-context') as HTMLInputElement).value);
    const maxTurns = Number((panel.querySelector('#ag-edit-max-turns') as HTMLInputElement).value);
    const temperature = Number((panel.querySelector('#ag-edit-temperature') as HTMLInputElement).value);
    const agentPrompt = (panel.querySelector('#ag-edit-prompt') as HTMLTextAreaElement).value.trim();
    const checks = panel.querySelectorAll<HTMLInputElement>('.ag-tool-card input[type="checkbox"]:checked');
    const allowedTools = Array.from(checks).map(cb => cb.value);

    if (!name) { ToastManager.getInstance().error(t('agents.validation.nameRequired')); return; }
    if (!model) { ToastManager.getInstance().error(t('agents.validation.modelRequired')); return; }
    if (!apiUrl) { ToastManager.getInstance().error(t('agents.validation.apiUrlRequired')); return; }
    const duplicateMainAgent = role === 'MainAgent'
      && App.getInstance().agentVM.agents.some(a => a.role === 'MainAgent' && a.id !== this._editingAgent?.id);
    if (duplicateMainAgent) { ToastManager.getInstance().error(t('agents.validation.oneCeo')); return; }
    const parentAgentId = this._editingAgent?.parentAgentId || this._createDefaults?.parentAgentId || null;
    const hierarchyError = this._hierarchyError(role, parentAgentId);
    if (hierarchyError) { ToastManager.getInstance().error(hierarchyError); return; }
    if (!Number.isFinite(contextWindow) || contextWindow < 1000) { ToastManager.getInstance().error(t('agents.validation.contextMin')); return; }
    if (!Number.isFinite(maxTurns) || maxTurns < 0 || !Number.isInteger(maxTurns)) { ToastManager.getInstance().error(t('agents.validation.maxTurns')); return; }
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) { ToastManager.getInstance().error(t('agents.validation.temperature')); return; }

    try {
      const vm = App.getInstance().agentVM;
      const payload: any = {
        name,
        role,
        provider,
        apiUrl,
        model,
        contextWindow,
        maxTurns,
        temperature,
        allowedTools,
        agentPrompt,
      };
      if (apiKey) payload.apiKey = apiKey;

      this._reloading = true;
      if (this._editingAgent && this._editingAgent.id) {
        // Editing existing agent
        const ok = await vm.updateAgent(this._editingAgent.id, payload);
        if (!ok) { this._reloading = false; ToastManager.getInstance().error(vm.lastError || t('agents.toast.updateFailed')); return; }
        ToastManager.getInstance().success(t('agents.toast.updated', { name }));
      } else {
        // Creating new agent — include parentAgentId if set via ghost
        const createPayload: any = { ...payload };
        if (this._createDefaults) {
          createPayload.parentAgentId = this._createDefaults.parentAgentId;
        }
        const result = await vm.createAgent(createPayload);
        if (!result) { this._reloading = false; ToastManager.getInstance().error(vm.lastError || t('agents.toast.createFailed')); return; }
        ToastManager.getInstance().success(t('agents.toast.created', { name }));
      }
      this._closeEditPanel();
      this._createDefaults = null;
      this._savePositions();
      await vm.loadAgents();
      this._load();
      this._reloading = false;
    } catch (err) { this._reloading = false; ToastManager.getInstance().error(t('agents.toast.saveFailed')); ClientLogger.ui.error('AgentsPage saveEdit', { error: String(err) }); }
  }

  private async _testConnection(): Promise<void> {
    const panel = this._editPanel;
    if (!panel) return;

    const provider = (panel.querySelector('#ag-edit-provider') as HTMLSelectElement).value;
    const apiUrl = (panel.querySelector('#ag-edit-api-url') as HTMLInputElement).value.trim();
    const apiKey = (panel.querySelector('#ag-edit-api-key') as HTMLInputElement).value.trim();
    const model = (panel.querySelector('#ag-edit-model') as HTMLInputElement).value.trim();
    const btn = panel.querySelector<HTMLButtonElement>('.ag-edit-btn-test');

    if (!model) { ToastManager.getInstance().error(t('agents.validation.modelRequired')); return; }
    if (!apiUrl) { ToastManager.getInstance().error(t('agents.validation.apiUrlRequired')); return; }
    if (provider !== 'ollama' && !apiKey && !this._editingAgent?.id) {
      ToastManager.getInstance().error(t('agents.validation.apiKeyRequired'));
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = t('agents.action.testing');
    }

    try {
      const result = await App.getInstance().agentVM.testConnection({
        agentId: this._editingAgent?.id,
        provider,
        apiUrl,
        apiKey,
        model,
      });
      if (result.ok) {
        const message = typeof result.durationMs === 'number'
          ? t('agents.toast.connectionDuration', {
            message: result.message,
            seconds: Math.max(1, Math.round(result.durationMs / 1000)),
          })
          : result.message;
        ToastManager.getInstance().success(message);
      } else {
        ToastManager.getInstance().error(result.message);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('agents.action.test');
      }
    }
  }

  private async _deleteEdit(): Promise<void> {
    if (!this._editingAgent) return;
    const agent = this._editingAgent;
    const descendantCount = this._descendantCount(agent.id);
    const ok = await ConfirmDialog.show(this._deletePrompt(agent.name, descendantCount));
    if (!ok) return;
    try {
      const vm = App.getInstance().agentVM;
      const deleted = await vm.deleteAgent(agent.id, descendantCount > 0);
      if (!deleted) throw new Error(vm.lastError || t('agents.toast.deleteFailed'));
      ToastManager.getInstance().success(t('agents.toast.deleted', { name: agent.name }));
      this._closeEditPanel();
      App.getInstance().agentVM.loadAgents().then(() => this._load());
    } catch (err) { ToastManager.getInstance().error(t('agents.toast.deleteFailed')); ClientLogger.ui.error('AgentsPage delete', { error: String(err) }); }
  }

  // ═══ Context menu ═════════════════════════════════════════

  private _showContextMenu(x: number, y: number, agent: AgentConfig | null): void {
    this._closeCtxMenu();
    const menu = document.createElement('div'); menu.className = 'ag-ctx-menu'; menu.style.left = x + 'px'; menu.style.top = y + 'px';
    const items: Array<{ label: string; action: () => void; sep?: boolean }> = [];
    if (agent) {
      items.push({ label: t('agents.action.edit'), action: () => { this._createDefaults = null; this._openEditPanel(agent); } });
      if (agent.role === 'MainAgent') {
        items.push({ label: t('agents.action.addManager'), action: () => { this._createDefaults = { parentAgentId: agent.id, role: 'Manager' }; this._openEditPanel(this._childDraft(agent, 'Manager')); } });
      } else if (agent.role === 'Manager') {
        items.push({ label: t('agents.action.addMember'), action: () => { this._createDefaults = { parentAgentId: agent.id, role: 'Member' }; this._openEditPanel(this._childDraft(agent, 'Member')); } });
      }
      items.push({ label: '', action: () => {}, sep: true });
      items.push({ label: t('agents.action.saveToPool'), action: () => this._saveAgentToPool(agent) });
      items.push({ label: '', action: () => {}, sep: true });
      items.push({ label: t('common.delete'), action: () => this._confirmDelete(agent) });
    } else {
      items.push({ label: t('agents.action.create'), action: () => {
        const draft = this._rootAgentDraft();
        this._createDefaults = draft?.parentAgentId ? { parentAgentId: draft.parentAgentId, role: draft.role || 'Manager' } : null;
        this._openEditPanel(draft);
      } });
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
        body: JSON.stringify({ ...this._childDraft(parent, role), allowedTools: [] }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      ToastManager.getInstance().success(t('agents.toast.roleCreated', { role: this._roleLabel(role) }));
      App.getInstance().agentVM.loadAgents().then(() => this._load());
    } catch (err) { ToastManager.getInstance().error(t('agents.toast.createFailed')); ClientLogger.ui.error('AgentsPage createChild', { error: String(err) }); }
  }

  private async _confirmDelete(agent: AgentConfig): Promise<void> {
    const descendantCount = this._descendantCount(agent.id);
    const ok = await ConfirmDialog.show(this._deletePrompt(agent.name, descendantCount));
    if (!ok) return;
    try {
      const vm = App.getInstance().agentVM;
      const deleted = await vm.deleteAgent(agent.id, descendantCount > 0);
      if (!deleted) throw new Error(vm.lastError || t('agents.toast.deleteFailed'));
      ToastManager.getInstance().success(t('agents.toast.deleted', { name: agent.name }));
      App.getInstance().agentVM.loadAgents().then(() => this._load());
    } catch (err) { ToastManager.getInstance().error(t('agents.toast.deleteFailed')); ClientLogger.ui.error('AgentsPage delete', { error: String(err) }); }
  }

  // ═══ Talent Pool Integration ════════════════════════════════

  private async _saveAgentToPool(agent: AgentConfig): Promise<void> {
    try {
      const gRes = await fetch('/api/v1/talent-pool/groups');
      if (!gRes.ok) { ToastManager.getInstance().error(t('agents.toast.loadPoolGroupsFailed')); return; }
      const gData = await gRes.json();
      const groups = gData.groups || [];
      if (groups.length === 0) {
        ToastManager.getInstance().error(t('agents.toast.createPoolDomainFirst'));
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
      ToastManager.getInstance().success(t('agents.toast.savedToPool', { name: result.name }));
      if (this._talentPool?.visible) {
        this._talentPool.close();
        this._talentPool.open();
      }
    } catch (err) {
      ToastManager.getInstance().error(t('agents.toast.saveFailed'));
      ClientLogger.ui.error('saveAgentToPool', { error: String(err) });
    }
  }

  private _refreshLocale(): void {
    const emptyTitle = this.container.querySelector<HTMLElement>('.ag-empty-title');
    if (emptyTitle) {
      emptyTitle.textContent = t('agents.emptyTitle');
      const description = this.container.querySelector<HTMLElement>('.ag-empty-desc');
      const create = this.container.querySelector<HTMLButtonElement>('#ag-create-first');
      if (description) description.textContent = t('agents.emptyDescription');
      if (create) create.textContent = t('agents.createCeo');
    }

    if (this._talentBtn) {
      this._talentBtn.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--color-info);"></span> ${t('agents.talentPool')}`;
    }
    if (this._nodeGroup && this._edgeGroup) this._renderAll();

    const panel = this._editPanel;
    if (!panel) return;
    const loading = panel.querySelector<HTMLElement>('.ag-tools-loading');
    if (loading) {
      loading.textContent = t('agents.loadingTools');
      return;
    }

    const setText = (selector: string, value: string): void => {
      const element = panel.querySelector<HTMLElement>(selector);
      if (element) element.textContent = value;
    };
    const setPlaceholder = (selector: string, value: string): void => {
      const input = panel.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (input) input.placeholder = value;
    };

    const isNew = !this._editingAgent;
    setText('.ag-edit-header h3', isNew
      ? t('agents.createTitle')
      : t('agents.editTitle', { name: this._editingAgent?.name || '' }));
    const close = panel.querySelector<HTMLButtonElement>('.ag-edit-close');
    if (close) {
      close.title = t('agents.action.close');
      close.setAttribute('aria-label', t('agents.action.close'));
    }

    const fieldLabels: Array<[string, string]> = [
      ['ag-edit-name', t('agents.field.name')],
      ['ag-edit-role', t('agents.field.role')],
      ['ag-edit-provider', t('agents.field.provider')],
      ['ag-edit-api-url', t('agents.field.apiUrl')],
      ['ag-edit-api-key', t('agents.field.apiKey')],
      ['ag-edit-model', t('agents.field.model')],
      ['ag-edit-context', t('agents.field.context')],
      ['ag-edit-max-turns', t('agents.field.maxTurns')],
      ['ag-edit-temperature', t('agents.field.temperature')],
      ['ag-edit-prompt', t('agents.field.systemPrompt')],
      ['ag-tool-search', t('agents.tools.allowed')],
    ];
    for (const [id, label] of fieldLabels) setText(`label[for="${id}"]`, label);

    setText('#ag-edit-role option[value="MainAgent"]', t('agents.role.ceo'));
    setText('#ag-edit-role option[value="Manager"]', t('agents.role.manager'));
    setText('#ag-edit-role option[value="Member"]', t('agents.role.member'));
    setPlaceholder('#ag-edit-name', t('agents.placeholder.name'));
    setPlaceholder('#ag-edit-api-key', isNew
      ? t('agents.placeholder.apiKeyNew')
      : t('agents.placeholder.apiKeyExisting'));
    setPlaceholder('#ag-edit-model', t('agents.placeholder.model'));
    setPlaceholder('#ag-edit-prompt', t('agents.placeholder.systemPrompt'));
    setPlaceholder('#ag-tool-search', t('agents.tools.search'));
    setText('.ag-secret-note', t('agents.secretSaved'));

    const toolsPanel = panel.querySelector<HTMLElement>('.ag-tools-panel');
    toolsPanel?.setAttribute('aria-label', t('agents.tools.allowed'));
    const toolTotal = panel.querySelectorAll('.ag-tool-card').length;
    setText('.ag-tools-count-label', t('agents.tools.selectedSuffix', { total: toolTotal }));
    setText('.ag-tools-select-visible', t('agents.tools.selectVisible'));
    setText('.ag-tools-clear', t('agents.tools.clear'));
    setText('.ag-tool-empty', t('agents.tools.noMatch'));
    panel.querySelectorAll<HTMLElement>('.ag-tool-section').forEach((section) => {
      const title = section.querySelector<HTMLElement>('.ag-tool-section-title');
      const count = section.querySelector<HTMLElement>('.ag-tool-section-count');
      const sectionCount = section.querySelectorAll('.ag-tool-card').length;
      if (title) {
        title.textContent = section.dataset.kind === 'plugin'
          ? t('agents.tools.plugin', { name: section.dataset.pluginName || '' })
          : t('agents.tools.native');
      }
      if (count) count.textContent = t('agents.tools.count', { count: sectionCount });
    });

    setText('.ag-edit-btn-delete', t('common.delete'));
    const testButton = panel.querySelector<HTMLButtonElement>('.ag-edit-btn-test');
    if (testButton) {
      testButton.textContent = testButton.disabled
        ? t('agents.action.testing')
        : t('agents.action.test');
    }
    setText('.ag-edit-btn-cancel', t('common.cancel'));
    setText('.ag-edit-btn-save', t('common.save'));
  }

  private _roleLabel(role: string): string {
    if (role === 'MainAgent') return t('agents.role.ceo');
    if (role === 'Manager') return t('agents.role.manager');
    if (role === 'Member') return t('agents.role.member');
    return role;
  }

  private _taskStatusLabel(status: string): string {
    const keys = {
      pending: 'agents.taskStatus.pending',
      ready: 'agents.taskStatus.ready',
      assigned: 'agents.taskStatus.assigned',
      running: 'agents.taskStatus.running',
      paused: 'agents.taskStatus.paused',
      completed: 'agents.taskStatus.completed',
      failed: 'agents.taskStatus.failed',
      cancelled: 'agents.taskStatus.cancelled',
    } as const;
    return status in keys ? t(keys[status as keyof typeof keys]) : status.toUpperCase();
  }

  private _deletePrompt(name: string, descendantCount: number): string {
    const descendants = descendantCount < 1
      ? ''
      : t(descendantCount === 1 ? 'agents.deleteDescendants.one' : 'agents.deleteDescendants.many', {
        count: descendantCount,
      });
    return t('agents.deleteConfirm', { name, descendants }).trim();
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
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
