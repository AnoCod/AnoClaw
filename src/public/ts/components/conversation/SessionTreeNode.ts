// AnoClaw — SessionTreeNode: Raycast command-palette-style session rows
//
// Flat rows with minimal indent, no tree guides, surface-lift selection,
// clean arrow toggle, and hover-reveal action buttons.

import type { SessionNode, AgentStatus } from './types.js';
import type { SessionStatus } from '../../types.js';
import { ClientLogger } from '../../ClientLogger.js';

// ── SVG icon builders (inline, no external files) ──

const SVG_CHEVRON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`;

const SVG_EDIT = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8H3v-3z"/></svg>`;

const SVG_DELETE = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5 4V2h6v2M12 6l-.5 7.5a1 1 0 0 1-1 .5h-5a1 1 0 0 1-1-.5L4 6"/></svg>`;

// ── Role-based color map ──

const ROLE_COLORS: Record<string, string> = {
  MainAgent: 'var(--color-text-primary)',
  Manager: 'var(--color-text-secondary)',
  Member: 'var(--color-text-tertiary)',
  SubAgent: 'var(--color-text-quaternary)',
};

function getRoleColor(role: string | undefined): string {
  return ROLE_COLORS[role || ''] || 'var(--color-text-quaternary)';
}

function getLevelColor(level: number | undefined): string {
  if (level === 0) return 'var(--color-text-primary)';
  if (level === 1) return 'var(--color-text-secondary)';
  return 'var(--color-text-tertiary)';
}

function getStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'working' || s === 'active' || s === 'started' || s === 'tool_executing') return 'var(--color-success)';
  if (s === 'error') return 'var(--color-error)';
  if (s === 'paused') return 'var(--color-warning)';
  return 'var(--color-text-quaternary)';
}

/** Map status to CSS class for the dot element (no inline styles). */
function getStatusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'working' || s === 'active' || s === 'started' || s === 'tool_executing') return 'stn-status-working';
  if (s === 'error') return 'stn-status-error';
  if (s === 'paused') return 'stn-status-paused';
  return 'stn-status-idle';
}

// ── Component ──

export class SessionTreeNode {
  element: HTMLElement;
  onSelect: ((sessionId: string) => void) | null;
  onRename: ((sessionId: string, newTitle: string) => void) | null;
  onDelete: ((sessionId: string) => void) | null;

  private node: SessionNode;
  private depth: number;
  private isSelected: boolean;
  private isExpanded: boolean;
  private titleSpan!: HTMLSpanElement;
  private arrowEl!: HTMLElement;
  private statusDot!: HTMLElement;
  private actionsEl!: HTMLElement;
  private childContainer: HTMLElement | null;
  private childNodes: SessionTreeNode[];

  constructor(node: SessionNode, depth: number = 0) {
    this.node = node;
    this.depth = depth;
    this.isSelected = false;
    this.isExpanded = node.children.length > 0;
    this.onSelect = null;
    this.onRename = null;
    this.onDelete = null;
    this.childNodes = [];
    this.childContainer = null;

    this.element = document.createElement('div');
    this.element.className = 'stn-node';
    this.element.setAttribute('data-session-id', node.id);
    this.element.setAttribute('data-depth', String(this.depth));
    if (node.children.length > 0) {
      this.element.setAttribute('data-is-parent', 'true');
    }

    // Row
    const row = this.buildRow();
    this.element.appendChild(row);

    // Children
    if (node.children.length > 0) {
      this.childContainer = document.createElement('div');
      this.childContainer.className = 'stn-children';
      if (!this.isExpanded) this.childContainer.style.display = 'none';
      this.element.appendChild(this.childContainer);
      this.renderChildren();
    }
  }

  // ── Row builder ──

