import { BackgroundTaskStore, type TaskEntry } from '../../viewmodel/BackgroundTaskStore.js';
import {
  CoordinationStore,
  type CoordinationState,
  type CoordinationTaskView,
  type TeamView,
} from '../../viewmodel/CoordinationStore.js';
import { ToastManager } from '../../ToastManager.js';

interface AgentSummary {
  id: string;
  name: string;
  role: string;
  status?: string;
  isActive?: boolean;
}

export class BackgroundTasksTab {
  container: HTMLElement;
  private _jobs = BackgroundTaskStore.getInstance();
  private _coordination = CoordinationStore.getInstance();
  private _sessionId: string;
  private _rootSessionId = '';
  private _agents = new Map<string, AgentSummary>();
  private _onJobsChanged = () => this._render();
  private _onCoordinationChanged = (rootSessionId?: string) => {
    if (!rootSessionId || rootSessionId === this._rootSessionId) this._render();
  };
  private _destroyed = false;

  constructor(container: HTMLElement, sessionId: string) {
    this.container = container;
    this._sessionId = sessionId;
    this._jobs.on('changed', this._onJobsChanged);
    this._coordination.on('changed', this._onCoordinationChanged);
    this._renderLoading();
    void this._load();
  }

  setParentSessionId(sessionId: string): void {
    this._sessionId = sessionId;
    void this._load();
  }

  private async _load(): Promise<void> {
    try {
      const [, agentResponse] = await Promise.all([
        this._coordination.loadForSession(this._sessionId),
        fetch('/api/v1/agents'),
      ]);
      this._rootSessionId = this._coordination.rootForSession(this._sessionId);
      if (agentResponse.ok) {
        const body = await agentResponse.json() as { agents?: AgentSummary[] } | AgentSummary[];
        const agents = Array.isArray(body) ? body : (body.agents || []);
        this._agents = new Map(agents.map((agent) => [agent.id, agent]));
      }
      this._render();
    } catch (error) {
      if (!this._destroyed) this._renderError(error instanceof Error ? error.message : String(error));
    }
  }

  private _render(): void {
    if (this._destroyed) return;
    const state = this._coordination.stateForSession(this._sessionId);
    if (!state || state.loading) {
      this._renderLoading();
      return;
    }
    if (state.error) {
      this._renderError(state.error);
      return;
    }
    this._rootSessionId = state.rootSessionId;
    this.container.innerHTML = '';
    const shell = element('div', 'team-cockpit');
    shell.append(this._toolbar(state));

    const team = state.teams.find((candidate) => candidate.state === 'active');
    const grid = element('div', 'team-cockpit-grid');
    grid.append(
      this._teamPanel(team, state),
      this._taskBoard(state),
      this._metricsPanel(state),
      this._workspacePanel(state),
      this._timeline(state),
      this._jobsPanel(),
    );
    shell.append(grid);
    this.container.append(shell);
  }

  private _toolbar(state: CoordinationState): HTMLElement {
    const bar = element('div', 'team-cockpit-toolbar');
    const info = element('div');
    info.append(
      textElement('strong', 'Team Cockpit'),
      textElement('span', ` · revision ${state.revision}`, 'team-cockpit-muted'),
    );
    const actions = element('div', 'team-cockpit-actions');
    const activeTeam = state.teams.find((team) => team.state === 'active');
    if (!activeTeam) actions.append(this._button('Create Team', () => void this._createTeam()));
    actions.append(this._button('Create Task', () => void this._createTask(activeTeam)));
    actions.append(this._button('Refresh', () => void this._coordination.loadRoot(state.rootSessionId)));
    bar.append(info, actions);
    return bar;
  }

  private _teamPanel(team: TeamView | undefined, state: CoordinationState): HTMLElement {
    const panel = this._panel('Team roster', team ? team.name : 'No active team');
    if (!team) {
      panel.append(textElement('p', 'Create a temporary team to coordinate existing employees without changing the organization tree.', 'team-cockpit-empty'));
      return panel;
    }
    panel.append(textElement('p', team.purpose, 'team-cockpit-purpose'));
    const roster = element('div', 'team-roster');
    for (const agentId of team.memberAgentIds) {
      const agent = this._agents.get(agentId);
      const task = state.tasks.find((item) => item.assigneeAgentId === agentId && !terminal(item.status));
      const row = element('div', 'team-roster-row');
      row.append(
        textElement('span', agent?.name || agentId, 'team-roster-name'),
        textElement('span', agentId === team.leaderAgentId ? 'Leader' : (agent?.role || 'Member'), 'team-badge'),
        textElement('span', task ? labelStatus(task.status) : (agent?.isActive === false ? 'Offline' : 'Idle'), `team-status team-status-${task?.status || 'idle'}`),
      );
      if (agentId !== team.leaderAgentId) {
        row.append(this._button('Remove', () => void this._removeMember(team, agentId, !!task)));
      }
      roster.append(row);
    }
    panel.append(roster);
    const footer = element('div', 'team-panel-footer');
    footer.append(
      textElement('span', team.autoCreated ? 'Auto-created' : 'Manual', 'team-cockpit-muted'),
      this._button('Invite', () => void this._inviteMembers(team)),
      this._button('Disband', () => void this._disbandTeam(team)),
    );
    panel.append(footer);
    return panel;
  }

