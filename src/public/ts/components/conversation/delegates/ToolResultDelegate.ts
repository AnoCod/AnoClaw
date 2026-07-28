/**
 * ToolResultDelegate - structured Raycast-style tool result card.
 * Completed tools render as one card with a typed header, summary, details, and output.
 */

import type { ToolResultData } from '../types.js';
import {
  generateToolResultSummaryDescriptor,
  type ToolResultSummaryDescriptor,
} from './ToolResultSummary.js';
import { t, type TranslationKey } from '../../../i18n/index.js';

type ToolTone = 'file' | 'shell' | 'web' | 'api' | 'agent' | 'skill' | 'plan' | 'memory' | 'browser' | 'generic';

interface ToolVisualMeta {
  label: string;
  categoryKey: TranslationKey;
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
  Organization: 'Organization',
  Team: 'Team',
  Task: 'Task',
  Skill: 'Skill',
  SkillInspect: 'Skill Inspect',
  SkillList: 'Skill List',
  memory_save: 'Memory Save',
  memory_search: 'Memory Search',
  memory_delete: 'Memory Delete',
  NotebookEdit: 'Notebook Edit',
  AskUserQuestion: 'AskUserQuestion',
  JobList: 'Job List',
  JobOutput: 'Job Output',
  JobStop: 'Job Stop',
  AgentMessage: 'Agent Message',
  EnterPlanMode: 'Plan Enter',
  ExitPlanMode: 'Plan Exit',
  Sleep: 'Sleep',
  MCPTool: 'MCP Tool',
  MCPReadResource: 'MCP Read',
  MCPListResources: 'MCP List',
  GatewaySend: 'Gateway Send',
  GatewayStatus: 'Gateway Status',
};