  private buildRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'stn-row';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(this.depth + 1));
    row.setAttribute('aria-expanded', String(this.node.children.length > 0 && this.isExpanded));
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('aria-label', this.node.title);
    row.style.paddingLeft = `${8 + this.depth * 16}px`;

    // Indent children slightly for visual nesting
    row.style.paddingLeft = `${8 + this.depth * 14}px`;

    // Expand/collapse arrow (chevron)
    this.arrowEl = document.createElement('span');
    this.arrowEl.className = 'stn-arrow';
    this.arrowEl.innerHTML = SVG_CHEVRON;
    if (this.node.children.length === 0) {
      this.arrowEl.classList.add('stn-arrow-hidden');
    }
    if (this.isExpanded) {
      this.arrowEl.classList.add('stn-arrow-open');
    }
    this.arrowEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    row.appendChild(this.arrowEl);

    // Status dot (CSS circle, no img load)
    this.statusDot = document.createElement('span');
    this.statusDot.className = 'stn-status-dot';
    this.updateStatusDot();
    row.appendChild(this.statusDot);

    // Agent badge — color by level (0=accent, 1=info, 2+=success)
    const nodeIsMain = this.node.isMain !== false && !(this.node as any).parentSessionId;
    const agentName = ((this.node as any).agentName as string) || '';
    const agentId = ((this.node as any).agentId as string) || '';
    const level = (this.node as any).level as number | undefined;
    const badgeName = agentName || agentId;

    if (badgeName && !nodeIsMain) {
      const badge = document.createElement('span');
      badge.className = 'stn-badge';
      badge.textContent = badgeName;
      badge.style.color = getLevelColor(level);
      row.appendChild(badge);
    } else if (nodeIsMain) {
      const badge = document.createElement('span');
      badge.className = 'stn-badge';
      badge.textContent = badgeName || 'Main';
      badge.style.color = 'var(--color-text-primary)';
      row.appendChild(badge);
    }

    // Title (double-click to rename)
    this.titleSpan = document.createElement('span');
    this.titleSpan.className = 'stn-title';
    this.titleSpan.textContent = this.node.title;
    this.titleSpan.title = this.node.title;
    this.titleSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startRename();
    });
    row.appendChild(this.titleSpan);

    // Child count badge for parent nodes
    if (this.node.children.length > 0) {
      const countBadge = document.createElement('span');
      countBadge.className = 'stn-child-count';
      countBadge.textContent = String(this.node.children.length);
      countBadge.title = `${this.node.children.length} sub-sessions`;
      row.appendChild(countBadge);
    }

    // Tag chips — from session metadata.evolutionTags
    const meta = this.node.metadata as Record<string, unknown> | undefined;
    const tags = (meta?.evolutionTags || []) as Array<{ label: string; category: string }>;
    if (tags.length > 0) {
      const tagContainer = document.createElement('span');
      tagContainer.className = 'stn-tags';
      for (const tag of tags.slice(0, 3)) { // max 3 tags visible
        const chip = document.createElement('span');
        chip.className = 'stn-tag' + (tag.category === 'auto' ? ' stn-tag--auto' : ' stn-tag--user');
        chip.textContent = tag.label;
        tagContainer.appendChild(chip);
      }
      if (tags.length > 3) {
        const more = document.createElement('span');
        more.className = 'stn-tag-more';
        more.textContent = `+${tags.length - 3}`;
        tagContainer.appendChild(more);
      }
      row.appendChild(tagContainer);
    }

    // Action buttons (fade on hover)
    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'stn-actions';

    const editBtn = this.createActionBtn(SVG_EDIT, 'Rename');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startRename();
    });
    this.actionsEl.appendChild(editBtn);

    const deleteBtn = this.createActionBtn(SVG_DELETE, 'Archive');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onDelete) this.onDelete(this.node.id);
    });
    this.actionsEl.appendChild(deleteBtn);

    row.appendChild(this.actionsEl);

    // Hover effect via CSS, managed by .stn-row:hover

    // Click to select the session
    row.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.stn-action-btn') || target.closest('.stn-rename-input') || target.closest('.stn-arrow')) {
        return;
      }
      this.select();
    });

    return row;
  }

  // ── Action button factory ──

  private createActionBtn(svg: string, title: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'stn-action-btn';
    btn.title = title;
    btn.innerHTML = svg;
    return btn;
  }

  // ── Inline rename ──

  private startRename(): void {
    const row = this.element.querySelector('.stn-row') as HTMLElement;
    if (!row) return;

    // Hide title
    this.titleSpan.style.display = 'none';
    this.actionsEl.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'stn-rename-input';
    input.value = this.node.title;
    input.setAttribute('aria-label', 'Rename session');
    row.insertBefore(input, this.actionsEl);

    input.focus();
    input.select();

    const commit = () => {
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== this.node.title) {
        this.node.title = newTitle;
        this.titleSpan.textContent = newTitle;
        this.titleSpan.title = newTitle;
        if (this.onRename) this.onRename(this.node.id, newTitle);
      }
      input.remove();
      this.titleSpan.style.display = '';
      this.actionsEl.style.display = '';
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = this.node.title;
        input.blur();
      }
    });
  }

  // ── Status dot ──

  private updateStatusDot(): void {
    // Clear all status classes
    this.statusDot.classList.remove('stn-status-working', 'stn-status-idle', 'stn-status-error', 'stn-status-paused');
    // Add the correct one
    this.statusDot.classList.add(getStatusClass(this.node.status));

    if (this.node.status === 'working' || this.node.status === 'tool_executing') {
      this.statusDot.classList.add('stn-status-pulse');
    } else {
      this.statusDot.classList.remove('stn-status-pulse');
    }
  }

  // ── Public API ──

  select(): void {
    if (this.onSelect) this.onSelect(this.node.id);
  }

  setSelected(selected: boolean): void {
    this.isSelected = selected;
    const row = this.element.querySelector('.stn-row') as HTMLElement;
    if (row) {
      row.classList.toggle('stn-row-selected', selected);
      row.setAttribute('aria-selected', String(selected));
    }
  }

  toggle(): void {
    this.isExpanded = !this.isExpanded;
    this.arrowEl.classList.toggle('stn-arrow-open', this.isExpanded);
    if (this.childContainer) {
      this.childContainer.style.display = this.isExpanded ? 'block' : 'none';
    }
    const row = this.element.querySelector('.stn-row') as HTMLElement;
    if (row) {
      row.setAttribute('aria-expanded', String(this.isExpanded));
    }
  }

  updateStatus(status: SessionStatus): void {
    this.node.status = status;
    this.updateStatusDot();
  }

  updateTitle(title: string): void {
    this.node.title = title;
    this.titleSpan.textContent = title;
    this.titleSpan.title = title;
  }

  get sessionId(): string {
    return this.node.id;
  }

  get expanded(): boolean {
    return this.isExpanded;
  }

  setExpanded(expanded: boolean): void {
    if (this.isExpanded !== expanded) {
      this.toggle();
    }
  }

  // ── Children ──

  private renderChildren(): void {
    if (!this.childContainer) return;
    this.childContainer.innerHTML = '';
    this.childNodes = [];
    for (let i = 0; i < this.node.children.length; i++) {
      const child = this.node.children[i];
      const childNode = new SessionTreeNode(child, this.depth + 1);
      childNode.onSelect = this.onSelect;
      childNode.onRename = this.onRename;
      childNode.onDelete = this.onDelete;
      this.childNodes.push(childNode);
      this.childContainer.appendChild(childNode.element);
    }
  }

  get children(): SessionTreeNode[] {
    return this.childNodes;
  }

  setCallbacks(
    select: ((sessionId: string) => void) | null,
    rename: ((sessionId: string, newTitle: string) => void) | null,
    del: ((sessionId: string) => void) | null,
  ): void {
    this.onSelect = select;
    this.onRename = rename;
    this.onDelete = del;
    for (const child of this.childNodes) {
      child.setCallbacks(select, rename, del);
    }
  }
}
