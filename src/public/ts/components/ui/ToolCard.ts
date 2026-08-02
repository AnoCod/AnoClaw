// Shared UI: ToolCard — default tool execution card.
// Status dot + tool name + action phrase + duration + collapsible output.

import { onLocaleChange, refreshLocalizedElements, t, type TranslationKey } from '../../i18n/index.js';
import { TOOL_REGISTRY } from '../conversation/delegates/ToolRegistry.js';

export interface ToolCardState {
  toolName: string;
  toolInput: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
  durationMs?: number;
}

export class ToolCard {
  readonly element: HTMLElement;
  protected _expanded: boolean;
  protected _bodyEl: HTMLElement | null = null;
  protected _fullResult: string;
  protected _showMoreBtn: HTMLButtonElement | null = null;
  protected _state: ToolCardState;
  private _stopLocaleListener: (() => void) | null = null;

  constructor(state: ToolCardState) {
    this._state = state;
    this._fullResult = state.result || '';
    this._expanded = state.status === 'running';
    this.element = this.render(state);
    if (!this._expanded) this.collapse();
    this._injectKeyframes();
    this._stopLocaleListener = onLocaleChange(() => refreshLocalizedElements(this.element));
  }

  protected render(s: ToolCardState): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ui-toolcard';

    // Indicator line
    const indicator = this._buildIndicator(s);
    wrapper.appendChild(indicator);

    // Collapsible result body
    const hasBody = this._fullResult && this._fullResult.length > 0;
    if (hasBody) {
      wrapper.appendChild(this._buildBody());
    }

