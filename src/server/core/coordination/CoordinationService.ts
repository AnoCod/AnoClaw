import { randomUUID } from 'node:crypto';
import type {
  CoordinationEvent,
  CoordinationEventType,
  CoordinationMessage,
  CoordinationMessageKind,
  CoordinationMessageStatus,
  CoordinationSnapshot,
  CoordinationTask,
  CoordinationTaskPriority,
  CoordinationTaskStatus,
  TeamRecord,
  WorkspaceLease,
} from '../../../shared/types/coordination.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { CoordinationError } from './CoordinationError.js';
import { CoordinationStore } from './CoordinationStore.js';
import {
  WorkspaceLeaseService,
  normalizeScopes,
} from './WorkspaceLeaseService.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';

interface ScopeProjection {
  revision: number;
  teams: Map<string, TeamRecord>;
  tasks: Map<string, CoordinationTask>;
  messages: Map<string, CoordinationMessage>;
  leases: Map<string, WorkspaceLease>;
  idempotencyKeys: Set<string>;
}

export interface CreateTeamInput {
  rootSessionId: string;
  name: string;
  purpose: string;
  leaderAgentId: string;
  memberAgentIds: string[];
  createdByAgentId: string;
  autoCreated?: boolean;
  autoDisband?: boolean;
  idempotencyKey?: string;
}

export interface CreateTaskInput {
  rootSessionId: string;
  sourceSessionId?: string;
  teamId?: string;
  mode: CoordinationTask['mode'];
  subject: string;
  description: string;
  acceptanceCriteria: string[];
  priority?: CoordinationTaskPriority;
  creatorAgentId: string;
  assigneeAgentId?: string;
  dependsOn?: string[];
  readOnly?: boolean;
  writeScope?: string[];
  maxAttempts?: number;
  idempotencyKey?: string;
}

export const CANCELLATION_REQUESTED_BLOCKER = 'cancellation_requested';
export const WAITING_FOR_CHILD_TASKS_BLOCKER = 'waiting_for_child_tasks';
export const CHILD_TASKS_READY_BLOCKER = 'child_tasks_ready';

const TERMINAL_STATUSES = new Set<CoordinationTaskStatus>([
  'completed',
  'failed',
  'cancelled',
]);

