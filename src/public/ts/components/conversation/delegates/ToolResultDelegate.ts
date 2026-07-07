/**
 * ToolResultDelegate - structured Raycast-style tool result card.
 * Completed tools render as one card with a typed header, summary, details, and output.
 */

import type { ToolResultData } from '../types.js';
import { generateToolResultSummary } from './ToolResultSummary.js';

type ToolTone = 'file' | 'shell' | 'web' | 'api' | 'agent' | 'skill' | 'plan' | 'memory' | 'browser' | 'generic';

interface ToolVisualMeta {
  label: string;
  category: string;
  tone: ToolTone;
}

const FRIENDLY_NAMES: Record<string, string> = {
  Bash: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  TodoWrite: 'Todo',
  WebSearch: 'Web Search',
  WebFetch: 'Web Fetch',
  ApiCall: 'API Call',
  Browser: 'Browser',
  TaskAssign: 'Task Assign',
  TaskList: 'Task List',
  TaskStop: 'Task Stop',
  TaskOutput: 'Task Output',
  Skill: 'Skill',
  SkillInspect: 'Skill Inspect',
  SkillList: 'Skill List',
  memory_save: 'Memory Save',
  memory_search: 'Memory Search',
  memory_delete: 'Memory Delete',
  NotebookEdit: 'Notebook Edit',
  AskUserQuestion: 'Ask User',
  SubAgentSpawn: 'Sub-Agent Spawn',
  SubAgentDelete: 'Sub-Agent Delete',
  AgentMessage: 'Agent Message',
  EnterPlanMode: 'Plan Enter',
  ExitPlanMode: 'Plan Exit',
  Sleep: 'Sleep',
  MCPTool: 'MCP Tool',
  MCPReadResource: 'MCP Read',
  MCPListResources: 'MCP List',
  GatewaySend: 'Gateway Send',
  GatewayStatus: 'Gateway Status',
  UpdateOrg: 'Update Org',
  HireEmployee: 'Hire Employee',
  ListEmployees: 'List Employees',
};

const TOOL_META: Record<string, ToolVisualMeta> = {
  Read: { label: 'READ', category: 'File', tone: 'file' },
  Write: { label: 'WRITE', category: 'File', tone: 'file' },
  Edit: { label: 'EDIT', category: 'File', tone: 'file' },
  Grep: { label: 'GREP', category: 'Search', tone: 'file' },
  Glob: { label: 'GLOB', category: 'Search', tone: 'file' },
  Bash: { label: 'BASH', category: 'Shell', tone: 'shell' },
  WebSearch: { label: 'SEARCH', category: 'Web', tone: 'web' },
  WebFetch: { label: 'FETCH', category: 'Web', tone: 'web' },
  Browser: { label: 'BROWSER', category: 'Browser', tone: 'browser' },
  ApiCall: { label: 'API', category: 'API', tone: 'api' },
  TaskAssign: { label: 'TASK', category: 'Delegation', tone: 'agent' },
  TaskList: { label: 'TASKS', category: 'Delegation', tone: 'agent' },
  TaskStop: { label: 'STOP', category: 'Delegation', tone: 'agent' },
  TaskOutput: { label: 'OUTPUT', category: 'Delegation', tone: 'agent' },
  SubAgentSpawn: { label: 'SPAWN', category: 'Agent', tone: 'agent' },
  SubAgentDelete: { label: 'DELETE', category: 'Agent', tone: 'agent' },
  AgentMessage: { label: 'MESSAGE', category: 'Agent', tone: 'agent' },
  HireEmployee: { label: 'HIRE', category: 'Org', tone: 'agent' },
  ListEmployees: { label: 'ORG', category: 'Org', tone: 'agent' },
  UpdateOrg: { label: 'ORG', category: 'Org', tone: 'agent' },
  Skill: { label: 'SKILL', category: 'Skill', tone: 'skill' },
  SkillInspect: { label: 'INSPECT', category: 'Skill', tone: 'skill' },
  SkillList: { label: 'SKILLS', category: 'Skill', tone: 'skill' },
  TodoWrite: { label: 'TODO', category: 'Planning', tone: 'plan' },
  Sleep: { label: 'WAIT', category: 'Planning', tone: 'plan' },
  EnterPlanMode: { label: 'PLAN', category: 'Planning', tone: 'plan' },
  ExitPlanMode: { label: 'PLAN', category: 'Planning', tone: 'plan' },
  memory_save: { label: 'SAVE', category: 'Memory', tone: 'memory' },
  memory_search: { label: 'SEARCH', category: 'Memory', tone: 'memory' },
  memory_delete: { label: 'DELETE', category: 'Memory', tone: 'memory' },
  NotebookEdit: { label: 'NOTEBOOK', category: 'Notebook', tone: 'file' },
  MCPTool: { label: 'MCP', category: 'MCP', tone: 'api' },
  MCPReadResource: { label: 'MCP', category: 'MCP', tone: 'api' },
  MCPListResources: { label: 'MCP', category: 'MCP', tone: 'api' },
  GatewaySend: { label: 'GATEWAY', category: 'Gateway', tone: 'api' },
  GatewayStatus: { label: 'GATEWAY', category: 'Gateway', tone: 'api' },
};