const TOOL_META: Record<string, ToolVisualMeta> = {
  Read: { label: 'READ', categoryKey: 'message.tool.category.file', tone: 'file' },
  Write: { label: 'WRITE', categoryKey: 'message.tool.category.file', tone: 'file' },
  Edit: { label: 'EDIT', categoryKey: 'message.tool.category.file', tone: 'file' },
  Grep: { label: 'GREP', categoryKey: 'message.tool.category.search', tone: 'file' },
  Glob: { label: 'GLOB', categoryKey: 'message.tool.category.search', tone: 'file' },
  Bash: { label: 'BASH', categoryKey: 'message.tool.category.shell', tone: 'shell' },
  WebSearch: { label: 'SEARCH', categoryKey: 'message.tool.category.web', tone: 'web' },
  WebFetch: { label: 'FETCH', categoryKey: 'message.tool.category.web', tone: 'web' },
  Browser: { label: 'BROWSER', categoryKey: 'message.tool.category.browser', tone: 'browser' },
  ApiCall: { label: 'API', categoryKey: 'message.tool.category.api', tone: 'api' },
  Organization: { label: 'ORG', categoryKey: 'message.tool.category.coordination', tone: 'agent' },
  Team: { label: 'TEAM', categoryKey: 'message.tool.category.coordination', tone: 'agent' },
  Task: { label: 'TASK', categoryKey: 'message.tool.category.coordination', tone: 'agent' },
  JobList: { label: 'JOBS', categoryKey: 'message.tool.category.process', tone: 'shell' },
  JobOutput: { label: 'OUTPUT', categoryKey: 'message.tool.category.process', tone: 'shell' },
  JobStop: { label: 'STOP', categoryKey: 'message.tool.category.process', tone: 'shell' },
  AgentMessage: { label: 'MESSAGE', categoryKey: 'message.tool.category.team', tone: 'agent' },
  Skill: { label: 'SKILL', categoryKey: 'message.tool.category.skill', tone: 'skill' },
  SkillInspect: { label: 'INSPECT', categoryKey: 'message.tool.category.skill', tone: 'skill' },
  SkillList: { label: 'SKILLS', categoryKey: 'message.tool.category.skill', tone: 'skill' },
  TodoWrite: { label: 'TODO', categoryKey: 'message.tool.category.planning', tone: 'plan' },
  Sleep: { label: 'WAIT', categoryKey: 'message.tool.category.planning', tone: 'plan' },
  EnterPlanMode: { label: 'PLAN', categoryKey: 'message.tool.category.planning', tone: 'plan' },
  ExitPlanMode: { label: 'PLAN', categoryKey: 'message.tool.category.planning', tone: 'plan' },
  memory_save: { label: 'SAVE', categoryKey: 'message.tool.category.memory', tone: 'memory' },
  memory_search: { label: 'SEARCH', categoryKey: 'message.tool.category.memory', tone: 'memory' },
  memory_delete: { label: 'DELETE', categoryKey: 'message.tool.category.memory', tone: 'memory' },
  NotebookEdit: { label: 'NOTEBOOK', categoryKey: 'message.tool.category.notebook', tone: 'file' },
  MCPTool: { label: 'MCP', categoryKey: 'message.tool.category.mcp', tone: 'api' },
  MCPReadResource: { label: 'MCP', categoryKey: 'message.tool.category.mcp', tone: 'api' },
  MCPListResources: { label: 'MCP', categoryKey: 'message.tool.category.mcp', tone: 'api' },
  GatewaySend: { label: 'GATEWAY', categoryKey: 'message.tool.category.gateway', tone: 'api' },
  GatewayStatus: { label: 'GATEWAY', categoryKey: 'message.tool.category.gateway', tone: 'api' },
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
  private generatedSummary: ToolResultSummaryDescriptor | null = null;

  constructor(event: ToolResultData) {
    this.event = event;
    this.isExpanded = false;
    this.expandBtn = null;
    this.fullContent = event.content || '';
    this.truncatedLength = 700;

    if (!this.event.summary) {
      this.generatedSummary = generateToolResultSummaryDescriptor(this.event);
      this.event.summary = this.generatedSummary.text;
    }

    this.element = this.render();
  }

  private get userFacingName(): string {
    if (this.event.toolName === 'AskUserQuestion') return t('askUser.title');
    const base = FRIENDLY_NAMES[this.event.toolName] || this.event.toolName;
    if (!['Organization', 'Team', 'Task'].includes(this.event.toolName)) return base;
    const action = String(this.input.action || '');
    return action ? `${base} ${action.charAt(0).toUpperCase()}${action.slice(1)}` : base;
  }

  private get meta(): ToolVisualMeta {
    return TOOL_META[this.event.toolName] || {
      label: this.event.toolName.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase().slice(0, 14),
      categoryKey: 'message.tool.category.tool',
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
    if (this.event.toolName === 'AskUserQuestion') {
      title.dataset.i18nKey = 'askUser.title';
    }
    header.appendChild(title);

    const subjectText = this._headerSubject();
    if (subjectText) {
      const subject = document.createElement('span');
      subject.className = 'tool-result-subject';
      subject.textContent = subjectText;
      if (this.generatedSummary?.key && !this._preferredHeaderDetail()) {
        subject.dataset.i18nKey = this.generatedSummary.key;
        subject.dataset.i18nParams = JSON.stringify(this.generatedSummary.params || {});
      }
      header.appendChild(subject);
    }

    const category = document.createElement('span');
    category.className = 'tool-result-category';
    category.textContent = t(meta.categoryKey);
    category.dataset.i18nKey = meta.categoryKey;
    header.appendChild(category);

    const spacer = document.createElement('span');
    spacer.className = 'tool-result-spacer';
    header.appendChild(spacer);

    const status = document.createElement('span');
    status.className = 'tool-result-status';
    const statusKey = this.event.isError ? 'message.tool.error' : 'message.tool.completed';
    status.textContent = t(statusKey);
    status.setAttribute('data-i18n-key', statusKey);
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
      const params = { count: this.formatTokens(this.event.tokenCount) };
      tokens.textContent = t('message.tool.tokens', params);
      tokens.setAttribute('data-i18n-key', 'message.tool.tokens');
      tokens.setAttribute('data-i18n-params', JSON.stringify(params));
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
    if (this.generatedSummary?.key) {
      summary.dataset.i18nKey = this.generatedSummary.key;
      summary.dataset.i18nParams = JSON.stringify(this.generatedSummary.params || {});
    }
    return summary;
  }

  private _knownIssueCopy(): { titleKey: TranslationKey; bodyKey: TranslationKey } | null {
    const content = this.fullContent.toLowerCase();
    if (this.event.toolName === 'Browser' && content.includes('electron desktop app')) {
      return {
        titleKey: 'message.tool.issue.browserTitle',
        bodyKey: 'message.tool.issue.browserBody',
      };
    }
    if (this.event.toolName === 'Bash' && /\bdate\b/i.test(this.fullContent) && /(not found|not recognized|no such file|cannot)/i.test(this.fullContent)) {
      return {
        titleKey: 'message.tool.issue.shellTitle',
        bodyKey: 'message.tool.issue.shellBody',
      };
    }
    return null;
  }

  private _buildKnownIssueNote(): HTMLElement | null {
    const copy = this._knownIssueCopy();
    if (!copy) return null;
    const note = document.createElement('div');
    note.className = 'tool-result-note';
    const noteTitle = document.createElement('div');
    noteTitle.className = 'tool-result-note-title';
    noteTitle.textContent = t(copy.titleKey);
    noteTitle.dataset.i18nKey = copy.titleKey;
    const noteBody = document.createElement('div');
    noteBody.className = 'tool-result-note-body';
    noteBody.textContent = t(copy.bodyKey);
    noteBody.dataset.i18nKey = copy.bodyKey;
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
      key.textContent = t(row[0]);
      key.dataset.i18nKey = row[0];
      const value = document.createElement('span');
      value.className = 'tool-result-detail-value';
      value.textContent = row[1];
      item.append(key, value);
      details.appendChild(item);
    }
    return details;
  }

  private _detailRows(): Array<[TranslationKey, string]> {
    const input = this.input;
    const rows: Array<[TranslationKey, string]> = [];
    const add = (label: TranslationKey, value: unknown, max = 120) => {
      if (value === undefined || value === null || value === '') return;
      const text = String(value).replace(/\s+/g, ' ').trim();
      if (!text) return;
      rows.push([label, text.length > max ? text.slice(0, max - 1) + '...' : text]);
    };
    const addPath = (label: TranslationKey, value: unknown) => {
      if (!value) return;
      const text = String(value).replace(/\\/g, '/');
      add(label, text, 140);
    };

    switch (this.event.toolName) {
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'NotebookEdit':
        addPath('message.tool.detail.path', input.file_path || input.path || input.notebook_path);
        break;
      case 'Grep':
        add('message.tool.detail.pattern', input.pattern || input.query);
        addPath('message.tool.detail.path', input.path || input.cwd);
        break;
      case 'Glob':
        add('message.tool.detail.pattern', input.pattern);
        addPath('message.tool.detail.path', input.path || input.cwd);
        break;
      case 'Bash':
        add('message.tool.detail.command', input.command, 180);
        add('message.tool.detail.timeout', input.timeout_ms || input.timeout);
        break;
      case 'WebSearch':
        add('message.tool.detail.query', input.query);
        add('message.tool.detail.domain', input.allowed_domains || input.domains);
        break;
      case 'WebFetch':
      case 'ApiCall':
        add('message.tool.detail.url', input.url || input.path, 180);
        add('message.tool.detail.method', input.method);
        break;
      case 'Browser':
        add('message.tool.detail.action', input.action || input.command || input.url);
        break;
      case 'Organization':
        add('message.tool.detail.action', input.action);
        if (input.action === 'hire') {
          add('message.tool.detail.employee', input.name);
          add('message.tool.detail.role', input.role);
          add('message.tool.detail.manager', input.parentAgentId);
        } else if (input.action === 'reassign') {
          add('message.tool.detail.employee', input.agentId);
          add('message.tool.detail.manager', input.newParentId);
        }
        break;
      case 'Task':
        add('message.tool.detail.action', input.action);
        if (input.action === 'create') {
          add('message.tool.detail.subject', input.subject);
          add('message.tool.detail.agent', input.targetAgentId);
          add('message.tool.detail.priority', input.priority);
        } else if (input.action === 'spawn') {
          add('message.tool.detail.type', input.type);
          add('message.tool.detail.prompt', input.prompt || input.description, 180);
        } else if (input.action === 'list') {
          add('message.tool.detail.filter', input.status || input.assigneeAgentId || input.teamId);
        } else {
          add('message.tool.detail.taskId', input.taskId);
          add('message.tool.detail.agent', input.targetAgentId);
        }
        break;
      case 'AgentMessage':
        add('message.tool.detail.agent', input.agentId || input.subAgentId || input.to || input.subAgentName);
        add('message.tool.detail.message', input.message || input.content, 180);
        break;
      case 'Team':
        add('message.tool.detail.action', input.action);
        add('message.tool.detail.team', input.name || input.teamId);
        break;
      case 'JobOutput':
      case 'JobStop':
        add('message.tool.detail.jobId', input.jobId || input.job_id);
        break;
      case 'Skill':
      case 'SkillInspect':
        add('message.tool.detail.skill', input.skill || input.name || input.skillName);
        break;
      case 'TodoWrite': {
        const todos = Array.isArray(input.todos) ? input.todos : [];
        add('message.tool.detail.items', todos.length || input.count);
        break;
      }
      case 'Sleep':
        add('message.tool.detail.duration', input.seconds || input.duration || input.durationMs);
        add('message.tool.detail.taskId', input.wait_for_task_id || input.task_id || input.taskId);
        break;
      case 'memory_save':
      case 'memory_delete':
        add('message.tool.detail.key', input.key || input.name);
        break;
      case 'memory_search':
        add('message.tool.detail.query', input.query);
        break;
      default:
        add('message.tool.detail.input', this._compactJson(input), 180);
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
    this._setExpandButtonLabel('message.showDetails');
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
    this._setExpandButtonLabel(this.isExpanded ? 'message.showLess' : 'message.showDetails');
    const toggle = this.element.querySelector('.tool-result-toggle');
    if (toggle) toggle.textContent = this.isExpanded ? '-' : '+';
  }

  private renderContent(): void {
    const hasContent = this.fullContent.trim().length > 0;
    const content = !hasContent
      ? t('message.noOutput')
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
    const preferred = this._preferredHeaderDetail();
    if (preferred) return this._truncateMiddle(preferred, 84);
    const summary = (this.event.summary || '').replace(/\s+/g, ' ').trim();
    if (summary) return this._truncateMiddle(summary, 84);
    const firstLine = this.fullContent.split('\n').map((line) => line.trim()).find(Boolean) || '';
    return this._truncateMiddle(firstLine, 84);
  }

  private _preferredHeaderDetail(): string {
    const rows = this._detailRows();
    const preferred = rows.find(([key]) =>
      /\.(command|path|query|pattern|url|taskId|agent|skill)$/i.test(key),
    ) || rows[0];
    return preferred?.[1] || '';
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
    this._setExpandButtonLabel('message.showDetails');
    const toggle = this.element.querySelector('.tool-result-toggle');
    if (toggle) toggle.textContent = '+';
    this.renderContent();
  }

  expand(): void {
    if (!this.hasExpandableDetails()) return;
    this.isExpanded = true;
    this.element.classList.add('is-expanded');
    this.element.classList.remove('is-collapsed');
    this._setExpandButtonLabel('message.showLess');
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

  private _setExpandButtonLabel(key: 'message.showDetails' | 'message.showLess'): void {
    if (!this.expandBtn) return;
    this.expandBtn.textContent = t(key);
    this.expandBtn.setAttribute('data-i18n-key', key);
  }
}