const VALID_TRANSITIONS: Record<CoordinationTaskStatus, CoordinationTaskStatus[]> = {
  pending: ['claimed', 'blocked', 'cancelled'],
  claimed: ['running', 'pending', 'blocked', 'cancelled'],
  running: ['blocked', 'completed', 'failed', 'cancelled'],
  blocked: ['pending', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const VALID_MESSAGE_TRANSITIONS: Record<CoordinationMessageStatus, CoordinationMessageStatus[]> = {
  queued: ['delivered', 'dead_letter'],
  delivered: ['acknowledged', 'dead_letter'],
  acknowledged: [],
  dead_letter: [],
};

export class CoordinationService {
  private static instance: CoordinationService | null = null;

  static getInstance(): CoordinationService {
    if (!this.instance) this.instance = new CoordinationService();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  private readonly store = new CoordinationStore();
  private readonly scopes = new Map<string, ScopeProjection>();
  private readonly locks = new Map<string, Promise<void>>();
  private initialized = false;

  private constructor() {}

  async initialize(rootDir: string): Promise<void> {
    await this.store.initialize(rootDir);
    this.scopes.clear();
    WorkspaceLeaseService.getInstance().clear();
    for (const rootSessionId of await this.store.listRootSessionIds()) {
      await this.loadScope(rootSessionId);
    }
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    return this.withScopeLock(input.rootSessionId, async () => {
      const scope = await this.scope(input.rootSessionId);
      if (input.idempotencyKey && scope.idempotencyKeys.has(input.idempotencyKey)) {
        const entityId = await this.idempotentEntityId(
          input.rootSessionId,
          input.idempotencyKey,
          'team',
        );
        const existing = entityId ? scope.teams.get(entityId) : undefined;
        if (existing) return cloneTeam(existing);
      }
      const active = [...scope.teams.values()].find((team) => team.state === 'active' || team.state === 'forming');
      if (active) {
        throw new CoordinationError('conflict', `Root session already has an active team: ${active.id}`);
      }
      const memberAgentIds = uniqueStrings([input.leaderAgentId, ...input.memberAgentIds]);
      const maxMembers = SettingsManager.getInstance().get<number>('coordination.maxTeamMembers', 8);
      if (memberAgentIds.length > maxMembers) {
        throw new CoordinationError('validation', `Team exceeds configured member limit (${maxMembers})`);
      }
      const now = new Date().toISOString();
      const team: TeamRecord = {
        id: `team-${randomUUID()}`,
        rootSessionId: input.rootSessionId,
        name: requiredText(input.name, 'name', 120),
        purpose: requiredText(input.purpose, 'purpose', 4_000),
        leaderAgentId: input.leaderAgentId,
        memberAgentIds,
        state: 'active',
        createdByAgentId: input.createdByAgentId,
        autoCreated: input.autoCreated === true,
        autoDisband: input.autoDisband !== false,
        createdAt: now,
        updatedAt: now,
        revision: scope.revision + 1,
      };
      await this.commit(input.rootSessionId, 'team_created', { team }, input.createdByAgentId, input.idempotencyKey);
      return cloneTeam(team);
    });
  }

  async updateTeam(
    rootSessionId: string,
    teamId: string,
    patch: {
      addMemberAgentIds?: string[];
      removeMemberAgentIds?: string[];
      leaderAgentId?: string;
      state?: TeamRecord['state'];
    },
    actorAgentId: string,
  ): Promise<TeamRecord> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const existing = this.requireTeam(scope, teamId);
      if (existing.state === 'disbanded') {
        throw new CoordinationError('invalid_transition', 'A disbanded team cannot be updated');
      }
      let members = uniqueStrings([...existing.memberAgentIds, ...(patch.addMemberAgentIds || [])]);
      const removing = new Set(patch.removeMemberAgentIds || []);
      members = members.filter((id) => !removing.has(id));
      const leaderAgentId = patch.leaderAgentId || existing.leaderAgentId;
      if (!members.includes(leaderAgentId)) members.unshift(leaderAgentId);
      const maxMembers = SettingsManager.getInstance().get<number>('coordination.maxTeamMembers', 8);
      if (members.length > maxMembers) {
        throw new CoordinationError('validation', `Team exceeds configured member limit (${maxMembers})`);
      }
      const team: TeamRecord = {
        ...existing,
        leaderAgentId,
        memberAgentIds: members,
        state: patch.state || existing.state,
        updatedAt: new Date().toISOString(),
        revision: scope.revision + 1,
      };
      await this.commit(rootSessionId, 'team_updated', { team }, actorAgentId);
      return cloneTeam(team);
    });
  }

  async disbandTeam(rootSessionId: string, teamId: string, actorAgentId: string): Promise<TeamRecord> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const existing = this.requireTeam(scope, teamId);
      if (existing.state === 'disbanded') return cloneTeam(existing);
      const activeTasks = [...scope.tasks.values()].filter(
        (task) => task.teamId === teamId
          && !TERMINAL_STATUSES.has(task.status)
          && task.blocker !== CANCELLATION_REQUESTED_BLOCKER,
      );
      if (activeTasks.length > 0) {
        throw new CoordinationError('conflict', `Team has ${activeTasks.length} non-terminal task(s)`);
      }
      const team: TeamRecord = {
        ...existing,
        state: 'disbanded',
        updatedAt: new Date().toISOString(),
        revision: scope.revision + 1,
      };
      await this.commit(rootSessionId, 'team_disbanded', { team }, actorAgentId);
      return cloneTeam(team);
    });
  }

  async createTask(input: CreateTaskInput): Promise<CoordinationTask> {
    return this.withScopeLock(input.rootSessionId, async () => {
      const scope = await this.scope(input.rootSessionId);
      if (input.teamId) {
        const team = this.requireTeam(scope, input.teamId);
        if (team.state !== 'active') throw new CoordinationError('conflict', 'Team is not active');
        if (input.assigneeAgentId && !team.memberAgentIds.includes(input.assigneeAgentId)) {
          throw new CoordinationError('validation', 'Swarm assignee must be an active team member');
        }
      }
      if (input.idempotencyKey && scope.idempotencyKeys.has(input.idempotencyKey)) {
        const entityId = await this.idempotentEntityId(
          input.rootSessionId,
          input.idempotencyKey,
          'task',
        );
        const existing = entityId ? scope.tasks.get(entityId) : undefined;
        if (existing) return cloneTask(existing);
      }
      const dependsOn = uniqueStrings(input.dependsOn || []);
      for (const dependencyId of dependsOn) {
        if (!scope.tasks.has(dependencyId)) {
          throw new CoordinationError('validation', `Dependency not found in root session: ${dependencyId}`);
        }
      }
      const taskId = `task-${randomUUID()}`;
      this.assertAcyclic(scope, taskId, dependsOn);
      const readOnly = input.readOnly === true;
      if (input.priority && !['urgent', 'high', 'normal', 'low'].includes(input.priority)) {
        throw new CoordinationError('validation', `Invalid task priority: ${input.priority}`);
      }
      const writeScope = readOnly ? [] : normalizeScopes(input.writeScope || ['.']);
      const defaultMaxAttempts = Math.min(10, Math.max(
        1,
        1 + SettingsManager.getInstance().get<number>('coordination.maxAutomaticRetries', 2),
      ));
      const now = new Date().toISOString();
      const task: CoordinationTask = {
        id: taskId,
        rootSessionId: input.rootSessionId,
        sourceSessionId: input.sourceSessionId || input.rootSessionId,
        teamId: input.teamId,
        mode: input.mode,
        subject: requiredText(input.subject, 'subject', 200),
        description: requiredText(input.description, 'description', 20_000),
        acceptanceCriteria: normalizeCriteria(input.acceptanceCriteria),
        priority: input.priority || 'normal',
        creatorAgentId: input.creatorAgentId,
        assigneeAgentId: input.assigneeAgentId,
        dependsOn,
        readOnly,
        writeScope,
        status: 'pending',
        version: 1,
        attempt: 0,
        maxAttempts: clampInteger(input.maxAttempts, defaultMaxAttempts, 1, 10),
        createdAt: now,
        updatedAt: now,
      };
      await this.commit(input.rootSessionId, 'task_created', { task }, input.creatorAgentId, input.idempotencyKey);
      return cloneTask(task);
    });
  }

  async assignTask(
    rootSessionId: string,
    taskId: string,
    targetAgentId: string,
    actorAgentId: string,
    expectedVersion?: number,
  ): Promise<CoordinationTask> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const existing = this.requireTask(scope, taskId);
      this.assertVersion(existing, expectedVersion);
      if (existing.status !== 'pending' && existing.status !== 'blocked') {
        throw new CoordinationError('invalid_transition', `Cannot assign a ${existing.status} task`);
      }
      if (existing.teamId) {
        const team = this.requireTeam(scope, existing.teamId);
        if (!team.memberAgentIds.includes(targetAgentId)) {
          throw new CoordinationError('validation', 'Assignee must be a team member');
        }
      }
      const task: CoordinationTask = {
        ...existing,
        assigneeAgentId: targetAgentId,
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.commit(rootSessionId, 'task_updated', { task }, actorAgentId);
      return cloneTask(task);
    });
  }

  async claimTask(
    rootSessionId: string,
    taskId: string,
    agentId: string,
    expectedVersion?: number,
  ): Promise<CoordinationTask> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const existing = this.requireTask(scope, taskId);
      this.assertVersion(existing, expectedVersion);
      if (existing.status !== 'pending') {
        throw new CoordinationError('conflict', `Task is already ${existing.status}`);
      }
      if (!this.dependenciesCompleted(scope, existing)) {
        throw new CoordinationError('conflict', 'Task dependencies are not complete');
      }
      if (existing.assigneeAgentId && existing.assigneeAgentId !== agentId) {
        throw new CoordinationError('conflict', `Task is assigned to ${existing.assigneeAgentId}`);
      }
      if (existing.mode !== 'swarm' && !existing.assigneeAgentId) {
        throw new CoordinationError('conflict', 'Hierarchy and SubAgent tasks must be assigned before claim');
      }
      if (existing.teamId) {
        const team = this.requireTeam(scope, existing.teamId);
        if (!team.memberAgentIds.includes(agentId)) {
          throw new CoordinationError('forbidden', 'Only team members can claim this task');
        }
      }
      const now = new Date().toISOString();
      const task: CoordinationTask = {
        ...existing,
        assigneeAgentId: agentId,
        status: 'claimed',
        claimedAt: now,
        version: existing.version + 1,
        updatedAt: now,
      };
      await this.commit(rootSessionId, 'task_updated', { task }, agentId);
      return cloneTask(task);
    });
  }

  async updateTask(
    rootSessionId: string,
    taskId: string,
    patch: Partial<Pick<
      CoordinationTask,
      'status' | 'sessionId' | 'heartbeatAt' | 'progress' | 'currentTool' | 'blocker'
      | 'resultSummary' | 'outputRef' | 'evidence' | 'tokenUsage' | 'error'
    >>,
    actorAgentId: string,
    expectedVersion?: number,
  ): Promise<CoordinationTask> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const existing = this.requireTask(scope, taskId);
      this.assertVersion(existing, expectedVersion);
      if (patch.status && patch.status !== existing.status) {
        const allowed = VALID_TRANSITIONS[existing.status];
        if (!allowed.includes(patch.status)) {
          throw new CoordinationError(
            'invalid_transition',
            `Invalid task transition: ${existing.status} -> ${patch.status}`,
          );
        }
        if (patch.status === 'running' && !this.dependenciesCompleted(scope, existing)) {
          throw new CoordinationError('conflict', 'Task dependencies are not complete');
        }
      }
      const now = new Date().toISOString();
      const nextStatus = patch.status || existing.status;
      const task: CoordinationTask = {
        ...existing,
        ...patch,
        progress: patch.progress === undefined
          ? existing.progress
          : Math.max(0, Math.min(100, Math.round(patch.progress))),
        version: existing.version + 1,
        attempt: nextStatus === 'running' && existing.status !== 'running'
          ? existing.attempt + 1
          : existing.attempt,
        startedAt: nextStatus === 'running' && !existing.startedAt ? now : existing.startedAt,
        completedAt: TERMINAL_STATUSES.has(nextStatus) ? now : existing.completedAt,
        updatedAt: now,
      };
      await this.commit(rootSessionId, 'task_updated', { task }, actorAgentId);
      if (TERMINAL_STATUSES.has(task.status)) {
        await this.releaseTaskLeasesUnlocked(scope, task, actorAgentId);
      }
      return cloneTask(task);
    });
  }

  /**
   * A running task remains running until its AgentLoop exits, so its workspace
   * lease stays renewable. Other states can become cancelled immediately.
   */
  async requestTaskCancellation(
    rootSessionId: string,
    taskId: string,
    actorAgentId: string,
    reason: string,
  ): Promise<CoordinationTask> {
    let cancellationInterrupt:
      | { sessionId: string; kind: 'self' | 'creator' | 'coordinator' }
      | undefined;
    const result = await this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const current = this.requireTask(scope, taskId);
      if (TERMINAL_STATUSES.has(current.status)) return cloneTask(current);

      const now = new Date().toISOString();
      const waitsForLoopExit = current.status === 'running' && !!current.sessionId;
      const task: CoordinationTask = {
        ...current,
        ...(waitsForLoopExit
          ? { blocker: CANCELLATION_REQUESTED_BLOCKER, error: reason }
          : { status: 'cancelled' as const, error: reason, completedAt: now }),
        version: current.version + 1,
        updatedAt: now,
      };
      await this.commit(rootSessionId, 'task_updated', { task }, actorAgentId);
      if (waitsForLoopExit && task.sessionId) {
        cancellationInterrupt = {
          sessionId: task.sessionId,
          kind: actorAgentId === task.assigneeAgentId
            ? 'self'
            : actorAgentId === task.creatorAgentId
              ? 'creator'
              : 'coordinator',
        };
      }
      if (!waitsForLoopExit) {
        await this.releaseTaskLeasesUnlocked(scope, task, actorAgentId);
      }
      return cloneTask(task);
    });
    if (cancellationInterrupt) {
      // Keep cancellation attribution next to the state transition so every
      // caller (tool, REST route, forced team update) gets identical semantics.
      // Dynamic import avoids coupling coordination storage initialization to
      // the agent runtime during startup.
      const { InterruptController, InterruptReason } = await import(
        '../agent/supervision/InterruptController.js'
      );
      const interruptReason = cancellationInterrupt.kind === 'self'
        ? InterruptReason.TaskSelfCancel
        : cancellationInterrupt.kind === 'creator'
          ? InterruptReason.TaskCreatorCancel
          : InterruptReason.TaskCoordinatorCancel;
      InterruptController.getInstance().requestInterruptWhenAvailable(
        cancellationInterrupt.sessionId,
        interruptReason,
      );
    }
    return result;
  }

  async retryTask(rootSessionId: string, taskId: string, actorAgentId: string): Promise<CoordinationTask> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const existing = this.requireTask(scope, taskId);
      if (existing.status !== 'failed' && existing.status !== 'cancelled' && existing.status !== 'blocked') {
        throw new CoordinationError('invalid_transition', `Cannot retry a ${existing.status} task`);
      }
      if (existing.attempt >= existing.maxAttempts) {
        throw new CoordinationError('conflict', 'Task retry limit reached');
      }
      const task: CoordinationTask = {
        ...existing,
        status: 'pending',
        blocker: undefined,
        error: undefined,
        currentTool: undefined,
        heartbeatAt: undefined,
        completedAt: undefined,
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.commit(rootSessionId, 'task_updated', { task }, actorAgentId);
      return cloneTask(task);
    });
  }

  async queueMessage(input: {
    rootSessionId: string;
    teamId?: string;
    taskId?: string;
    fromAgentId: string;
    toAgentId: string;
    kind: CoordinationMessageKind;
    content: string;
    summary?: string;
    idempotencyKey?: string;
  }): Promise<CoordinationMessage> {
    return this.withScopeLock(input.rootSessionId, async () => {
      const scope = await this.scope(input.rootSessionId);
      if (input.idempotencyKey && scope.idempotencyKeys.has(input.idempotencyKey)) {
        const entityId = await this.idempotentEntityId(
          input.rootSessionId,
          input.idempotencyKey,
          'message',
        );
        const existing = entityId ? scope.messages.get(entityId) : undefined;
        if (existing) return cloneMessage(existing);
      }
      const sequence = [...scope.messages.values()]
        .filter((message) => message.toAgentId === input.toAgentId)
        .reduce((max, message) => Math.max(max, message.sequence), 0) + 1;
      const message: CoordinationMessage = {
        id: `msg-${randomUUID()}`,
        rootSessionId: input.rootSessionId,
        teamId: input.teamId,
        taskId: input.taskId,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        kind: input.kind,
        content: requiredText(input.content, 'content', 20_000),
        summary: input.summary?.trim().slice(0, 120) || undefined,
        sequence,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      await this.commit(input.rootSessionId, 'message_queued', { message }, input.fromAgentId, input.idempotencyKey);
      return cloneMessage(message);
    });
  }

  async updateMessageStatus(
    rootSessionId: string,
    messageId: string,
    status: CoordinationMessageStatus,
    actorAgentId: string,
    error?: string,
  ): Promise<CoordinationMessage> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const existing = scope.messages.get(messageId);
      if (!existing) throw new CoordinationError('not_found', `Message not found: ${messageId}`);
      if (status !== existing.status && !VALID_MESSAGE_TRANSITIONS[existing.status].includes(status)) {
        throw new CoordinationError(
          'invalid_transition',
          `Invalid message transition: ${existing.status} -> ${status}`,
        );
      }
      if (status === existing.status) return cloneMessage(existing);
      const now = new Date().toISOString();
      const message: CoordinationMessage = {
        ...existing,
        status,
        error: error?.slice(0, 1_000),
        deliveredAt: status === 'delivered' ? now : existing.deliveredAt,
        acknowledgedAt: status === 'acknowledged' ? now : existing.acknowledgedAt,
      };
      await this.commit(rootSessionId, 'message_updated', { message }, actorAgentId);
      return cloneMessage(message);
    });
  }

  async acquireTaskLease(
    rootSessionId: string,
    taskId: string,
    workspace: string,
    ttlMs: number,
  ): Promise<WorkspaceLease | null> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const task = this.requireTask(scope, taskId);
      if (task.readOnly || task.writeScope.length === 0) return null;
      const result = WorkspaceLeaseService.getInstance().acquire({
        rootSessionId,
        taskId,
        agentId: task.assigneeAgentId || task.creatorAgentId,
        workspace,
        scopes: task.writeScope,
        ttlMs,
      });
      if (result.conflict) {
        await this.commit(rootSessionId, 'workspace_conflict', {
          taskId,
          requestedScopes: result.conflict.requestedScopes,
          holder: result.conflict.holder,
        }, task.assigneeAgentId || task.creatorAgentId);
        return null;
      }
      await this.commit(rootSessionId, 'lease_acquired', { lease: result.lease! }, task.assigneeAgentId);
      return result.lease!;
    });
  }

  async releaseTaskLeases(rootSessionId: string, taskId: string, actorAgentId: string): Promise<void> {
    return this.withScopeLock(rootSessionId, async () => {
      const scope = await this.scope(rootSessionId);
      const task = this.requireTask(scope, taskId);
      await this.releaseTaskLeasesUnlocked(scope, task, actorAgentId);
    });
  }

  async renewTaskLeases(
    rootSessionId: string,
    taskId: string,
    ttlMs: number,
    actorAgentId: string,
  ): Promise<WorkspaceLease[]> {
    return this.withScopeLock(rootSessionId, async () => {
      const renewed: WorkspaceLease[] = [];
      for (const lease of WorkspaceLeaseService.getInstance().getForTask(taskId)) {
        const next = WorkspaceLeaseService.getInstance().renew(lease.id, ttlMs);
        if (!next) continue;
        renewed.push(next);
        await this.commit(rootSessionId, 'lease_renewed', { lease: next }, actorAgentId);
      }
      return renewed;
    });
  }

  getSnapshot(rootSessionId: string): CoordinationSnapshot {
    const scope = this.scopes.get(rootSessionId) || emptyScope();
    return snapshotFromScope(rootSessionId, scope);
  }

  listTeams(rootSessionId: string): TeamRecord[] {
    return this.getSnapshot(rootSessionId).teams;
  }

  getActiveTeam(rootSessionId: string): TeamRecord | undefined {
    return this.listTeams(rootSessionId).find((team) => team.state === 'active');
  }

  getTeam(rootSessionId: string, teamId: string): TeamRecord | undefined {
    const team = this.scopes.get(rootSessionId)?.teams.get(teamId);
    return team ? cloneTeam(team) : undefined;
  }

  findTeam(teamId: string): TeamRecord | undefined {
    for (const scope of this.scopes.values()) {
      const team = scope.teams.get(teamId);
      if (team) return cloneTeam(team);
    }
    return undefined;
  }

  listTasks(rootSessionId: string): CoordinationTask[] {
    return this.getSnapshot(rootSessionId).tasks;
  }

  /**
   * Return only tasks created by this task's owned execution session during
   * the current durable task lifetime. Session ownership itself is verified
   * by the scheduler/runtime because SessionManager owns that metadata.
   */
  listDirectChildTasks(parent: CoordinationTask): CoordinationTask[] {
    if (
      !parent.sessionId
      || !parent.assigneeAgentId
      || !parent.startedAt
      || parent.attempt < 1
    ) {
      return [];
    }
    const startedAt = Date.parse(parent.startedAt);
    if (!Number.isFinite(startedAt)) return [];
    return this.listTasks(parent.rootSessionId)
      .filter((candidate) => candidate.id !== parent.id)
      .filter((candidate) => candidate.sourceSessionId === parent.sessionId)
      .filter((candidate) => candidate.creatorAgentId === parent.assigneeAgentId)
      .filter((candidate) => {
        const createdAt = Date.parse(candidate.createdAt);
        return Number.isFinite(createdAt) && createdAt >= startedAt;
      });
  }

  isTaskTerminal(task: CoordinationTask): boolean {
    return TERMINAL_STATUSES.has(task.status);
  }

  /**
   * A terminal child is consumable only after its exact final result has been
   * appended to the source session. deliverCoordinationResult marks the
   * message delivered only after that durable append.
   */
  hasConsumableTaskResult(task: CoordinationTask): boolean {
    if (!TERMINAL_STATUSES.has(task.status)) return false;
    const terminalAt = Date.parse(task.completedAt || task.updatedAt);
    return this.listMessages(task.rootSessionId).some((message) => (
      message.kind === 'task_result'
      && message.taskId === task.id
      && message.fromAgentId === (task.assigneeAgentId || task.creatorAgentId)
      && message.toAgentId === task.creatorAgentId
      && (message.status === 'delivered' || message.status === 'acknowledged')
      && message.summary === `${task.subject}: ${task.status}`
      && (
        !Number.isFinite(terminalAt)
        || Date.parse(message.createdAt) >= terminalAt
      )
    ));
  }

  getTask(rootSessionId: string, taskId: string): CoordinationTask | undefined {
    const task = this.scopes.get(rootSessionId)?.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  findTask(taskId: string): CoordinationTask | undefined {
    for (const scope of this.scopes.values()) {
      const task = scope.tasks.get(taskId);
      if (task) return cloneTask(task);
    }
    return undefined;
  }

  findTaskBySession(sessionId: string, includeTerminal = false): CoordinationTask | undefined {
    for (const scope of this.scopes.values()) {
      const task = [...scope.tasks.values()]
        .filter((candidate) => candidate.sessionId === sessionId)
        .filter((candidate) => includeTerminal || !TERMINAL_STATUSES.has(candidate.status))
        .sort((left, right) => {
          const terminalOrder = Number(TERMINAL_STATUSES.has(left.status))
            - Number(TERMINAL_STATUSES.has(right.status));
          return terminalOrder || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        })[0];
      if (task) return cloneTask(task);
    }
    return undefined;
  }

  listMessages(rootSessionId: string, toAgentId?: string): CoordinationMessage[] {
    return this.getSnapshot(rootSessionId).messages
      .filter((message) => !toAgentId || message.toAgentId === toAgentId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  pendingMessages(rootSessionId: string, toAgentId: string, limit = 20): CoordinationMessage[] {
    return this.listMessages(rootSessionId, toAgentId)
      .filter((message) => message.status === 'queued')
      .slice(0, limit);
  }

  async eventsAfter(rootSessionId: string, revision: number): Promise<CoordinationEvent[]> {
    return this.store.readEvents(rootSessionId, revision);
  }

  isTaskReady(rootSessionId: string, taskId: string): boolean {
    const scope = this.scopes.get(rootSessionId);
    const task = scope?.tasks.get(taskId);
    return !!scope && !!task && task.status === 'pending' && this.dependenciesCompleted(scope, task);
  }

  private async loadScope(rootSessionId: string): Promise<ScopeProjection> {
    const scope = emptyScope();
    const snapshot = await this.store.readSnapshot(rootSessionId);
    if (snapshot?.schemaVersion === 1) {
      scope.revision = snapshot.revision;
      for (const team of snapshot.teams) scope.teams.set(team.id, team);
      for (const task of snapshot.tasks) scope.tasks.set(task.id, task);
      for (const message of snapshot.messages) scope.messages.set(message.id, message);
      for (const key of snapshot.idempotencyKeys || []) scope.idempotencyKeys.add(key);
      const liveLeases = snapshot.leases.filter((lease) => Date.parse(lease.expiresAt) > Date.now());
      for (const lease of liveLeases) scope.leases.set(lease.id, lease);
      WorkspaceLeaseService.getInstance().restore(liveLeases);
    }
    const events = await this.store.readEvents(rootSessionId, scope.revision);
    for (const event of events) this.applyEvent(scope, event);
    this.scopes.set(rootSessionId, scope);
    await this.store.writeSnapshot(snapshotFromScope(rootSessionId, scope));
    return scope;
  }

  private async scope(rootSessionId: string): Promise<ScopeProjection> {
    return this.scopes.get(rootSessionId) || this.loadScope(rootSessionId);
  }

  private async commit(
    rootSessionId: string,
    type: CoordinationEventType,
    payload: Record<string, unknown>,
    actorAgentId?: string,
    idempotencyKey?: string,
  ): Promise<CoordinationEvent> {
    const scope = await this.scope(rootSessionId);
    const event: CoordinationEvent = {
      schemaVersion: 1,
      eventId: `coord-${randomUUID()}`,
      rootSessionId,
      revision: scope.revision + 1,
      type,
      timestamp: new Date().toISOString(),
      actorAgentId,
      idempotencyKey,
      payload,
    };
    await this.store.append(event);
    this.applyEvent(scope, event);
    await this.store.writeSnapshot(snapshotFromScope(rootSessionId, scope));
    this.emitDomainEvent(event);
    return event;
  }

  private applyEvent(scope: ScopeProjection, event: CoordinationEvent): void {
    if (event.revision <= scope.revision) return;
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'team_created' || event.type === 'team_updated' || event.type === 'team_disbanded') {
      const team = payload.team as TeamRecord;
      if (team) scope.teams.set(team.id, team);
    } else if (event.type === 'task_created' || event.type === 'task_updated') {
      const task = payload.task as CoordinationTask;
      if (task) scope.tasks.set(task.id, task);
    } else if (event.type === 'message_queued' || event.type === 'message_updated') {
      const message = payload.message as CoordinationMessage;
      if (message) scope.messages.set(message.id, message);
    } else if (event.type === 'lease_acquired' || event.type === 'lease_renewed') {
      const lease = payload.lease as WorkspaceLease;
      if (lease) scope.leases.set(lease.id, lease);
    } else if (event.type === 'lease_released') {
      const lease = payload.lease as WorkspaceLease;
      if (lease) scope.leases.delete(lease.id);
    }
    if (event.idempotencyKey) scope.idempotencyKeys.add(event.idempotencyKey);
    scope.revision = event.revision;
  }

  private emitDomainEvent(event: CoordinationEvent): void {
    const payload = event.payload as Record<string, unknown>;
    if (event.type.startsWith('team_')) {
      TypedEventBus.emit('coordination:team_changed', {
        rootSessionId: event.rootSessionId,
        revision: event.revision,
        team: payload.team as TeamRecord,
      });
    } else if (event.type.startsWith('task_')) {
      TypedEventBus.emit('coordination:task_changed', {
        rootSessionId: event.rootSessionId,
        revision: event.revision,
        task: payload.task as CoordinationTask,
      });
    } else if (event.type.startsWith('message_')) {
      TypedEventBus.emit('coordination:message', {
        rootSessionId: event.rootSessionId,
        revision: event.revision,
        message: payload.message as CoordinationMessage,
      });
    } else if (event.type === 'workspace_conflict') {
      TypedEventBus.emit('coordination:workspace_conflict', {
        rootSessionId: event.rootSessionId,
        revision: event.revision,
        taskId: String(payload.taskId || ''),
        requestedScopes: (payload.requestedScopes || []) as string[],
        holder: payload.holder as WorkspaceLease,
      });
    } else if (event.type.startsWith('lease_')) {
      TypedEventBus.emit('coordination:snapshot_required', {
        rootSessionId: event.rootSessionId,
        revision: event.revision,
        reason: event.type,
      });
    }
  }

  private async releaseTaskLeasesUnlocked(
    scope: ScopeProjection,
    task: CoordinationTask,
    actorAgentId: string,
  ): Promise<void> {
    const released = WorkspaceLeaseService.getInstance().releaseTask(task.id);
    for (const lease of released) {
      await this.commit(task.rootSessionId, 'lease_released', { lease }, actorAgentId);
      scope.leases.delete(lease.id);
    }
  }

  private requireTask(scope: ScopeProjection, taskId: string): CoordinationTask {
    const task = scope.tasks.get(taskId);
    if (!task) throw new CoordinationError('not_found', `Task not found: ${taskId}`);
    return task;
  }

  private requireTeam(scope: ScopeProjection, teamId: string): TeamRecord {
    const team = scope.teams.get(teamId);
    if (!team) throw new CoordinationError('not_found', `Team not found: ${teamId}`);
    return team;
  }

  private assertVersion(task: CoordinationTask, expectedVersion?: number): void {
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw new CoordinationError(
        'conflict',
        `Task version conflict: expected ${expectedVersion}, current ${task.version}`,
      );
    }
  }

  private dependenciesCompleted(scope: ScopeProjection, task: CoordinationTask): boolean {
    return task.dependsOn.every((id) => scope.tasks.get(id)?.status === 'completed');
  }

  private async idempotentEntityId(
    rootSessionId: string,
    idempotencyKey: string,
    entity: 'team' | 'task' | 'message',
  ): Promise<string | undefined> {
    const event = (await this.store.readEvents(rootSessionId, 0))
      .find((candidate) => candidate.idempotencyKey === idempotencyKey);
    const value = (event?.payload as Record<string, unknown> | undefined)?.[entity];
    return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : undefined;
  }

  private assertAcyclic(scope: ScopeProjection, taskId: string, dependsOn: string[]): void {
    const visit = (current: string, seen: Set<string>): boolean => {
      if (current === taskId) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      const task = scope.tasks.get(current);
      return !!task && task.dependsOn.some((dependency) => visit(dependency, seen));
    };
    if (dependsOn.some((dependency) => visit(dependency, new Set()))) {
      throw new CoordinationError('validation', `Task dependency cycle detected for ${taskId}`);
    }
  }

  private async withScopeLock<T>(rootSessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(rootSessionId) || Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => next);
    this.locks.set(rootSessionId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(rootSessionId) === tail) this.locks.delete(rootSessionId);
    }
  }
}