  private _taskBoard(state: CoordinationState): HTMLElement {
    const panel = this._panel('Task board', `${state.tasks.length} tasks`);
    const board = element('div', 'coord-task-board');
    const statuses: CoordinationTaskView['status'][] = ['running', 'blocked', 'claimed', 'pending', 'failed', 'completed', 'cancelled'];
    for (const status of statuses) {
      const tasks = state.tasks.filter((task) => task.status === status);
      if (!tasks.length) continue;
      const column = element('section', 'coord-task-column');
      column.append(textElement('h4', `${labelStatus(status)} (${tasks.length})`));
      for (const task of tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        column.append(this._taskCard(task));
      }
      board.append(column);
    }
    if (!state.tasks.length) board.append(textElement('p', 'No durable tasks yet.', 'team-cockpit-empty'));
    panel.append(board);
    return panel;
  }

  private _taskCard(task: CoordinationTaskView): HTMLElement {
    const card = element('article', `coord-task-card coord-task-${task.status}`);
    const header = element('div', 'coord-task-header');
    header.append(
      textElement('strong', task.subject),
      textElement('span', task.priority, `priority-${task.priority}`),
    );
    card.append(
      header,
      textElement('div', `${this._agentName(task.assigneeAgentId)} · ${task.mode} · attempt ${task.attempt}/${task.maxAttempts}`, 'team-cockpit-muted'),
      textElement('div', `Progress ${task.progress ?? 0}%${task.currentTool ? ` · ${task.currentTool}` : ''}`, 'coord-task-progress'),
      textElement('div', `Depends: ${task.dependsOn.join(', ') || 'none'}`, 'team-cockpit-muted'),
      textElement('div', task.readOnly ? 'Read only' : `Writes: ${task.writeScope.join(', ')}`, 'team-cockpit-muted'),
      textElement('div', `Tokens: ${task.tokenUsage ?? 0}`, 'team-cockpit-muted'),
    );
    if (task.blocker || task.error) {
      card.append(textElement('div', task.blocker || task.error || '', 'coord-task-error'));
    }
    if (task.resultSummary) card.append(textElement('div', task.resultSummary, 'coord-task-result'));
    const controls = element('div', 'coord-task-controls');
    if (!terminal(task.status)) controls.append(this._button('Stop', () => void this._stopTask(task)));
    if (task.status === 'pending' || task.status === 'blocked') {
      controls.append(this._button('Assign', () => void this._assignTask(task)));
    }
    if (task.status === 'failed' || task.status === 'blocked' || task.status === 'cancelled') {
      controls.append(this._button('Retry', () => void this._retryTask(task)));
    }
    card.append(controls);
    return card;
  }

  private _workspacePanel(state: CoordinationState): HTMLElement {
    const panel = this._panel('Workspace leases', `${state.leases.length} active`);
    if (!state.leases.length) {
      panel.append(textElement('p', 'No active write leases. Read-only work may run in parallel.', 'team-cockpit-empty'));
      return panel;
    }
    for (const lease of state.leases) {
      const task = state.tasks.find((item) => item.id === lease.taskId);
      panel.append(textElement(
        'div',
        `${task?.subject || lease.taskId} · ${lease.scopes.join(', ')} · ${this._agentName(lease.agentId)}`,
        'workspace-lease-row',
      ));
    }
    const waiting = state.tasks.filter((task) => task.status === 'blocked' && task.blocker === 'workspace_conflict');
    for (const task of waiting) {
      panel.append(textElement(
        'div',
        `Waiting: ${task.subject} · ${task.writeScope.join(', ')} · ${this._agentName(task.assigneeAgentId)}`,
        'workspace-conflict-row',
      ));
    }
    return panel;
  }

