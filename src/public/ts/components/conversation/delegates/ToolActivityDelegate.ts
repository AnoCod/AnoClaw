
import type { ToolCall } from '../types.js';
import { injectStyle } from '../../../utils/domUtils.js';
import { TOOL_REGISTRY as TOOL } from './ToolRegistry.js';
export interface ToolActivityState {
  toolName: string;
  toolInput: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  result?: string;
  durationMs?: number;
}

export class ToolActivityDelegate {
  element: HTMLElement;
  private _expanded: boolean = false;
  private _bodyEl: HTMLElement | null = null;
  private _fullResult: string = '';
  private _showMoreBtn: HTMLButtonElement | null = null;

  constructor(state: ToolActivityState) {
    this._fullResult = state.result || '';
    // Running tools start expanded so the user sees live output
    this._expanded = state.status === 'running';
    this.element = this.render(state);
    this._injectStyles();   // one-time keyframe injection
  }

  /** Update in-place: refresh dot animation, duration, result body, and expand/collapse. */
  update(state: ToolActivityState): void {
    this._fullResult = state.result || '';
    this.element.classList.toggle('tool-activity-inline--running', state.status === 'running');
    this.element.classList.toggle('tool-activity-inline--success', state.status === 'success');
    this.element.classList.toggle('tool-activity-inline--error', state.status === 'error');
    if (state.status !== 'running') this._expanded = false;
    // Update dot animation
    const dot = this.element.querySelector('span') as HTMLElement | null;
    if (dot) {
      dot.style.background = state.status === 'running'
        ? 'var(--cinema-text-welcome)'
        : state.status === 'error'
          ? 'rgba(255,130,130,0.4)'
          : 'var(--cinema-text-muted)';
      dot.style.animation = state.status === 'running'
        ? 'ta-pulse 2s ease-in-out infinite'
        : 'none';
    }
    // Update body content
    if (this._bodyEl && state.result) {
      const isLong = state.result.length > 200 || state.result.split('\n').length > 5;
      this._bodyEl.textContent = this._expanded ? state.result : (isLong ? state.result.slice(0, 400) : state.result);
      this._bodyEl.hidden = !this._expanded;
      if (this._showMoreBtn) this._showMoreBtn.style.display = this._expanded ? 'block' : 'none';
    }
  }



  /** Build the card: dot indicator line + collapsible result body. */
  private render(s: ToolActivityState): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'tool-activity-inline tool-activity-inline--' + s.status;
    wrapper.dataset.toolName = s.toolName;


    const indicator = document.createElement('div');
    indicator.style.cssText = `
      font-size: 9px; color: var(--cinema-text-muted); letter-spacing: 1px;
      display: flex; gap: 6px; align-items: center;
      user-select: none; margin-bottom: 12px;
    `;

    // Dot colour encodes status: warm-white (running), muted (done), dim-red (error)
    const dot = document.createElement('span');
    dot.style.cssText = `
      width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0;
      background: ${s.status === 'running' ? 'var(--cinema-text-welcome)' : s.status === 'error' ? 'rgba(255,130,130,0.4)' : 'var(--cinema-text-muted)'};
      animation: ${s.status === 'running' ? 'ta-pulse 2s ease-in-out infinite' : 'none'};
    `;
    indicator.appendChild(dot);

    // Tool name in highlight colour
    const badge = document.createElement('span');
    badge.textContent = s.toolName.toUpperCase();
    badge.style.cssText = `color: var(--cinema-text-welcome);`;
    indicator.appendChild(badge);

    // Separator
    const sep = document.createElement('span');
    sep.textContent = '-';
    sep.style.cssText = `opacity: 0.3;`;
    indicator.appendChild(sep);

    // Action phrase: "read foo.ts" or "searched pattern"
    const action = document.createElement('span');
    action.textContent = this._actionText(s);
    action.style.cssText = `letter-spacing: 0;`;
    indicator.appendChild(action);