function emptyScope(): ScopeProjection {
  return {
    revision: 0,
    teams: new Map(),
    tasks: new Map(),
    messages: new Map(),
    leases: new Map(),
    idempotencyKeys: new Set(),
  };
}

function snapshotFromScope(rootSessionId: string, scope: ScopeProjection): CoordinationSnapshot {
  const now = Date.now();
  return {
    schemaVersion: 1,
    rootSessionId,
    revision: scope.revision,
    teams: [...scope.teams.values()].map(cloneTeam),
    tasks: [...scope.tasks.values()].map(cloneTask),
    messages: [...scope.messages.values()].map(cloneMessage),
    leases: [...scope.leases.values()]
      .filter((lease) => Date.parse(lease.expiresAt) > now)
      .map((lease) => ({ ...lease, scopes: [...lease.scopes] })),
    idempotencyKeys: [...scope.idempotencyKeys],
  };
}

function cloneTeam(team: TeamRecord): TeamRecord {
  return { ...team, memberAgentIds: [...team.memberAgentIds] };
}

function cloneTask(task: CoordinationTask): CoordinationTask {
  return {
    ...task,
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependsOn: [...task.dependsOn],
    writeScope: [...task.writeScope],
    evidence: task.evidence ? [...task.evidence] : undefined,
  };
}

function cloneMessage(message: CoordinationMessage): CoordinationMessage {
  return { ...message };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requiredText(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new CoordinationError('validation', `${field} is required`);
  if (normalized.length > max) throw new CoordinationError('validation', `${field} exceeds ${max} characters`);
  return normalized;
}

function normalizeCriteria(values: string[]): string[] {
  const criteria = uniqueStrings(values).slice(0, 50);
  if (criteria.length === 0) throw new CoordinationError('validation', 'At least one acceptance criterion is required');
  return criteria;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value!)));
}