export class ToolResultDelegate {
  element: HTMLElement;
  private event: ToolResultData;
  private isExpanded: boolean;
  private contentDiv!: HTMLElement;
  private contentWrapper!: HTMLElement;
  private expandBtn: HTMLButtonElement | null;
  private fullContent: string;
  private truncatedLength: number;

  constructor(event: ToolResultData) {
    this.event = event;
    this.isExpanded = false;
    this.expandBtn = null;
    this.fullContent = event.content || '';
    this.truncatedLength = 700;

    if (!this.event.summary) {
      this.event.summary = generateToolResultSummary(this.event);
    }

    this.element = this.render();
  }

  private get userFacingName(): string {
    return FRIENDLY_NAMES[this.event.toolName] || this.event.toolName;
  }

  private get meta(): ToolVisualMeta {
    return TOOL_META[this.event.toolName] || {
      label: this.event.toolName.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase().slice(0, 14),
      category: 'Tool',
      tone: 'generic',
    };
  }

  private get input(): Record<string, unknown> {
    return (this.event.toolInput || {}) as Record<string, unknown>;
  }

  private hasExpandableDetails(): boolean {
    return Boolean(
      this.fullContent.trim()
      || (this.event.summary || '').trim()
      || this._detailRows().length > 0
      || this._knownIssueCopy()
    );
  }

  private needsOutputExpansion(): boolean {
    return this.fullContent.length > this.truncatedLength || this.fullContent.split('\n').length > 10;
  }

  render(): HTMLElement {
    const meta = this.meta;
    const card = document.createElement('div');
    card.className = 'delegate-tool-result tool-result-card tool-result-card--' + meta.tone + (this.event.isError ? ' is-error' : ' is-success') + (this.hasExpandableDetails() ? ' is-expandable is-collapsed' : '');
    card.dataset.toolName = this.event.toolName;

    card.appendChild(this._buildHeader());

    const summary = this._buildSummary();
    if (summary) card.appendChild(summary);

    const note = this._buildKnownIssueNote();
    if (note) card.appendChild(note);

    const details = this._buildDetails();
    if (details) card.appendChild(details);

    this.contentWrapper = this._buildContent();
    card.appendChild(this.contentWrapper);

    const footer = this._buildFooter();
    if (footer) card.appendChild(footer);

    return card;
  }

  private _buildHeader(): HTMLElement {
    const meta = this.meta;
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'tool-result-header';
    header.addEventListener('click', () => this._toggleContent());

    const mark = document.createElement('span');
    mark.className = 'tool-result-mark';
    header.appendChild(mark);

    const label = document.createElement('span');
    label.className = 'tool-result-kind';
    label.textContent = meta.label;
    header.appendChild(label);

    const title = document.createElement('span');
    title.className = 'tool-result-title';
    title.textContent = this.userFacingName;
    header.appendChild(title);

    const subjectText = this._headerSubject();
    if (subjectText) {
      const subject = document.createElement('span');
      subject.className = 'tool-result-subject';
      subject.textContent = subjectText;
      header.appendChild(subject);
    }

    const category = document.createElement('span');
    category.className = 'tool-result-category';
    category.textContent = meta.category;
    header.appendChild(category);

    const spacer = document.createElement('span');
    spacer.className = 'tool-result-spacer';
    header.appendChild(spacer);

    const status = document.createElement('span');
    status.className = 'tool-result-status';
    status.textContent = this.event.isError ? 'Error' : 'Completed';
    header.appendChild(status);

    if (typeof this.event.durationMs === 'number' && this.event.durationMs > 0) {
      const duration = document.createElement('span');
      duration.className = 'tool-result-badge';
      duration.textContent = this.formatDuration(this.event.durationMs);
      header.appendChild(duration);
    }

    if (this.event.tokenCount) {
      const tokens = document.createElement('span');
      tokens.className = 'tool-result-badge';
      tokens.textContent = this.formatTokens(this.event.tokenCount) + ' tokens';
      header.appendChild(tokens);
    }

    if (this.hasExpandableDetails()) {
      const toggle = document.createElement('span');
      toggle.className = 'tool-result-toggle';
      toggle.textContent = '+';
      header.appendChild(toggle);
    }

    return header;
  }

