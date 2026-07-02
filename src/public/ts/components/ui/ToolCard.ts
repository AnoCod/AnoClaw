// Shared UI: ToolCard — default tool execution card.
// Status dot + tool name + action phrase + duration + collapsible output.

export interface ToolCardState {
  toolName: string;
  toolInput: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
  durationMs?: number;
}

// Action phrase registry: verb + result-summary extractor per tool.
const TOOL_META: Record<string, { verb: string; result: (t: ToolCardState) => string | null }> = {
  Read:   { verb: 'read',   result: t => { const c = t.result || ''; if (c.length > 80) return `${c.split('\n').length} lines`; return c; } },
  Write:  { verb: 'wrote',  result: () => null },
  Edit:   { verb: 'edited', result: () => null },
  Grep:   { verb: 'searched', result: t => { const c = t.result || ''; return `${c.split('\n').filter(Boolean).length} matches`; } },
  Glob:   { verb: 'found',  result: t => `${(t.result || '').split('\n').filter(Boolean).length} files` },
  Bash:   { verb: 'ran',    result: t => { const c = (t.result || '').trim(); return c.length > 80 ? `${c.split('\n').length} lines` : c; } },
  WebSearch: { verb: 'searched', result: t => `${((t.result || '').match(/\[.+\]\(https?:\/\//g) || []).length} results` },
  WebFetch:  { verb: 'fetched',  result: t => `${(t.result || '').length} chars` },
  ApiCall:   { verb: 'called',   result: () => 'Done' },
  Skill:     { verb: 'used',   result: () => 'Done' },
  SkillList: { verb: 'listed', result: () => 'Done' },
  SkillInspect: { verb: 'inspected', result: () => 'Done' },
  memory_save:   { verb: 'saved',    result: () => 'Memory saved' },
  memory_search: { verb: 'searched', result: t => `${(t.result || '').split('\n').filter(Boolean).length} entries` },
  memory_delete: { verb: 'deleted',  result: () => 'Memory deleted' },
};

export class ToolCard {
  readonly element: HTMLElement;
  protected _expanded: boolean;
  protected _bodyEl: HTMLElement | null = null;
  protected _fullResult: string;
  protected _showMoreBtn: HTMLButtonElement | null = null;

  constructor(state: ToolCardState) {
    this._fullResult = state.result || '';
    this._expanded = state.status === 'running';
    this.element = this.render(state);
    this._injectKeyframes();
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
    action.textContent = this._actionText(s);
    indicator.appendChild(action);

    if (typeof s.durationMs === 'number' && s.durationMs > 0) {
      const dur = document.createElement('span');
      dur.className = 'ui-toolcard-dur';
      dur.textContent = `· ${s.durationMs >= 1000 ? `${(s.durationMs / 1000).toFixed(1)}s` : `${s.durationMs}ms`}`;
      indicator.appendChild(dur);
    }

    const hasBody = this._fullResult && this._fullResult.length > 0;
    if (hasBody) {
      indicator.classList.add('clickable');
      indicator.addEventListener('click', () => this._toggle());
    }

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
      btn.textContent = this._expanded ? 'Show less' : 'Show more';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggle();
        btn.textContent = this._expanded ? 'Show less' : 'Show more';
      });
      this._showMoreBtn = btn;
      const wrap = document.createElement('div');
      wrap.appendChild(body);
      wrap.appendChild(btn);
      return wrap as any;
    }

    return body;
  }

  protected _actionText(s: ToolCardState): string {
    const meta = TOOL_META[s.toolName] || { verb: s.toolName.toLowerCase().replace(/([A-Z])/g, ' $1').trim(), result: () => null as string | null };
    const subj = this._subject(s);
    return subj ? `${meta.verb} ${subj}` : meta.verb;
  }

  protected _subject(s: ToolCardState): string {
    const inp = s.toolInput;
    switch (s.toolName) {
      case 'Read': case 'Write': case 'Edit': return ((inp.file_path || inp.path || '') as string).replace(/\\/g, '/').split('/').pop() || 'file';
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
    this._expanded = !this._expanded;
    if (this._bodyEl) {
      if (this._expanded) { this._bodyEl.textContent = this._fullResult; this._bodyEl.hidden = false; }
      else { this._bodyEl.hidden = true; }
    }
    if (this._showMoreBtn) this._showMoreBtn.textContent = this._expanded ? 'Show less' : 'Show more';
  }

  private _injectKeyframes(): void {
    if (document.getElementById('tc-keyframes')) return;
    const s = document.createElement('style');
    s.id = 'tc-keyframes';
    s.textContent = '@keyframes tc-pulse{0%,100%{opacity:.3}50%{opacity:1}}';
    document.head.appendChild(s);
  }
}
