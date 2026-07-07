// AnoClaw Cinema — RightEdgeBar: 48px info bar with overfly panels
// Files, Overview, Plan, Context ring icons. Click opens overfly panel or dispatches event.
// Context button: hover shows token breakdown tooltip, click triggers compact.

import type { TokenBreakdown } from '../../types.js';
import { App } from '../../app.js';
import { pageRegistry } from '../../PageRegistry.js';

const SVG_FILES = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const SVG_ARTIFACTS = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>`;
const SVG_OVERVIEW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
const SVG_PLAN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>`;
const SVG_TASKS = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="6" width="8" height="8" rx="1"/><path d="M12 6V3h0.5"/><circle cx="14" cy="3" r="1.5"/><path d="M3 10h2"/><path d="M3 14h2"/></svg>`;

interface RightBarCallbacks {
  onCompactRequest: () => void;
}

export class RightEdgeBar {
  readonly element: HTMLElement;
  private _callbacks: RightBarCallbacks;
  private _contextText: HTMLElement | null = null;
  private _tooltip: HTMLElement | null = null;
  private _hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: RightBarCallbacks) {
    this._callbacks = callbacks;
    this.element = this._build();
  }

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cinema-edge-right';

    // Files icon with badge — navigates to Workspace page
    const filesBtn = this._makeIcon(SVG_FILES, 'Files', 'files', false);
    filesBtn.addEventListener('click', (e) => { e.stopPropagation(); pageRegistry.navigateTo('workspace'); });
    el.appendChild(filesBtn);

    el.appendChild(this._makeIcon(SVG_ARTIFACTS, 'Artifacts', 'artifacts'));

    // Overview icon
    el.appendChild(this._makeIcon(SVG_OVERVIEW, 'Overview', 'overview'));

    // Plan icon
    el.appendChild(this._makeIcon(SVG_PLAN, 'Plan', 'plan'));

    // Tasks icon
    el.appendChild(this._makeIcon(SVG_TASKS, 'Tasks', 'tasks'));

    // Context ring icon
    const ctxBtn = this._makeIcon('', 'Context', 'context', false);
    this._contextText = document.createElement('span');
    this._contextText.className = 'cinema-edge-ctx-text';
    this._contextText.style.cssText = `
      width:18px;height:18px;border-radius:50%;
      border:1.5px solid var(--cinema-text-muted);
      display:flex;align-items:center;justify-content:center;
      font-size:7px;color:var(--cinema-text-muted);
    `;
    this._contextText.textContent = '--';
    ctxBtn.appendChild(this._contextText);
    ctxBtn.addEventListener('click', () => {
      // Toggle tooltip on click — shows token breakdown with compact button inside
      if (this._tooltip) {
        this.hideTooltip();
      } else {
        this._showTooltip();
      }
    });
    ctxBtn.addEventListener('mouseenter', () => {
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
      this._showTooltip();
    });
    ctxBtn.addEventListener('mouseleave', () => {
      this._hideTimer = setTimeout(() => this.hideTooltip(), 150);
    });
    el.appendChild(ctxBtn);

    return el;
  }

  private _makeIcon(svg: string, title: string, name: string, dispatchPanel = true): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'cinema-edge-icon';
    btn.title = title;
    btn.setAttribute('data-panel', name);
    btn.innerHTML = svg;
    if (dispatchPanel) {
      btn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('right-bar-click', { detail: { panel: name } }));
      });
    }
    return btn;
  }

  setFileCount(n: number): void {
    void n;
  }

  setContextPct(pct: number): void {
    if (this._contextText) {
      this._contextText.textContent = String(Math.round(pct));
      if (pct > 80) {
        this._contextText.style.borderColor = 'var(--color-warning, #ffc533)';
        this._contextText.style.color = 'var(--color-warning, #ffc533)';
      } else {
        this._contextText.style.borderColor = 'var(--cinema-text-muted)';
        this._contextText.style.color = 'var(--cinema-text-muted)';
      }
    }
  }

  /** Set active panel highlight on edge icons. null clears all. */
  setActivePanel(panel: string | null): void {
    this.element.querySelectorAll('.cinema-edge-icon').forEach(icon => {
      const name = icon.getAttribute('data-panel');
      if (name && panel && name === panel) {
        icon.classList.add('active');
      } else {
        icon.classList.remove('active');
      }
    });
  }

  /** Show the detailed token breakdown tooltip popover. */
  private _showTooltip(): void {
    if (this._tooltip) return;
    const convVM = App.getInstance().conversationVM;
    const sessionVM = App.getInstance().sessionVM;
    const sid = sessionVM.activeSessionId;
    const agent = sid ? convVM.getAgent(sid) : null;
    const breakdown = agent?.state.tokenBreakdown || {
      systemPrompt: 0, systemTools: 0, skills: 0, messages: 0,
      total: 0, contextWindow: 200000,
    };
    const tip = this._buildTooltip(breakdown);
    this._tooltip = tip;

    // Append to DOM first (hidden) so measurements are reliable
    tip.style.visibility = 'hidden';
    document.body.appendChild(tip);

    // Position: anchored to context button, auto-flip to stay inside viewport
    const anchor = this._contextText;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const gap = 8;

      // Default: below anchor, right-aligned
      tip.style.top = `${rect.bottom + gap}px`;
      tip.style.bottom = 'auto';
      tip.style.left = `${rect.right - tipRect.width}px`;

      // Re-measure after first-position (layout forced)
      const r2 = tip.getBoundingClientRect();

      // Vertical: if bottom overflows → flip above
      if (r2.bottom > window.innerHeight - gap) {
        tip.style.top = 'auto';
        tip.style.bottom = `${window.innerHeight - rect.top + gap}px`;
      }
      // Vertical: if top still overflows after flip → clamp to gap
      const r3 = tip.getBoundingClientRect();
      if (r3.top < gap) tip.style.top = `${gap}px`;

      // Horizontal: clamp within viewport
      const r4 = tip.getBoundingClientRect();
      if (r4.left < gap) tip.style.left = `${gap}px`;
      else if (r4.right > window.innerWidth - gap) tip.style.left = `${window.innerWidth - r4.width - gap}px`;
    }

    tip.style.visibility = 'visible';

    tip.addEventListener('mouseenter', () => {
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    });
    tip.addEventListener('mouseleave', () => this.hideTooltip());
  }

  /** Hide and remove the tooltip. Public so SessionsPage.onExit() can clean up. */
  hideTooltip(): void {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    if (this._tooltip) {
      this._tooltip.remove();
      this._tooltip = null;
    }
  }

  /** Build the detailed tooltip DOM — no positioning (done in _showTooltip after append). */
  private _buildTooltip(breakdown: TokenBreakdown): HTMLElement {
    const tip = document.createElement('div');
    tip.className = 'context-tooltip-popover';

    const pct = breakdown.total > 0
      ? Math.round((breakdown.total / breakdown.contextWindow) * 100) : 0;

    const fmt = (n: number): string => {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
      return String(n);
    };
    const freeTokens = Math.max(0, breakdown.contextWindow - breakdown.total);

    tip.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;color:var(--color-text-primary);font-size:13px;">Context Usage</div>
      <div style="color:var(--color-text-secondary);margin-bottom:10px;font-size:12px;">${fmt(breakdown.total)} / ${fmt(breakdown.contextWindow)} tokens (${pct}%)</div>
      <div style="display:flex;gap:1px;height:6px;border-radius:3px;overflow:hidden;margin-bottom:10px;">
        <div style="flex:${Math.max(breakdown.systemPrompt, 1)};background:var(--color-token-system-prompt);min-width:2px;" title="System Prompt"></div>
        <div style="flex:${Math.max(breakdown.systemTools, 1)};background:var(--color-token-system-tools);min-width:2px;" title="System Tools"></div>
        <div style="flex:${Math.max(breakdown.skills, 1)};background:var(--color-token-skills);min-width:2px;" title="Skills"></div>
        <div style="flex:${Math.max(breakdown.messages, 1)};background:var(--color-token-messages);min-width:2px;" title="Messages"></div>
        <div style="flex:${Math.max(freeTokens, 1)};background:var(--color-token-free-space);min-width:2px;" title="Free space"></div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        ${this._tipRow('System Prompt', 'var(--color-token-system-prompt)', fmt(breakdown.systemPrompt))}
        ${this._tipRow('System Tools', 'var(--color-token-system-tools)', fmt(breakdown.systemTools))}
        ${this._tipRow('Skills', 'var(--color-token-skills)', fmt(breakdown.skills))}
        ${this._tipRow('Messages', 'var(--color-token-messages)', fmt(breakdown.messages))}
        ${this._tipRow('Free Space', 'var(--color-token-free-space)', fmt(freeTokens))}
      </table>
      <button class="context-compact-btn" style="width:100%;padding:6px;background:var(--color-surface-elevated);border:1px solid var(--color-hairline);border-radius:6px;color:var(--color-text-primary);cursor:pointer;font-family:var(--font-sans);font-size:12px;">Manual Compact</button>
    `;

    const compactBtn = tip.querySelector('.context-compact-btn');
    if (compactBtn) {
      compactBtn.addEventListener('click', () => {
        this.hideTooltip();
        this._callbacks.onCompactRequest();
      });
    }

    return tip;
  }

  private _tipRow(label: string, color: string, value: string): string {
    return `<tr><td style="padding:3px 4px;display:flex;align-items:center;gap:6px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></span>${label}</td><td style="text-align:right;padding:3px 4px;color:var(--color-text-primary);">${value}</td></tr>`;
  }
}