  private _buildSummary(): HTMLElement | null {
    const text = (this.event.summary || '').trim();
    if (!text) return null;
    const summary = document.createElement('div');
    summary.className = 'tool-result-summary';
    summary.textContent = text;
    return summary;
  }

  private _knownIssueCopy(): { title: string; body: string } | null {
    const content = this.fullContent.toLowerCase();
    if (this.event.toolName === 'Browser' && content.includes('electron desktop app')) {
      return {
        title: 'Desktop browser context required',
        body: 'Browser control is unavailable from CLI runs. Run the same task inside the AnoClaw desktop app.',
      };
    }
    if (this.event.toolName === 'Bash' && /\bdate\b/i.test(this.fullContent) && /(not found|not recognized|no such file|cannot)/i.test(this.fullContent)) {
      return {
        title: 'Shell command compatibility',
        body: 'This command looks shell-specific. On Windows, use PowerShell Get-Date; in Git Bash, prefer date +%s for epoch output.',
      };
    }
    return null;
  }

  private _buildKnownIssueNote(): HTMLElement | null {
    const copy = this._knownIssueCopy();
    if (!copy) return null;
    const { title, body } = copy;
    const note = document.createElement('div');
    note.className = 'tool-result-note';
    const noteTitle = document.createElement('div');
    noteTitle.className = 'tool-result-note-title';
    noteTitle.textContent = title;
    const noteBody = document.createElement('div');
    noteBody.className = 'tool-result-note-body';
    noteBody.textContent = body;
    note.append(noteTitle, noteBody);
    return note;
  }

