// AnoClaw — ToolResultDelegate: tool result card with summarized output
// Enhanced with Claude Code UI patterns: tool-specific summaries, collapse/expand
// with gradient fade, stdout/stderr detection, token & duration badges.

import type { ToolResultData } from '../types.js';

/** Map internal tool names to user-facing friendly names. */
const FRIENDLY_NAMES: Record<string, string> = {
  'Bash': 'Bash',
  'Read': 'Read',
  'Write': 'Write',
  'Edit': 'Edit',
  'Grep': 'Grep',
  'Glob': 'Glob',
  'TodoWrite': 'Todo',
  'WebSearch': 'Web Search',
  'WebFetch': 'Web Fetch',
  'TaskAssign': 'Task Assign',
  'TaskList': 'Task List',
  'TaskStop': 'Task Stop',
  'TaskOutput': 'Task Output',
  'Skill': 'Skill',
  'SkillList': 'Skill List',
  'memory_save': 'Memory Save',
  'memory_search': 'Memory Search',
  'memory_delete': 'Memory Delete',
  'NotebookEdit': 'Notebook Edit',
  'AskUserQuestion': 'Ask User',
  'SubAgentSpawn': 'Sub-Agent Spawn',
  'SubAgentDelete': 'Sub-Agent Delete',
  'AgentMessage': 'Agent Message',
  'EnterPlanMode': 'Plan Enter',
  'ExitPlanMode': 'Plan Exit',
  'Sleep': 'Sleep',
  'MCPTool': 'MCP Tool',
  'MCPReadResource': 'MCP Read',
  'MCPListResources': 'MCP List',
  'GatewaySend': 'Gateway Send',
  'GatewayStatus': 'Gateway Status',
  'UpdateOrg': 'Update Org',
  'HireEmployee': 'Hire Employee',
  'ListEmployees': 'List Employees',
};

export class ToolResultDelegate {
  element: HTMLElement;
  private event: ToolResultData;
  private isExpanded: boolean;
  private contentDiv!: HTMLElement;
  private expandBtn: HTMLButtonElement | null;
  private fullContent: string;
  private truncatedLength: number;

  constructor(event: ToolResultData) {
    this.event = event;
    this.isExpanded = false;
    this.expandBtn = null;
    this.fullContent = event.content || '';
    this.truncatedLength = 600;

    // Generate a human-readable summary if not already set
    if (!this.event.summary) {
      this.event.summary = this.generateSummary();
    }

    this.element = this.render();
  }

  /** Friendly name for the tool. */
  private get userFacingName(): string {
    return FRIENDLY_NAMES[this.event.toolName] || this.event.toolName;
  }

