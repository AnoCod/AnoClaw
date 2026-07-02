/**
 * ToolActivityDelegate — compact tool card matching ThinkDelegate visual style.
 * Layout: pulse-dot · TOOLNAME · ran <subject> · X.Xs
 * Click to expand result body (always present when result is non-empty).
 *
 * States:
 *   running — animated pulse dot (ta-pulse keyframes), body auto-expanded
 *   success — static muted dot, body collapsed by default
 *   error   — dim-red dot, body collapsed by default
 *
 * Long results (>200 chars or >5 lines) show a truncated preview with a
 * "Show more" / "Show less" button below the collapsible body.
 */
import type { ToolCall } from '../types.js';

// Tool metadata registry: verb phrase + result-summary extractor for every known tool.
// Unknown tools get a generated verb from their camelCase name.
const TOOL: Record<string, { verb: string; result: (t: ToolActivityState) => string | null }> = {
  // ── File tools ──
  Read:   { verb: 'read',   result: t => { const c = t.result || ''; if (c.startsWith('[Image')) return 'Image file'; return `${c.split('\n').length} lines`; } },
  Write:  { verb: 'wrote',  result: t => { const c = t.result || ''; const m = c.match(/Successfully wrote (\d+) chars to (.+)/); const path = m?.[2]?.replace(/\\/g, '/').split('/').pop(); return `Wrote ${m?.[1] || '?'} chars` + (path ? ` → ${path}` : ''); } },
  Edit:   { verb: 'edited', result: () => null },
  Grep:   { verb: 'searched', result: t => { const c = t.result || ''; if (!c || c === '(no matches)') return 'No matches'; return `${c.split('\n').filter(Boolean).length} matches`; } },
  Glob:   { verb: 'found',  result: t => { const c = t.result || ''; if (!c || c === '(no matches)') return 'Nothing found'; return `${c.split('\n').filter(Boolean).length} files`; } },
  Bash:   { verb: 'ran',    result: t => { const c = (t.result || '').trim(); if (!c) return 'Done'; return c.length > 80 ? `${c.split('\n').length} lines output` : c; } },
  // ── Web tools ──
  WebSearch: { verb: 'searched', result: t => { const n = ((t.result || '').match(/\[.+\]\(https?:\/\//g) || []).length; return n ? `${n} results` : 'Done'; } },
  WebFetch:  { verb: 'fetched',  result: t => `Read ${(t.result || '').length} chars` },
  ApiCall:   { verb: 'called',   result: t => { const c = (t.result || '').trim(); return c ? `${c.length} chars response` : 'Done'; } },
  // ── Task/Agent tools ──
  Skill:         { verb: 'used',      result: t => { const c = (t.result || '').trim(); return c ? c.slice(0, 120) : 'Done'; } },
  SkillList:     { verb: 'listed',    result: t => { const n = (t.result || '').split('\n').filter(Boolean).length; return n ? `${n} skills` : 'Done'; } },
  SkillInspect:  { verb: 'inspected', result: t => { const c = (t.result || '').trim(); return c ? `${c.split('\n').length} lines` : 'Done'; } },
  TaskAssign:    { verb: 'assigned',  result: () => 'Task dispatched' },
  TaskList:      { verb: 'listed',    result: () => 'Tasks listed' },
  TaskStop:      { verb: 'stopped',   result: () => 'Task stopped' },
  TaskOutput:    { verb: 'read',      result: t => { const c = (t.result || '').trim(); return c ? `${c.split('\n').length} lines` : 'Done'; } },
  SubAgentSpawn: { verb: 'delegated', result: () => 'Sub-agent running' },
  SubAgentDelete:{ verb: 'removed',   result: () => 'Agent removed' },
  AgentMessage:  { verb: 'messaged',  result: t => { const c = (t.result || '').trim(); return c ? c.slice(0, 80) : 'Sent'; } },
  HireEmployee:  { verb: 'hired',     result: () => 'Employee created' },
  ListEmployees: { verb: 'listed',    result: () => 'Employees listed' },
  UpdateOrg:     { verb: 'updated',   result: () => 'Org chart updated' },
  // ── Memory tools ──
  memory_save:   { verb: 'saved',    result: () => 'Memory saved' },
  memory_search: { verb: 'searched', result: t => { const n = (t.result || '').split('\n').filter(Boolean).length; return n ? `${n} entries` : 'None found'; } },
  memory_delete: { verb: 'deleted',  result: () => 'Memory deleted' },
  // ── Misc tools ──
  NotebookEdit:  { verb: 'edited',   result: () => 'Cell edited' },
  RestartServer: { verb: 'restarted',result: () => 'Server restarted' },
  Sleep:         { verb: 'waited',   result: t => { const d = t.toolInput?.seconds || t.toolInput?.duration; return d ? `${d}s` : 'Done'; } },
  TodoWrite:     { verb: 'updated',  result: () => 'Todo updated' },
};

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

  /* ── main render ── */

  /** Build the card: dot indicator line + collapsible result body. */
  private render(s: ToolActivityState): HTMLElement {
    const wrapper = document.createElement('div');

    // ── Indicator line: dot · TOOLNAME · verb subject · duration ──
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
    sep.textContent = '·';
    sep.style.cssText = `opacity: 0.3;`;
    indicator.appendChild(sep);

    // Action phrase: "read foo.ts" or "searched pattern"
    const action = document.createElement('span');
    action.textContent = this._actionText(s);
    action.style.cssText = `letter-spacing: 0;`;
    indicator.appendChild(action);

    // Duration — only shown once the tool has completed
    if (typeof s.durationMs === 'number' && s.durationMs > 0) {
      const dur = document.createElement('span');
      dur.textContent = `· ${s.durationMs >= 1000 ? `${(s.durationMs / 1000).toFixed(1)}s` : `${s.durationMs}ms`}`;
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

    // ── Collapsible result body ──
    if (hasBody) {
      const isLong = this._fullResult.length > 200 || this._fullResult.split('\n').length > 5;

      // Truncate to 400 chars in collapsed state; full text when expanded
      const body = document.createElement('pre');
      body.textContent = isLong ? this._fullResult.slice(0, 400) : this._fullResult;
      body.style.cssText = `
        font-size: 12px; color: var(--cinema-text-tertiary);
        line-height: 1.6; padding: 8px 0; margin-bottom: 12px;
        white-space: pre-wrap; word-break: break-all;
        font-family: var(--font-mono, monospace);
        border-bottom: 1px solid var(--hairline-cinema, var(--cinema-bg-edge-icon));
        ${isLong && !this._expanded ? 'max-height: 60px; overflow: hidden;' : ''}
      `;
      body.hidden = !this._expanded;
      this._bodyEl = body;
      wrapper.appendChild(body);

      // Show more / less toggle button — only for long results
      if (isLong) {
        const btn = document.createElement('button');
        btn.textContent = this._expanded ? 'Show less' : 'Show more';
        btn.style.cssText = `
          display: block; width: 100%; padding: 2px 0 0; margin: 0;
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
    }
  }

  /* ── helpers ── */

  /** Look up tool metadata; unknown tools get a camelCase → space-separated verb. */
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
    const id = 'ta-styles';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      @keyframes ta-pulse {
        0%, 100% { opacity: 0.3; }
        50% { opacity: 1; }
      }
    `;
    document.head.appendChild(s);
  }
}