  private _buildDetails(): HTMLElement | null {
    const rows = this._detailRows();
    if (rows.length === 0) return null;

    const details = document.createElement('div');
    details.className = 'tool-result-details';
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'tool-result-detail';
      const key = document.createElement('span');
      key.className = 'tool-result-detail-key';
      key.textContent = row[0];
      const value = document.createElement('span');
      value.className = 'tool-result-detail-value';
      value.textContent = row[1];
      item.append(key, value);
      details.appendChild(item);
    }
    return details;
  }

  private _detailRows(): Array<[string, string]> {
    const input = this.input;
    const rows: Array<[string, string]> = [];
    const add = (label: string, value: unknown, max = 120) => {
      if (value === undefined || value === null || value === '') return;
      const text = String(value).replace(/\s+/g, ' ').trim();
      if (!text) return;
      rows.push([label, text.length > max ? text.slice(0, max - 1) + '...' : text]);
    };
    const addPath = (label: string, value: unknown) => {
      if (!value) return;
      const text = String(value).replace(/\\/g, '/');
      add(label, text, 140);
    };

    switch (this.event.toolName) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
        addPath('Path', input.file_path || input.path || input.notebook_path);
        break;
      case 'Grep':
        add('Pattern', input.pattern || input.query);
        addPath('Path', input.path || input.cwd);
        break;
      case 'Glob':
        add('Pattern', input.pattern);
        addPath('Path', input.path || input.cwd);
        break;
      case 'Bash':
        add('Command', input.command, 180);
        add('Timeout', input.timeout_ms || input.timeout);
        break;
      case 'WebSearch':
        add('Query', input.query);
        add('Domain', input.allowed_domains || input.domains);
        break;
      case 'WebFetch':
      case 'ApiCall':
        add('URL', input.url || input.path, 180);
        add('Method', input.method);
        break;
      case 'Browser':
        add('Action', input.action || input.command || input.url);
        break;
      case 'TaskAssign':
        add('Agent', input.agentName || input.agentId || input.agent_id);
        add('Priority', input.priority);
        add('Task', input.task || input.prompt || input.description, 180);
        break;
      case 'TaskOutput':
      case 'TaskStop':
        add('Task ID', input.task_id || input.taskId);
        break;
      case 'TaskList':
        add('Filter', input.status || input.agentId || input.agent_id);
        break;
      case 'SubAgentSpawn':
        add('Type', input.subagent_type || input.type);
        add('Prompt', input.prompt || input.task || input.description, 180);
        break;
      case 'SubAgentDelete':
      case 'AgentMessage':
        add('Agent', input.agentId || input.subAgentId || input.to || input.subAgentName);
        add('Message', input.message || input.content, 180);
        break;
      case 'Skill':
      case 'SkillInspect':
        add('Skill', input.skill || input.name || input.skillName);
        break;
      case 'TodoWrite': {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        add('Items', todos.length || input.count);
        break;
      }
      case 'Sleep':
        add('Duration', input.seconds || input.duration || input.durationMs);
        add('Task ID', input.wait_for_task_id || input.task_id || input.taskId);
        break;
      case 'memory_save':
      case 'memory_delete':
        add('Key', input.key || input.name);
        break;
      case 'memory_search':
        add('Query', input.query);
        break;
      default:
        add('Input', this._compactJson(input), 180);
        break;
    }

    return rows.filter((row) => row[1] !== '{}' && row[1] !== '[]').slice(0, 4);
  }

  private _buildContent(): HTMLElement {
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'tool-result-output';

    this.contentDiv = document.createElement('pre');
    this.contentDiv.className = 'tool-result-output-body' + (this.hasStderr(this.fullContent) || this.event.isError ? ' result-stderr' : ' result-stdout');
    this.renderContent();
    contentWrapper.appendChild(this.contentDiv);

    if (this.needsOutputExpansion()) {
      const fade = document.createElement('div');
      fade.className = 'tool-result-fade';
      contentWrapper.appendChild(fade);
    }

    return contentWrapper;
  }

  private _buildFooter(): HTMLElement | null {
    if (!this.hasExpandableDetails()) return null;
    this.expandBtn = document.createElement('button');
    this.expandBtn.type = 'button';
    this.expandBtn.className = 'tool-result-expand';
    this.expandBtn.textContent = 'Show details +';
    this.expandBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this._toggleContent();
    });
    return this.expandBtn;
  }

  private _toggleContent(): void {
    if (!this.hasExpandableDetails()) return;
    this.isExpanded = !this.isExpanded;
    this.element.classList.toggle('is-expanded', this.isExpanded);
    this.element.classList.toggle('is-collapsed', !this.isExpanded);
    this.renderContent();
    if (this.expandBtn) this.expandBtn.textContent = this.isExpanded ? 'Show less -' : 'Show details +';
    const toggle = this.element.querySelector('.tool-result-toggle');
    if (toggle) toggle.textContent = this.isExpanded ? '-' : '+';
  }

  private renderContent(): void {
    const hasContent = this.fullContent.trim().length > 0;
    const content = !hasContent
      ? 'No output.'
      : this.isExpanded || this.fullContent.length <= this.truncatedLength
        ? this.fullContent
        : this.fullContent.substring(0, this.truncatedLength) + '\n\n...';

    this.contentDiv.textContent = content;
  }

  private hasStderr(content: string): boolean {
    if (!content) return false;
    const stderrPatterns = [
      /error:/i, /failed:/i, /denied/i, /not found/i,
      /cannot/i, /ENOENT/, /EPERM/, /EACCES/, /syntax error/i,
      /command not found/i, /No such file/i, /not recognized/i,
    ];
    return stderrPatterns.some((pattern) => pattern.test(content));
  }

  private _headerSubject(): string {
    const rows = this._detailRows();
    const preferred = rows.find(([key]) => /^(command|path|query|pattern|url|task|agent|skill)$/i.test(key)) || rows[0];
    if (preferred?.[1]) return this._truncateMiddle(preferred[1], 84);
    const summary = (this.event.summary || '').replace(/\s+/g, ' ').trim();
    if (summary) return this._truncateMiddle(summary, 84);
    const firstLine = this.fullContent.split('\n').map((line) => line.trim()).find(Boolean) || '';
    return this._truncateMiddle(firstLine, 84);
  }

  private _truncateMiddle(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    const head = Math.ceil((max - 3) * 0.62);
    const tail = Math.max(8, max - 3 - head);
    return clean.slice(0, head) + '...' + clean.slice(clean.length - tail);
  }

  collapse(): void {
    this.isExpanded = false;
    this.element.classList.remove('is-expanded');
    this.element.classList.add('is-collapsed');
    if (this.expandBtn) this.expandBtn.textContent = 'Show details +';
    const toggle = this.element.querySelector('.tool-result-toggle');
    if (toggle) toggle.textContent = '+';
    this.renderContent();
  }

  expand(): void {
    if (!this.hasExpandableDetails()) return;
    this.isExpanded = true;
    this.element.classList.add('is-expanded');
    this.element.classList.remove('is-collapsed');
    if (this.expandBtn) this.expandBtn.textContent = 'Show less -';
    const toggle = this.element.querySelector('.tool-result-toggle');
    if (toggle) toggle.textContent = '-';
    this.renderContent();
  }

  private _compactJson(value: unknown): string {
    if (!value || (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0)) return '';
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return ms + 'ms';
    const seconds = ms / 1000;
    if (seconds < 60) return seconds.toFixed(1) + 's';
    const minutes = Math.floor(seconds / 60);
    const remainSec = Math.round(seconds % 60);
    return minutes + 'm ' + remainSec + 's';
  }
}