  private _metricsPanel(state: CoordinationState): HTMLElement {
    const panel = this._panel('Coordination metrics', `${state.tasks.filter((task) => task.status === 'running').length} active loops`);
    const queueSamples = state.tasks
      .filter((task) => !!task.startedAt)
      .map((task) => Date.parse(task.startedAt!) - Date.parse(task.createdAt))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const runSamples = state.tasks
      .filter((task) => !!task.startedAt && !!task.completedAt)
      .map((task) => Date.parse(task.completedAt!) - Date.parse(task.startedAt!))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const queuedMessages = state.messages.filter((message) => message.status === 'queued');
    const oldestMessageAge = queuedMessages.length
      ? Date.now() - Math.min(...queuedMessages.map((message) => Date.parse(message.createdAt)))
      : 0;
    const values = [
      ['Average queue', formatDuration(average(queueSamples))],
      ['Average execution', formatDuration(average(runSamples))],
      ['Retries', String(state.tasks.reduce((sum, task) => sum + Math.max(0, task.attempt - 1), 0))],
      ['Dead letters', String(state.messages.filter((message) => message.status === 'dead_letter').length)],
      ['Oldest message', formatDuration(oldestMessageAge)],
      ['Workspace conflicts', String(state.events.filter((event) => event.type.includes('workspace_conflict')).length)],
      ['Task tokens', String(state.tasks.reduce((sum, task) => sum + (task.tokenUsage || 0), 0))],
    ];
    for (const [label, value] of values) {
      const row = element('div', 'coord-metric-row');
      row.append(textElement('span', label), textElement('strong', value));
      panel.append(row);
    }
    return panel;
  }

  private _timeline(state: CoordinationState): HTMLElement {
    const panel = this._panel('Coordination timeline', `${state.events.length} events`);
    const events = [...state.events].sort((a, b) => b.revision - a.revision).slice(0, 40);
    if (!events.length) {
      panel.append(textElement('p', 'Task changes, messages, conflicts, stops, and recovery will appear here.', 'team-cockpit-empty'));
      return panel;
    }
    for (const event of events) {
      panel.append(textElement(
        'div',
        `${new Date(event.timestamp).toLocaleTimeString()} · r${event.revision} · ${this._describeEvent(event.type, event.payload)}`,
        'coord-timeline-row',
      ));
    }
    return panel;
  }

  private _describeEvent(type: string, payload: Record<string, unknown>): string {
    const task = payload.task as CoordinationTaskView | undefined;
    const team = payload.team as TeamView | undefined;
    const message = payload.message as {
      kind?: string;
      fromAgentId?: string;
      toAgentId?: string;
      summary?: string;
      content?: string;
    } | undefined;
    if (task) return `${type} · ${task.subject} → ${task.status}${task.blocker ? ` (${task.blocker})` : ''}`;
    if (team) return `${type} · ${team.name} → ${team.state}`;
    if (message) {
      return `${message.kind || type} · ${this._agentName(message.fromAgentId)} → ${this._agentName(message.toAgentId)} · ${message.summary || message.content || ''}`;
    }
    if (type.includes('workspace_conflict')) {
      const scopes = Array.isArray(payload.requestedScopes) ? payload.requestedScopes.join(', ') : '';
      return `workspace conflict · ${String(payload.taskId || '')} · ${scopes}`;
    }
    return type.replace(/_/g, ' ');
  }

  private _jobsPanel(): HTMLElement {
    const jobs = this._jobs.getByParent(this._sessionId);
    const panel = this._panel('Process jobs', `${jobs.length} jobs`);
    if (!jobs.length) {
      panel.append(textElement('p', 'Bash and RunProgram background processes are listed separately from Agent tasks.', 'team-cockpit-empty'));
      return panel;
    }
    for (const job of jobs) panel.append(this._jobRow(job));
    return panel;
  }

  private _jobRow(job: TaskEntry): HTMLElement {
    const row = element('div', 'process-job-row');
    row.append(
      textElement('strong', job.summary),
      textElement('span', `${job.status}${job.currentTool ? ` · ${job.currentTool}` : ''}`, 'team-cockpit-muted'),
    );
    return row;
  }

  private _panel(title: string, meta: string): HTMLElement {
    const panel = element('section', 'team-cockpit-panel');
    const header = element('header');
    header.append(textElement('h3', title), textElement('span', meta, 'team-cockpit-muted'));
    panel.append(header);
    return panel;
  }

  private _button(label: string, click: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'team-cockpit-button';
    button.textContent = label;
    button.addEventListener('click', click);
    return button;
  }

  private async _createTeam(): Promise<void> {
    const name = window.prompt('Team name', 'Delivery Team')?.trim();
    if (!name) return;
    const purpose = window.prompt('Team purpose', 'Coordinate parallel work for this session')?.trim();
    if (!purpose) return;
    const ids = window.prompt('Member agent IDs (comma separated)', '') || '';
    await this._mutate(`/api/v1/sessions/${encodeURIComponent(this._rootSessionId)}/teams`, 'POST', {
      name,
      purpose,
      memberAgentIds: ids.split(',').map((id) => id.trim()).filter(Boolean),
    });
  }