    if (typeof s.durationMs === 'number' && s.durationMs > 0) {
      const dur = document.createElement('span');
      dur.textContent = `- ${s.durationMs >= 1000 ? `${(s.durationMs / 1000).toFixed(1)}s` : `${s.durationMs}ms`}`;
      dur.style.cssText = `opacity: 0.5;`;
      indicator.appendChild(dur);
    }

    // Make entire indicator line clickable to toggle the body (if there is one)
    const hasBody = this._fullResult && this._fullResult.length > 0;
    if (hasBody) {
      indicator.style.cursor = 'pointer';
      indicator.addEventListener('mouseenter', () => { indicator.style.color = 'var(--cinema-text-tertiary)'; });
      indicator.addEventListener('mouseleave', () => { indicator.style.color = 'var(--cinema-text-muted)'; });
      indicator.addEventListener('click', () => this._toggle());
    }

    wrapper.appendChild(indicator);


    if (hasBody) {
      const isLong = this._fullResult.length > 200 || this._fullResult.split('\n').length > 5;

      // Truncate to 400 chars in collapsed state; full text when expanded
      const body = document.createElement('pre');
      body.className = 'tool-activity-output';
      body.textContent = isLong ? this._fullResult.slice(0, 400) : this._fullResult;
      body.style.cssText = `
        font-size: 12px; color: var(--cinema-text-tertiary);
        line-height: 1.6; padding: 10px 12px; margin: 6px 0 12px;
        white-space: pre-wrap; word-break: break-all;
        font-family: var(--font-mono, monospace);
        background: var(--raycast-card-fill, rgba(255,255,255,0.034));
        border: 1px solid rgba(255,255,255,0.055);
        border-radius: var(--raycast-radius-control, 8px);
        box-shadow: none;
        ${isLong && !this._expanded ? 'max-height: 72px; overflow: hidden;' : ''}
      `;
      body.hidden = !this._expanded;
      this._bodyEl = body;
      wrapper.appendChild(body);


      if (isLong) {
        const btn = document.createElement('button');
        btn.textContent = this._expanded ? 'Show less' : 'Show more';
        btn.style.cssText = `
          display: ${this._expanded ? 'block' : 'none'}; width: 100%; padding: 2px 0 0; margin: 0;
          background: none; border: none; color: var(--cinema-text-muted);
          cursor: pointer; font-size: 9px; font-family: var(--font-sans);
          letter-spacing: 1px; text-align: center;
        `;
        btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--cinema-text-tertiary)'; });
        btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--cinema-text-muted)'; });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggle();
          btn.textContent = this._expanded ? 'Show less' : 'Show more';
        });
        this._showMoreBtn = btn;
        wrapper.appendChild(btn);
      }
    }

    return wrapper;
  }

  /** Build the action phrase: verb + subject. */
  private _actionText(s: ToolActivityState): string {
    const verb = this._meta(s.toolName).verb;
    const subj = this._subject(s);
    return subj ? `${verb} ${subj}` : `${verb}`;
  }

  /** Toggle body visibility: show full result when expanded, hide when collapsed. */
  private _toggle(): void {
    this._expanded = !this._expanded;
    if (this._bodyEl) {
      if (this._expanded) {
        this._bodyEl.textContent = this._fullResult;
        this._bodyEl.style.maxHeight = 'none';
        this._bodyEl.style.overflow = 'visible';
        this._bodyEl.hidden = false;
      } else {
        this._bodyEl.hidden = true;
      }
    }
    if (this._showMoreBtn) {
      this._showMoreBtn.textContent = this._expanded ? 'Show less' : 'Show more';
      this._showMoreBtn.style.display = this._expanded ? 'block' : 'none';
    }
  }

  collapse(): void {
    this._expanded = false;
    if (this._bodyEl) this._bodyEl.hidden = true;
    if (this._showMoreBtn) {
      this._showMoreBtn.textContent = 'Show more';
      this._showMoreBtn.style.display = 'none';
    }
  }

  expand(): void {
    this._expanded = true;
    if (this._bodyEl) {
      this._bodyEl.textContent = this._fullResult;
      this._bodyEl.style.maxHeight = 'none';
      this._bodyEl.style.overflow = 'visible';
      this._bodyEl.hidden = false;
    }
    if (this._showMoreBtn) {
      this._showMoreBtn.textContent = 'Show less';
      this._showMoreBtn.style.display = 'block';
    }
  }



  private _meta(name: string) {
    return TOOL[name] || { verb: name.toLowerCase().replace(/([A-Z])/g, ' $1').trim(), result: () => null as string | null };
  }

  /** Extract a human-readable subject from the tool input. */
  private _subject(s: ToolActivityState): string {
    const inp = s.toolInput;
    switch (s.toolName) {
      case 'Read':
      case 'Write':
      case 'Edit': {
        const p = (inp.file_path || inp.path || '') as string;
        return p.replace(/\\/g, '/').split('/').pop() || p || 'file';
      }
      case 'Grep':        return ((inp.pattern || inp.query || '') as string).slice(0, 40) || 'pattern';
      case 'Glob':        return ((inp.pattern || '') as string).slice(0, 30) || 'files';
      case 'Bash':        return ((inp.command || '') as string).slice(0, 50) || 'command';
      case 'WebSearch':   return ((inp.query || '') as string).slice(0, 40) || 'query';
      case 'WebFetch':
      case 'ApiCall': {
        const url = (inp.url || '') as string;
        try { return new URL(url).hostname; } catch { return (url || 'URL').slice(0, 30); }
      }
      case 'Skill':        return ((inp.skill || inp.name || '') as string).slice(0, 30) || 'skill';
      case 'SkillInspect': return ((inp.skill || inp.name || '') as string).slice(0, 30) || 'skill';
      case 'SkillList':    return 'skills';
      case 'TaskAssign':   return ((inp.agentName || inp.agentId || '') as string).slice(0, 20) || 'agent';
      case 'TaskList':     return 'tasks';
      case 'TaskStop':     return ((inp.task_id || '') as string).slice(0, 20) || 'task';
      case 'TaskOutput':   return ((inp.task_id || '') as string).slice(0, 20) || 'task';
      case 'SubAgentSpawn':return ((inp.subagent_type || '') as string).slice(0, 20) || 'sub-agent';
      case 'SubAgentDelete': return ((inp.agentId || inp.subAgentId || '') as string).slice(0, 20) || 'agent';
      case 'AgentMessage': return ((inp.subAgentName || inp.to || '') as string).slice(0, 20) || 'agent';
      case 'HireEmployee': return ((inp.name || inp.employeeName || '') as string).slice(0, 20) || 'employee';
      case 'ListEmployees': return 'employees';
      case 'UpdateOrg':    return 'org chart';
      case 'memory_save':   return ((inp.key || inp.name || '') as string).slice(0, 30) || 'memory';
      case 'memory_search': return ((inp.query || '') as string).slice(0, 40) || 'memory';
      case 'memory_delete': return ((inp.key || inp.name || '') as string).slice(0, 30) || 'memory';
      case 'NotebookEdit': {
        const nbPath = (inp.notebook_path || '') as string;
        return nbPath.replace(/\\/g, '/').split('/').pop() || 'notebook';
      }
      case 'Sleep':        return `${(inp.seconds || inp.duration || '?')}s`;
      case 'RestartServer': return 'server';
      case 'TodoWrite':    return 'todo';
      default:             return '';
    }
  }

  /** Inject ta-pulse keyframes once into document head. */
  private _injectStyles(): void {
    injectStyle('ta-styles', `
      @keyframes ta-pulse {
        0%, 100% { opacity: 0.3; }
        50% { opacity: 1; }
      }
    `);
  }
}