    return wrapper;
  }

  protected _buildIndicator(s: ToolCardState): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'ui-toolcard-indicator';

    const dot = document.createElement('span');
    dot.className = `ui-toolcard-dot ${s.status}`;
    indicator.appendChild(dot);

    const badge = document.createElement('span');
    badge.className = 'ui-toolcard-name';
    badge.textContent = s.toolName.toUpperCase();
    indicator.appendChild(badge);

    const sep = document.createElement('span');
    sep.className = 'ui-toolcard-sep';
    sep.textContent = '·';
    indicator.appendChild(sep);

    const action = document.createElement('span');
    action.className = 'ui-toolcard-action';
    const actionKey = this._actionKey(s);
    const params = { subject: this._subject(s) };
    action.textContent = t(actionKey, params).trim();
    action.dataset.i18nKey = actionKey;
    action.dataset.i18nParams = JSON.stringify(params);
    indicator.appendChild(action);

    if (typeof s.durationMs === 'number' && s.durationMs > 0) {
      const dur = document.createElement('span');
      dur.className = 'ui-toolcard-dur';
      dur.textContent = `· ${s.durationMs >= 1000 ? `${(s.durationMs / 1000).toFixed(1)}s` : `${s.durationMs}ms`}`;
      indicator.appendChild(dur);
    }

    indicator.classList.add('clickable');
    indicator.addEventListener('click', () => this._toggle());

    return indicator;
  }

  protected _buildBody(): HTMLElement {
    const isLong = this._fullResult.length > 200 || this._fullResult.split('\n').length > 5;
    const body = document.createElement('pre');
    body.className = 'ui-toolcard-body';
    body.textContent = isLong ? this._fullResult.slice(0, 400) : this._fullResult;
    if (isLong && !this._expanded) body.style.cssText += 'max-height:60px;overflow:hidden;';
    body.hidden = !this._expanded;
    this._bodyEl = body;

    if (isLong) {
      const btn = document.createElement('button');
      btn.className = 'ui-toolcard-more';
      this._setMoreButtonLabel(btn);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggle();
        this._setMoreButtonLabel(btn);
      });
      this._showMoreBtn = btn;
      const wrap = document.createElement('div');
      wrap.appendChild(body);
      wrap.appendChild(btn);
      return wrap as any;
    }

    return body;
  }

  protected _actionKey(state: ToolCardState): TranslationKey {
    const action = String(state.toolInput.action || '');
    if (state.toolName === 'Organization') {
      return ({
        list: 'message.tool.action.list',
        hire: 'message.tool.action.create',
        reassign: 'message.tool.action.assign',
      } as Record<string, TranslationKey>)[action] || 'message.tool.action.manage';
    }
    if (state.toolName === 'Team') {
      return ({
        create: 'message.tool.action.create',
        update: 'message.tool.action.update',
        status: 'message.tool.action.inspect',
        delete: 'message.tool.action.disband',
      } as Record<string, TranslationKey>)[action] || 'message.tool.action.manage';
    }
    if (state.toolName === 'Task') {
      return ({
        create: 'message.tool.action.create',
        assign: 'message.tool.action.assign',
        claim: 'message.tool.action.claim',
        update: 'message.tool.action.update',
        list: 'message.tool.action.list',
        output: 'message.tool.action.read',
        stop: 'message.tool.action.stop',
        spawn: 'message.tool.action.spawn',
      } as Record<string, TranslationKey>)[action] || 'message.tool.action.manage';
    }
    return TOOL_REGISTRY[state.toolName]?.actionKey || 'message.tool.action.use';
  }

  protected _subject(s: ToolCardState): string {
    const inp = s.toolInput;
    switch (s.toolName) {
      case 'Read': case 'Write': case 'Edit': return ((inp.file_path || inp.path || '') as string).replace(/\\/g, '/').split('/').pop() || '';
      case 'Grep': return ((inp.pattern || inp.query || '') as string).slice(0, 40);
      case 'Glob': return ((inp.pattern || '') as string).slice(0, 30);
      case 'Bash': return ((inp.command || '') as string).slice(0, 50);
      case 'WebSearch': return ((inp.query || '') as string).slice(0, 40);
      case 'WebFetch': case 'ApiCall': { const u = (inp.url || '') as string; try { return new URL(u).hostname; } catch { return u.slice(0, 30); } }
      case 'Skill': case 'SkillInspect': return ((inp.skill || inp.name || '') as string).slice(0, 30);
      default: return '';
    }
  }

  protected _toggle(): void {
    if (this._expanded) this.collapse();
    else this.expand();
  }

  collapse(): void {
    this._expanded = false;
    this.element.classList.add('is-collapsed');
    for (const child of Array.from(this.element.children) as HTMLElement[]) {
      if (!child.classList.contains('ui-toolcard-indicator')) child.hidden = true;
    }
    if (this._bodyEl) this._bodyEl.hidden = true;
    if (this._showMoreBtn) {
      this._setMoreButtonLabel(this._showMoreBtn);
      this._showMoreBtn.hidden = true;
    }
  }

  expand(): void {
    this._expanded = true;
    this.element.classList.remove('is-collapsed');
    for (const child of Array.from(this.element.children) as HTMLElement[]) child.hidden = false;
    if (this._bodyEl) {
      this._bodyEl.textContent = this._fullResult;
      this._bodyEl.hidden = false;
      this._bodyEl.style.maxHeight = 'none';
      this._bodyEl.style.overflow = 'visible';
    }
    if (this._showMoreBtn) {
      this._setMoreButtonLabel(this._showMoreBtn);
      this._showMoreBtn.hidden = false;
    }
  }

  dispose(): void {
    this._stopLocaleListener?.();
    this._stopLocaleListener = null;
  }

  private _setMoreButtonLabel(button: HTMLButtonElement): void {
    const key = this._expanded ? 'message.showLess' : 'message.showDetails';
    button.textContent = t(key);
    button.dataset.i18nKey = key;
  }

  private _injectKeyframes(): void {
    if (document.getElementById('tc-keyframes')) return;
    const s = document.createElement('style');
    s.id = 'tc-keyframes';
    s.textContent = '@keyframes tc-pulse{0%,100%{opacity:.3}50%{opacity:1}}';
    document.head.appendChild(s);
  }
}
