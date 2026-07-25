import { EventEmitter } from '../EventEmitter.js';

export interface TeamView {
  id: string;
  rootSessionId: string;
  name: string;
  purpose: string;
  leaderAgentId: string;
  memberAgentIds: string[];
  state: 'forming' | 'active' | 'draining' | 'disbanded';
  autoCreated: boolean;
  autoDisband: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinationTaskView {
  id: string;
  rootSessionId: string;
  sourceSessionId: string;
  teamId?: string;
  mode: 'hierarchy' | 'swarm' | 'subagent';
  subject: string;
  description: string;
  acceptanceCriteria: string[];
  priority: 'urgent' | 'high' | 'normal' | 'low';
  creatorAgentId: string;
  assigneeAgentId?: string;
  dependsOn: string[];
  readOnly: boolean;
  writeScope: string[];
  status: 'pending' | 'claimed' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  version: number;
  attempt: number;
  maxAttempts: number;
  sessionId?: string;
  heartbeatAt?: string;
  progress?: number;
  currentTool?: string;
  blocker?: string;
  resultSummary?: string;
  evidence?: string[];
  tokenUsage?: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface CoordinationMessageView {
  id: string;
  rootSessionId: string;
  teamId?: string;
  taskId?: string;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  content: string;
  summary?: string;
  sequence: number;
  status: string;
  createdAt: string;
}

export interface WorkspaceLeaseView {
  id: string;
  rootSessionId: string;
  taskId: string;
  agentId: string;
  workspace: string;
  scopes: string[];
  acquiredAt: string;
  expiresAt: string;
}

export interface CoordinationEventView {
  eventId: string;
  rootSessionId: string;
  revision: number;
  type: string;
  timestamp: string;
  actorAgentId?: string;
  payload: Record<string, unknown>;
}

export interface CoordinationState {
  rootSessionId: string;
  revision: number;
  teams: TeamView[];
  tasks: CoordinationTaskView[];
  messages: CoordinationMessageView[];
  leases: WorkspaceLeaseView[];
  events: CoordinationEventView[];
  loading: boolean;
  error?: string;
}

export class CoordinationStore extends EventEmitter {
  private static _instance: CoordinationStore | null = null;
  static getInstance(): CoordinationStore {
    if (!this._instance) this._instance = new CoordinationStore();
    return this._instance;
  }

  static resetInstance(): void {
    this._instance?.removeAllListeners();
    this._instance = null;
  }

  private _states = new Map<string, CoordinationState>();
  private _sessionRoots = new Map<string, string>();

  async loadForSession(sessionId: string): Promise<CoordinationState> {
    if (!sessionId) throw new Error('A session is required');
    const rootSessionId = await this._resolveRoot(sessionId);
    return this.loadRoot(rootSessionId);
  }

  async loadRoot(rootSessionId: string): Promise<CoordinationState> {
    const existing = this._states.get(rootSessionId);
    const loading = existing || emptyState(rootSessionId);
    loading.loading = true;
    loading.error = undefined;
    this._states.set(rootSessionId, loading);
    this.emit('changed', rootSessionId);
    try {
      const response = await fetch(`/api/v1/sessions/${encodeURIComponent(rootSessionId)}/tasks`);
      const body = await response.json() as Partial<CoordinationState> & { error?: string };
      if (!response.ok) throw new Error(body.error || `Snapshot request failed (${response.status})`);
      const revision = Number(body.revision || 0);
      const eventResponse = await fetch(
        `/api/v1/sessions/${encodeURIComponent(rootSessionId)}/coordination-events?afterRevision=${Math.max(0, revision - 250)}`,
      );
      const eventBody = await eventResponse.json() as { events?: CoordinationEventView[]; error?: string };
      if (!eventResponse.ok) throw new Error(eventBody.error || `Event replay request failed (${eventResponse.status})`);
      const state: CoordinationState = {
        rootSessionId,
        revision,
        teams: Array.isArray(body.teams) ? body.teams : [],
        tasks: Array.isArray(body.tasks) ? body.tasks : [],
        messages: Array.isArray(body.messages) ? body.messages : [],
        leases: Array.isArray(body.leases) ? body.leases : [],
        events: Array.isArray(eventBody.events) ? eventBody.events : [],
        loading: false,
      };
      for (const event of state.events) {
        if (event.revision > revision) applyDomainEvent(state, event);
      }
      state.revision = Math.max(
        state.revision,
        ...state.events.map((event) => event.revision),
      );
      const current = this._states.get(rootSessionId);
      if (current && current.revision > state.revision) {
        current.loading = false;
        this.emit('changed', rootSessionId);
        return current;
      }
      this._states.set(rootSessionId, state);
      this.emit('changed', rootSessionId);
      return state;
    } catch (error) {
      loading.loading = false;
      loading.error = error instanceof Error ? error.message : String(error);
      this.emit('changed', rootSessionId);
      return loading;
    }
  }

  stateForSession(sessionId: string): CoordinationState | undefined {
    const root = this._sessionRoots.get(sessionId) || sessionId;
    return this._states.get(root);
  }

  rootForSession(sessionId: string): string {
    return this._sessionRoots.get(sessionId) || sessionId;
  }

  applyWs(data: Record<string, unknown>): void {
    const rootSessionId = String(data.rootSessionId || '');
    const revision = Number(data.revision || 0);
    if (!rootSessionId || !revision) return;
    if (data.type === 'coordination_snapshot_required') {
      void this.loadRoot(rootSessionId);
      return;
    }
    const state = this._states.get(rootSessionId);
    if (!state) {
      void this.loadRoot(rootSessionId);
      return;
    }
    if (revision <= state.revision) return;
    if (revision > state.revision + 1) {
      void this.loadRoot(rootSessionId);
      return;
    }
    if (data.team) upsert(state.teams, data.team as TeamView);
    if (data.task) upsert(state.tasks, data.task as CoordinationTaskView);
    if (data.coordinationMessage) upsert(state.messages, data.coordinationMessage as CoordinationMessageView);
    if (data.lease) upsert(state.leases, data.lease as WorkspaceLeaseView);
    state.events.push({
      eventId: `ws-${revision}`,
      rootSessionId,
      revision,
      type: String(data.type || 'coordination_event'),
      timestamp: new Date().toISOString(),
      payload: {
        team: data.team,
        task: data.task,
        message: data.coordinationMessage,
        taskId: data.taskId,
        requestedScopes: data.requestedScopes,
        holder: data.lease,
        reason: data.reason,
      },
    });
    if (state.events.length > 250) state.events.splice(0, state.events.length - 250);
    state.revision = revision;
    this.emit('changed', rootSessionId);
  }

  private async _resolveRoot(sessionId: string): Promise<string> {
    const cached = this._sessionRoots.get(sessionId);
    if (cached) return cached;
    const response = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/root`);
    const body = await response.json() as { sessionId?: string; error?: string };
    if (!response.ok || !body.sessionId) throw new Error(body.error || 'Unable to resolve root session');
    this._sessionRoots.set(sessionId, body.sessionId);
    this._sessionRoots.set(body.sessionId, body.sessionId);
    return body.sessionId;
  }
}

function emptyState(rootSessionId: string): CoordinationState {
  return {
    rootSessionId,
    revision: 0,
    teams: [],
    tasks: [],
    messages: [],
    leases: [],
    events: [],
    loading: false,
  };
}

function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index >= 0) items[index] = value;
  else items.push(value);
}

function applyDomainEvent(state: CoordinationState, event: CoordinationEventView): void {
  const team = event.payload.team as TeamView | undefined;
  const task = event.payload.task as CoordinationTaskView | undefined;
  const message = event.payload.message as CoordinationMessageView | undefined;
  const lease = event.payload.lease as WorkspaceLeaseView | undefined;
  if (team) upsert(state.teams, team);
  if (task) upsert(state.tasks, task);
  if (message) upsert(state.messages, message);
  if (lease && event.type === 'lease_released') {
    const index = state.leases.findIndex((item) => item.id === lease.id);
    if (index >= 0) state.leases.splice(index, 1);
  } else if (lease) {
    upsert(state.leases, lease);
  }
}
