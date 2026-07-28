// AnoClaw Cinema — RightEdgeBar: 48px info bar with lightweight utilities.
// Overview and Plan open compact panels. Context shows token usage.
// Context button: hover shows token breakdown tooltip, click triggers compact.

import type { TokenBreakdown } from '../../types.js';
import { App } from '../../app.js';
import { onLocaleChange, t } from '../../i18n/index.js';

const SVG_OVERVIEW = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
const SVG_PLAN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

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
    onLocaleChange(() => this._refreshLocale());
  }

  private _build(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cinema-edge-right';

    // Overview icon
    el.appendChild(this._makeIcon(SVG_OVERVIEW, t('right.overview'), 'overview'));

    // Plan icon
    el.appendChild(this._makeIcon(SVG_PLAN, t('right.plan'), 'plan'));

    // Context ring icon
    const ctxBtn = this._makeIcon('', t('right.context'), 'context', false);
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
    btn.setAttribute('aria-label', title);
    btn.setAttribute('data-panel', name);
    btn.innerHTML = svg;
    if (dispatchPanel) {
      btn.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('right-bar-click', { detail: { panel: name } }));
      });
    }
    return btn;
  }

  setContextPct(pct: number | null): void {
    if (this._contextText) {
      if (pct === null || !Number.isFinite(pct)) {
        this._contextText.textContent = '--';
        this._contextText.style.borderColor = 'var(--cinema-text-muted)';
        this._contextText.style.color = 'var(--cinema-text-muted)';
        return;
      }
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

    const pct = breakdown.total > 0 && breakdown.contextWindow > 0
      ? Math.round((breakdown.total / breakdown.contextWindow) * 100) : 0;

    const fmt = (n: number): string => {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
      return String(n);
    };
    const freeTokens = Math.max(0, breakdown.contextWindow - breakdown.total);

    tip.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;color:var(--color-text-primary);font-size:13px;">${t('context.usage')}</div>
      <div style="color:var(--color-text-secondary);margin-bottom:10px;font-size:12px;">${t('context.tokens', { used: fmt(breakdown.total), total: fmt(breakdown.contextWindow), percent: pct })}</div>
      <div style="display:flex;gap:1px;height:6px;border-radius:3px;overflow:hidden;margin-bottom:10px;">
        <div style="flex:${Math.max(breakdown.systemPrompt, 1)};background:var(--color-token-system-prompt);min-width:2px;" title="${t('context.systemPrompt')}"></div>
        <div style="flex:${Math.max(breakdown.systemTools, 1)};background:var(--color-token-system-tools);min-width:2px;" title="${t('context.systemTools')}"></div>
        <div style="flex:${Math.max(breakdown.skills, 1)};background:var(--color-token-skills);min-width:2px;" title="${t('context.skills')}"></div>
        <div style="flex:${Math.max(breakdown.messages, 1)};background:var(--color-token-messages);min-width:2px;" title="${t('context.messages')}"></div>
        <div style="flex:${Math.max(freeTokens, 1)};background:var(--color-token-free-space);min-width:2px;" title="${t('context.freeSpace')}"></div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        ${this._tipRow(t('context.systemPrompt'), 'var(--color-token-system-prompt)', fmt(breakdown.systemPrompt))}
        ${this._tipRow(t('context.systemTools'), 'var(--color-token-system-tools)', fmt(breakdown.systemTools))}
        ${this._tipRow(t('context.skills'), 'var(--color-token-skills)', fmt(breakdown.skills))}
        ${this._tipRow(t('context.messages'), 'var(--color-token-messages)', fmt(breakdown.messages))}
        ${this._tipRow(t('context.freeSpace'), 'var(--color-token-free-space)', fmt(freeTokens))}
      </table>
      <button class="context-compact-btn" style="width:100%;padding:6px;background:var(--color-surface-elevated);border:1px solid var(--color-hairline);border-radius:6px;color:var(--color-text-primary);cursor:pointer;font-family:var(--font-sans);font-size:12px;">${t('context.manualCompact')}</button>
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

  private _refreshLocale(): void {
    const titles: Record<string, string> = {
      overview: t('right.overview'),
      plan: t('right.plan'),
      context: t('right.context'),
    };
    this.element.querySelectorAll<HTMLElement>('[data-panel]').forEach((button) => {
      const panel = button.dataset.panel;
      if (panel && titles[panel]) {
        button.title = titles[panel];
        button.setAttribute('aria-label', titles[panel]);
      }
    });
    if (this._tooltip) {
      this.hideTooltip();
      this._showTooltip();
    }
  }
}