  /** Generate a human-readable summary of the result based on the tool type. */
  private generateSummary(): string {
    const content = this.event.content || '';
    const toolName = this.event.toolName;

    if (this.event.isError) {
      // Truncate error to a single line
      const firstLine = content.split('\n')[0].slice(0, 120);
      return firstLine || 'Error';
    }

    switch (toolName) {
      case 'Browser': {
        if (content.includes('[Browser Screenshot]')) return 'Screenshot captured';
        const lines = content.trim().split('\n');
        return lines[0].substring(0, 80);
      }
      case 'Read': {
        // Detect image
        if (content.startsWith('[Image file:')) {
          const sizeMatch = content.match(/Size:\s*(.+)/);
          return sizeMatch ? `Read image (${sizeMatch[1]})` : 'Read image';
        }
        // Detect binary
        if (content.startsWith('[Binary file:')) {
          const sizeMatch = content.match(/Size:\s*(.+)/);
          return sizeMatch ? `Read binary file (${sizeMatch[1]})` : 'Read binary file';
        }
        // Detect directory listing
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.every(l => !l.includes(':') && l.length < 200)) {
          return `Read ${lines.length} entries`;
        }
        // Regular file read
        const lineCount = content.split('\n').length;
        return `Read ${lineCount} lines`;
      }

      case 'Write': {
        const lineCount = content.split('\n').length;
        // Try to extract file path from content
        const pathMatch = content.match(/Successfully wrote \d+ chars to (.+)/);
        if (pathMatch) {
          const fileName = pathMatch[1].replace(/\\/g, '/').split('/').pop() || pathMatch[1];
          return `Wrote ${lineCount} lines to ${fileName}`;
        }
        return `Wrote ${lineCount} lines to file`;
      }

      case 'Edit': {
        if (content.includes('Successfully edited')) {
          const pathMatch = content.match(/Successfully edited (.+?):/);
          const replaced = content.includes('replaced');
          if (pathMatch) {
            const fileName = pathMatch[1].replace(/\\/g, '/').split('/').pop() || pathMatch[1];
            return `Updated ${fileName}` + (replaced ? ' (1 change)' : '');
          }
          return replaced ? 'Updated file (1 change)' : 'Updated file';
        }
        return 'Updated file';
      }

      case 'Grep': {
        const matchCount = (content.match(/\n/g) || []).length + (content.trim() ? 1 : 0);
        // Count unique files
        const fileSet = new Set<string>();
        const lines = content.split('\n');
        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            fileSet.add(line.slice(0, colonIdx).trim());
          }
        }
        if (matchCount === 0 || content.trim() === '(no matches)') {
          return 'No matches found';
        }
        if (fileSet.size > 0) {
          return `Found ${matchCount} matches across ${fileSet.size} files`;
        }
        return `Found ${matchCount} matches`;
      }

      case 'Glob': {
        const files = content.split('\n').filter(l => l.trim() && !l.startsWith('('));
        if (files.length === 0 || content.trim() === '(no matches)') {
          return 'No matches found';
        }
        return `Found ${files.length} files`;
      }

      case 'Bash': {
        const trimmed = content.trim();
        if (!trimmed || trimmed === '(no output)') {
          return 'No output';
        }
        // Detect if this looks like stderr (error patterns)
        const hasErrorPattern = /error:|failed:|denied|not found|cannot|ENOENT|EPERM/i;
        // Silent commands (mv, cp, touch, mkdir, rm, chmod, chown, export, set)
        const silentCommands = ['mv ', 'cp ', 'touch ', 'mkdir ', 'rm ', 'chmod ', 'chown ', 'export ', 'set ', 'cd ', 'pwd '];
        // Check if the output is very short (success message)
        if (trimmed.length < 60 && !hasErrorPattern.test(trimmed)) {
          return trimmed;
        }
        const lineCount = trimmed.split('\n').length;
        return `${lineCount} lines of output`;
      }

      case 'WebSearch': {
        const resultCount = (content.match(/\[.+\]\(https?:\/\//g) || []).length;
        if (resultCount > 0) return `Found ${resultCount} search results`;
        return 'Search completed';
      }

      case 'WebFetch': {
        if (content.length < 100) return content.slice(0, 80);
        return `Fetched ${content.length} characters`;
      }

      case 'TodoWrite': {
        return 'Todo list updated';
      }

      case 'memory_save': {
        return 'Memory saved';
      }

      case 'memory_search': {
        const resultCount = content.split('\n').filter(l => l.trim()).length;
        return `Found ${resultCount} memory entries`;
      }

      case 'TaskAssign':
      case 'SubAgentSpawn': {
        return 'Task started';
      }

      default: {
        const firstLine = content.split('\n')[0].slice(0, 100);
        if (firstLine) return firstLine;
        return 'Completed';
      }
    }
  }

  /** Detect if Bash output contains stderr-like patterns. */
  private hasStderr(content: string): boolean {
    if (!content) return false;
    // Common error indicators in shell output
    const stderrPatterns = [
      /error:/i, /failed:/i, /denied/i, /not found/i,
      /cannot/i, /ENOENT/, /EPERM/, /EACCES/, /syntax error/i,
      /command not found/i, /No such file/i,
    ];
    return stderrPatterns.some(p => p.test(content));
  }

  render(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'delegate-tool-result';
    card.style.cssText = `
      margin-bottom: var(--space-sm);
      border-radius: var(--radius);
      border: 1px solid ${this.event.isError
        ? 'rgba(248, 113, 113, 0.3)'
        : 'var(--cinema-bg-hover)'};
      background: ${this.event.isError
        ? 'var(--color-tool-error-bg)'
        : 'var(--cinema-bg-card)'};
      overflow: hidden;
      transition: background 0.2s ease, border-color 0.2s ease;
    `;

    // Header with tool icon, name, "Completed" label, and badges
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--cinema-bg-hover);
      font-size: 12px;
      color: var(--color-text-secondary);
      cursor: pointer;
      user-select: none;
    `;

    // Tool icon
    const toolIcon = document.createElement('img');
    toolIcon.src = 'icons/mcp.svg';
    toolIcon.width = 14;
    toolIcon.height = 14;
    toolIcon.style.cssText = 'flex-shrink: 0; opacity: 0.5;';
    header.appendChild(toolIcon);

    // Tool name
    const toolLabel = document.createElement('span');
    toolLabel.textContent = this.userFacingName;
    toolLabel.style.cssText = `
      font-weight: 500;
      color: var(--color-text-primary);
      flex: 1;
    `;
    header.appendChild(toolLabel);

    // Status label
    const statusLabel = document.createElement('span');
    statusLabel.style.cssText = `
      font-size: 10px;
      color: ${this.event.isError ? 'var(--color-tool-error-text)' : 'var(--color-text-secondary)'};
      flex-shrink: 0;
    `;
    statusLabel.textContent = this.event.isError ? 'Error' : 'Completed';
    header.appendChild(statusLabel);

    // Status icon (check or error)
    const statusIcon = document.createElement('img');
    statusIcon.src = this.event.isError ? 'icons/error.svg' : 'icons/check.svg';
    statusIcon.width = 12;
    statusIcon.height = 12;
    statusIcon.style.cssText = 'flex-shrink: 0;';
    header.appendChild(statusIcon);

    // Duration badge
    if (this.event.durationMs !== undefined && this.event.durationMs > 0) {
      const durBadge = document.createElement('span');
      durBadge.style.cssText = `
        font-size: 10px;
        color: var(--color-text-secondary);
        background: var(--cinema-bg-edge-icon);
        padding: 1px 6px;
        border-radius: 8px;
        flex-shrink: 0;
      `;
      durBadge.textContent = this.formatDuration(this.event.durationMs);
      header.appendChild(durBadge);
    }

    // Token count if available
    if (this.event.tokenCount) {
      const tokenBadge = document.createElement('span');
      tokenBadge.style.cssText = `
        font-size: 10px;
        color: var(--color-text-secondary);
        background: var(--cinema-bg-edge-icon);
        padding: 1px 6px;
        border-radius: 8px;
        flex-shrink: 0;
      `;
      tokenBadge.textContent = `${this.formatTokens(this.event.tokenCount)} tokens`;
      header.appendChild(tokenBadge);
    }

    card.appendChild(header);

    // Summary text (always visible)
    if (this.event.summary) {
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'result-summary';
      summaryDiv.style.cssText = `
        padding: 6px 12px 4px 34px;
        font-size: 12px;
        color: ${this.event.isError ? 'var(--color-tool-error-text)' : 'var(--color-tool-success-icon)'};
        font-family: var(--font-sans);
      `;
      summaryDiv.textContent = this.event.summary;
      card.appendChild(summaryDiv);
    }

    // Content area (collapsible)
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'tool-result-content-wrapper';
    contentWrapper.style.cssText = `
      position: relative;
    `;

    this.contentDiv = document.createElement('div');
    this.contentDiv.className = 'result-content' +
      (this.hasStderr(this.fullContent) ? ' result-stderr' : ' result-stdout');
    this.contentDiv.style.cssText = `
      padding: 8px 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 120px;
      overflow-y: hidden;
      color: ${this.event.isError
        ? 'var(--color-tool-error-text)'
        : this.hasStderr(this.fullContent)
          ? 'var(--color-tool-error-text)'
          : 'var(--color-text-secondary)'};
    `;

    this.renderContent();
    contentWrapper.appendChild(this.contentDiv);

    // Gradient fade overlay for collapsed state
    const fadeEl = document.createElement('div');
    fadeEl.className = 'result-fade';
    fadeEl.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 40px;
      background: linear-gradient(to bottom, transparent, rgba(15,15,19,0.95));
      pointer-events: none;
      transition: opacity 0.2s ease;
    `;
    contentWrapper.appendChild(fadeEl);

    card.appendChild(contentWrapper);

    // Expand/collapse button
    const showMore = this.needsExpand();
    this.expandBtn = document.createElement('button');
    this.expandBtn.className = 'expand-btn';
    this.expandBtn.style.cssText = `
      display: ${showMore ? 'block' : 'none'};
      width: 100%;
      padding: 4px;
      background: none;
      border: none;
      border-top: 1px solid var(--cinema-bg-hover);
      color: var(--color-text-secondary);
      cursor: pointer;
      font-size: 11px;
      font-family: var(--font-sans);
      transition: color 0.15s;
    `;
    this.expandBtn.textContent = 'Show more ▼';
    this.expandBtn.addEventListener('mouseenter', () => {
      if (this.expandBtn) this.expandBtn.style.color = 'var(--color-text-primary)';
    });
    this.expandBtn.addEventListener('mouseleave', () => {
      if (this.expandBtn) this.expandBtn.style.color = 'var(--color-text-secondary)';
    });

    // Toggle on button click OR header click
    const toggleFn = () => {
      this.isExpanded = !this.isExpanded;
      this.renderContent();
      if (this.expandBtn) {
        this.expandBtn.textContent = this.isExpanded ? 'Show less ▲' : 'Show more ▼';
      }
      if (this.isExpanded) {
        this.contentDiv.style.maxHeight = 'none';
        this.contentDiv.style.overflowY = 'visible';
        fadeEl.style.opacity = '0';
      } else {
        this.contentDiv.style.maxHeight = '120px';
        this.contentDiv.style.overflowY = 'hidden';
        fadeEl.style.opacity = '1';
      }
    };

    this.expandBtn.addEventListener('click', toggleFn);
    header.addEventListener('click', toggleFn);

    card.appendChild(this.expandBtn);

    return card;
  }

  /** Whether content is long enough to need expand/collapse. */
  private needsExpand(): boolean {
    return this.fullContent.length > 200 || this.fullContent.split('\n').length > 8;
  }

  private renderContent(): void {
    const content = this.isExpanded || this.fullContent.length <= this.truncatedLength
      ? this.fullContent
      : this.fullContent.substring(0, this.truncatedLength) + '\n\n...';

    // Display images inline (Browser screenshots)
    if (content.includes('<img ')) {
      this.contentDiv.innerHTML = content;
      // Make images inside work
      this.contentDiv.querySelectorAll('img').forEach(img => {
        img.style.maxWidth = '100%';
        img.style.borderRadius = '6px';
        img.style.marginTop = '8px';
      });
      return;
    }

    this.contentDiv.textContent = content;
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSec = Math.round(seconds % 60);
    return `${minutes}m ${remainSec}s`;
  }
}