  private async _createTask(team?: TeamView): Promise<void> {
    const subject = window.prompt('Task subject')?.trim();
    if (!subject) return;
    const description = window.prompt('Task description', subject)?.trim();
    if (!description) return;
    const acceptance = window.prompt('Acceptance criteria (one per semicolon)', 'Work is complete and verified') || '';
    const writeScope = window.prompt('Write scopes (comma separated); leave blank for read-only', '') || '';
    const scopes = writeScope.split(',').map((scope) => scope.trim()).filter(Boolean);
    await this._mutate(`/api/v1/sessions/${encodeURIComponent(this._rootSessionId)}/tasks`, 'POST', {
      teamId: team?.id,
      subject,
      description,
      acceptanceCriteria: acceptance.split(';').map((item) => item.trim()).filter(Boolean),
      readOnly: scopes.length === 0,
      writeScope: scopes,
    });
  }

  private async _inviteMembers(team: TeamView): Promise<void> {
    const value = window.prompt('Agent IDs to invite (comma separated)', '') || '';
    const addMemberAgentIds = value.split(',').map((id) => id.trim()).filter(Boolean);
    if (!addMemberAgentIds.length) return;
    await this._mutate(`/api/v1/teams/${encodeURIComponent(team.id)}`, 'PATCH', { addMemberAgentIds });
  }

  private async _removeMember(team: TeamView, agentId: string, hasActiveTask: boolean): Promise<void> {
    const confirmed = hasActiveTask
      ? window.confirm(`This member has active work. Cancel it and remove ${this._agentName(agentId)}?`)
      : window.confirm(`Remove ${this._agentName(agentId)} from ${team.name}?`);
    if (!confirmed) return;
    await this._mutate(`/api/v1/teams/${encodeURIComponent(team.id)}`, 'PATCH', {
      removeMemberAgentIds: [agentId],
      force: hasActiveTask,
    });
  }

  private async _assignTask(task: CoordinationTaskView): Promise<void> {
    const targetAgentId = window.prompt('Target agent ID', task.assigneeAgentId || '')?.trim();
    if (!targetAgentId) return;
    await this._mutate(`/api/v1/tasks/${encodeURIComponent(task.id)}/assign`, 'POST', {
      targetAgentId,
      expectedVersion: task.version,
    });
  }

  private async _disbandTeam(team: TeamView): Promise<void> {
    if (!window.confirm(`Disband ${team.name}? Active work will require force confirmation.`)) return;
    const active = this._coordination.stateForSession(this._sessionId)?.tasks.some(
      (task) => task.teamId === team.id && !terminal(task.status),
    );
    const force = active ? window.confirm('This team has active tasks. Stop them and force disband?') : false;
    if (active && !force) return;
    await this._mutate(`/api/v1/teams/${encodeURIComponent(team.id)}`, 'DELETE', { force });
  }

  private async _stopTask(task: CoordinationTaskView): Promise<void> {
    if (!window.confirm(`Stop task "${task.subject}"?`)) return;
    await this._mutate(`/api/v1/tasks/${encodeURIComponent(task.id)}/stop`, 'POST', { reason: 'Stopped from Team Cockpit' });
  }

  private async _retryTask(task: CoordinationTaskView): Promise<void> {
    await this._mutate(`/api/v1/tasks/${encodeURIComponent(task.id)}/retry`, 'POST', {});
  }

  private async _mutate(url: string, method: string, body: Record<string, unknown>): Promise<void> {
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      await this._coordination.loadRoot(this._rootSessionId);
    } catch (error) {
      ToastManager.getInstance().error(error instanceof Error ? error.message : String(error));
    }
  }

  private _agentName(agentId?: string): string {
    if (!agentId) return 'unassigned';
    return this._agents.get(agentId)?.name || agentId;
  }

  private _renderLoading(): void {
    this.container.innerHTML = '';
    this.container.append(textElement('div', 'Loading coordination snapshot…', 'team-cockpit-empty'));
  }

  private _renderError(message: string): void {
    this.container.innerHTML = '';
    this.container.append(textElement('div', message, 'coord-task-error'));
  }

  destroy(): void {
    this._destroyed = true;
    this._jobs.off('changed', this._onJobsChanged);
    this._coordination.off('changed', this._onCoordinationChanged);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string): HTMLElementTagNameMap[K] {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}

function terminal(status: CoordinationTaskView['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function labelStatus(status: CoordinationTaskView['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatDuration(milliseconds: number): string {
  if (!milliseconds) return '0s';
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${(milliseconds / 60_000).toFixed(1)}m`;
}
