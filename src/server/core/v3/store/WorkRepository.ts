import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type {
  AppendEventOptions,
  CoordinationMessage,
  Mission,
  OrchestrationDecision,
  ProjectionCheckpoint,
  Run,
  Session,
  Task,
  TaskReport,
  TokenUsage,
  ToolCallJournalRecord,
  VerificationRecord,
  VerificationPolicy,
  Work,
  WorkEvent,
  WorkEventEnvelope,
  WorkProjection,
  WorkspaceExecution,
  WorkspaceLeaseRecord,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import { AppendOnlyEventStore } from './AppendOnlyEventStore.js';

export interface WorkRepositoryOptions {
  clock?: () => string;
  idFactory?: () => string;
  store?: AppendOnlyEventStore;
}

export interface WorkRepositoryChange {
  workId: string;
  revision: number;
  event: WorkEvent;
}

export interface ClaimTaskExecutionInput {
  taskId: string;
  agentId: string;
  sessionId: string;
  actorSnapshot: Session['actorSnapshot'];
  maxTurns: number;
  runId?: string;
  decisionId?: string;
  decisionReason?: string;
  candidateAgentIds?: string[];
}

export interface ClaimTaskExecutionResult {
  task: Task;
  run: Run;
  session: Session;
  decision: OrchestrationDecision;
  revision: number;
}

export interface StartTaskExecutionInput {
  runId: string;
  workspaceExecution?: WorkspaceExecution;
  leases?: Array<Omit<
    WorkspaceLeaseRecord,
    'workId' | 'ownerRunId' | 'ownerTaskId' | 'ownerAgentId' | 'status' | 'acquiredAt'
  >>;
}

export interface FinishTaskExecutionInput {
  runId: string;
  taskStatus: Extract<Task['status'], 'submitted' | 'failed' | 'blocked' | 'cancelled'>;
  runStatus: Extract<Run['status'], 'succeeded' | 'failed' | 'cancelled' | 'recovery_required'>;
  terminationReason: NonNullable<Run['terminationReason']>;
  turnsConsumed?: number;
  tokenUsage?: TokenUsage;
  cost?: Run['cost'];
  toolCount?: number;
  lastCompletedToolCallId?: string;
  resultSummary?: string;
  error?: string;
  report?: Omit<TaskReport, 'id' | 'taskId' | 'runId' | 'agentId' | 'createdAt'> & {
    id?: string;
  };
  decision?: Omit<
    OrchestrationDecision,
    'id' | 'workId' | 'missionId' | 'taskId' | 'runId' | 'createdAt'
  > & { id?: string };
}

export interface GateTaskVerificationInput {
  runId: string;
  taskStatus: Extract<Task['status'], 'completed' | 'verifying' | 'revision_required'>;
  verification: Omit<
    VerificationRecord,
    'id' | 'workId' | 'missionId' | 'taskId' | 'runId' | 'workerAgentId' | 'createdAt'
  > & { id?: string };
}

export interface CompleteTaskVerificationInput {
  verificationId: string;
  outcome: Extract<VerificationRecord['outcome'], 'approved' | 'revision_required'>;
  summary: string;
  criteria: VerificationRecord['criteria'];
}

export type WorkUpdate = Partial<Pick<
  Work,
  | 'title'
  | 'objective'
  | 'status'
  | 'workspaceId'
  | 'focusMissionId'
  | 'completedAt'
  | 'archivedAt'
>>;
export type MissionUpdate = Partial<Pick<
  Mission,
  | 'title'
  | 'objective'
  | 'acceptanceCriteria'
  | 'priority'
  | 'verificationPolicy'
  | 'status'
  | 'teamId'
  | 'ownerAgentId'
  | 'completedAt'
>>;
export type TaskUpdate = Partial<Pick<
  Task,
  | 'title'
  | 'description'
  | 'acceptanceCriteria'
  | 'status'
  | 'priority'
  | 'teamId'
  | 'assignedAgentId'
  | 'dependsOnTaskIds'
  | 'readOnly'
  | 'writeScope'
  | 'dueAt'
  | 'completedAt'
>>;
export type RunUpdate = Partial<Pick<
  Run,
  | 'status'
  | 'turnsConsumed'
  | 'heartbeatAt'
  | 'fencingToken'
  | 'lastCompletedToolCallId'
  | 'tokenUsage'
  | 'cost'
  | 'toolCount'
  | 'workspaceExecution'
  | 'startedAt'
  | 'finishedAt'
  | 'terminationReason'
  | 'resultSummary'
  | 'error'
>>;
export type SessionUpdate = Partial<Pick<
  Session,
  'status' | 'transcriptRevision' | 'closedAt'
>>;
export type WorkspaceLeaseUpdate = Partial<Pick<
  WorkspaceLeaseRecord,
  'status' | 'expiresAt' | 'renewedAt' | 'releasedAt' | 'releaseReason'
>>;
export type VerificationUpdate = Partial<Pick<
  VerificationRecord,
  'outcome' | 'summary' | 'criteria' | 'completedAt'
>>;

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  mode: 'automatic',
  requireDifferentAgent: false,
  maxRevisionAttempts: 2,
  requiredEvidence: [],
};

export class WorkRepository extends EventEmitter {
  private readonly store: AppendOnlyEventStore;
  private readonly clock: () => string;
  private readonly idFactory: () => string;

  constructor(
    rootDir = path.resolve('data', 'v3'),
    options: WorkRepositoryOptions = {},
  ) {
    super();
    this.store = options.store ?? new AppendOnlyEventStore(rootDir);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async listWorkIds(): Promise<string[]> {
    return this.store.listWorkIds();
  }

  async getProjection(workId: string, rebuild = false): Promise<WorkProjection> {
    const events = await this.store.readWorkEvents(workId);
    if (events.length === 0) return emptyWorkProjection();
    if (!rebuild) {
      const checkpoint = await this.store.readCheckpoint<WorkProjection>('work', workId);
      if (isUsableCheckpoint(checkpoint, events)) {
        const projection = events
          .slice(checkpoint.revision)
          .reduce(applyWorkEvent, checkpoint.projection);
        if (projection.revision !== checkpoint.revision) {
          await this.writeCheckpoint(workId, projection, events.at(-1)?.eventId ?? null);
        }
        return projection;
      }
    }
    return this.rebuildProjection(workId, events);
  }

  async rebuildProjection(
    workId: string,
    knownEvents?: WorkEventEnvelope[],
  ): Promise<WorkProjection> {
    const events = knownEvents ?? await this.store.readWorkEvents(workId);
    const projection = events.reduce(applyWorkEvent, emptyWorkProjection());
    if (events.length > 0) {
      await this.writeCheckpoint(workId, projection, events.at(-1)?.eventId ?? null);
    }
    return projection;
  }

  async getWork(workId: string): Promise<Work | null> {
    return (await this.getProjection(workId)).work;
  }

  async listEvents(workId: string, afterRevision = 0): Promise<WorkEventEnvelope[]> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new V3DomainError('INVALID_ARGUMENT', 'afterRevision must be a non-negative integer');
    }
    return (await this.store.readWorkEvents(workId))
      .filter((event) => event.revision > afterRevision);
  }

  async createWork(
    input: {
      id?: string;
      companyId: string;
      workspaceId?: string;
      primarySessionId: string;
      focusMissionId?: string;
      title: string;
      objective: string;
      status?: Work['status'];
    },
    options: AppendEventOptions,
  ): Promise<Work> {
    requireText(input.companyId, 'companyId');
    requireText(input.primarySessionId, 'work primarySessionId');
    requireText(input.title, 'work title');
    requireText(input.objective, 'work objective');
    const id = input.id ?? this.idFactory();
    const existing = await this.getProjection(id);
    if (existing.work) throw alreadyExists('Work', id);
    const now = options.occurredAt ?? this.clock();
    const work: Work = {
      id,
      companyId: input.companyId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      primarySessionId: input.primarySessionId,
      ...(input.focusMissionId ? { focusMissionId: input.focusMissionId } : {}),
      title: input.title,
      objective: input.objective,
      status: input.status ?? 'draft',
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit(id, { type: 'work.created', work }, options);
    return requireEntity(next.work, 'Work was not projected');
  }

  async updateWork(
    workId: string,
    update: WorkUpdate,
    options: AppendEventOptions,
  ): Promise<Work> {
    const projection = await this.requireWorkProjection(workId);
    if (update.title !== undefined) requireText(update.title, 'work title');
    if (update.objective !== undefined) requireText(update.objective, 'work objective');
    if (update.focusMissionId !== undefined) {
      requireEntity(
        projection.missions[update.focusMissionId],
        `Mission not found: ${update.focusMissionId}`,
      );
    }
    const work: Work = {
      ...projection.work,
      ...defined(update),
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit(workId, { type: 'work.updated', work }, options);
    return requireEntity(next.work, 'Work was not projected');
  }

  async createMission(
    workId: string,
    input: {
      id?: string;
      title: string;
      objective: string;
      acceptanceCriteria?: string[];
      priority?: Mission['priority'];
      verificationPolicy?: VerificationPolicy;
      status?: Mission['status'];
      teamId?: string;
      ownerAgentId?: string;
    },
    options: AppendEventOptions,
  ): Promise<Mission> {
    const projection = await this.requireWorkProjection(workId);
    requireText(input.title, 'mission title');
    requireText(input.objective, 'mission objective');
    const acceptanceCriteria = normalizedStrings(
      input.acceptanceCriteria ?? [],
      'mission acceptanceCriteria',
    );
    const verificationPolicy = normalizeVerificationPolicy(
      input.verificationPolicy ?? DEFAULT_VERIFICATION_POLICY,
    );
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.missions[id], 'Mission', id);
    const now = options.occurredAt ?? this.clock();
    const mission: Mission = {
      id,
      workId,
      title: input.title,
      objective: input.objective,
      acceptanceCriteria,
      priority: input.priority ?? 'normal',
      verificationPolicy,
      status: input.status ?? 'planned',
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.ownerAgentId ? { ownerAgentId: input.ownerAgentId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const next = await this.commit(workId, { type: 'mission.created', mission }, options);
    return next.missions[id]!;
  }

  async updateMission(
    workId: string,
    missionId: string,
    update: MissionUpdate,
    options: AppendEventOptions,
  ): Promise<Mission> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(projection.missions[missionId], `Mission not found: ${missionId}`);
    if (update.title !== undefined) requireText(update.title, 'mission title');
    if (update.objective !== undefined) requireText(update.objective, 'mission objective');
    if (update.acceptanceCriteria !== undefined) {
      update = {
        ...update,
        acceptanceCriteria: normalizedStrings(
          update.acceptanceCriteria,
          'mission acceptanceCriteria',
        ),
      };
    }
    if (update.verificationPolicy !== undefined) {
      update = {
        ...update,
        verificationPolicy: normalizeVerificationPolicy(update.verificationPolicy),
      };
    }
    const mission: Mission = {
      ...current,
      ...defined(update),
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit(workId, { type: 'mission.updated', mission }, options);
    return next.missions[missionId]!;
  }

  async createTask(
    workId: string,
    input: {
      id?: string;
      missionId: string;
      title: string;
      description?: string;
      acceptanceCriteria?: string[];
      status?: Task['status'];
      priority?: Task['priority'];
      teamId?: string;
      assignedAgentId?: string;
      dependsOnTaskIds?: string[];
      readOnly?: boolean;
      writeScope?: string[];
      dueAt?: string;
    },
    options: AppendEventOptions,
  ): Promise<Task> {
    const projection = await this.requireWorkProjection(workId);
    requireEntity(projection.missions[input.missionId], `Mission not found: ${input.missionId}`);
    requireText(input.title, 'task title');
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.tasks[id], 'Task', id);
    const dependencies = [...new Set(input.dependsOnTaskIds ?? [])];
    if (dependencies.includes(id)) throw conflict('A task cannot depend on itself');
    for (const dependencyId of dependencies) {
      requireEntity(projection.tasks[dependencyId], `Dependency task not found: ${dependencyId}`);
    }
    const now = options.occurredAt ?? this.clock();
    const acceptanceCriteria = normalizedStrings(
      input.acceptanceCriteria ?? projection.missions[input.missionId]!.acceptanceCriteria,
      'task acceptanceCriteria',
    );
    const writeScope = normalizedStrings(input.writeScope ?? [], 'task writeScope');
    if (input.readOnly && writeScope.length > 0) {
      throw conflict('A read-only task cannot declare writeScope');
    }
    const teamId = input.teamId ?? projection.missions[input.missionId]!.teamId;
    const task: Task = {
      id,
      workId,
      missionId: input.missionId,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      acceptanceCriteria,
      status: input.status ?? 'pending',
      priority: input.priority ?? 'normal',
      ...(teamId ? { teamId } : {}),
      ...(input.assignedAgentId ? { assignedAgentId: input.assignedAgentId } : {}),
      dependsOnTaskIds: dependencies,
      readOnly: input.readOnly ?? false,
      writeScope,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    };
    const next = await this.commit(workId, { type: 'task.created', task }, options);
    return next.tasks[id]!;
  }

  async updateTask(
    workId: string,
    taskId: string,
    update: TaskUpdate,
    options: AppendEventOptions,
  ): Promise<Task> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(projection.tasks[taskId], `Task not found: ${taskId}`);
    if (update.title !== undefined) requireText(update.title, 'task title');
    if (update.acceptanceCriteria !== undefined) {
      update = {
        ...update,
        acceptanceCriteria: normalizedStrings(
          update.acceptanceCriteria,
          'task acceptanceCriteria',
        ),
      };
    }
    if (update.dependsOnTaskIds) {
      const dependencies = [...new Set(update.dependsOnTaskIds)];
      if (dependencies.includes(taskId)) throw conflict('A task cannot depend on itself');
      for (const dependencyId of dependencies) {
        requireEntity(projection.tasks[dependencyId], `Dependency task not found: ${dependencyId}`);
      }
      update = { ...update, dependsOnTaskIds: dependencies };
    }
    if (update.writeScope !== undefined) {
      update = {
        ...update,
        writeScope: normalizedStrings(update.writeScope, 'task writeScope'),
      };
    }
    const nextReadOnly = update.readOnly ?? current.readOnly;
    const nextWriteScope = update.writeScope ?? current.writeScope;
    if (nextReadOnly && nextWriteScope.length > 0) {
      throw conflict('A read-only task cannot declare writeScope');
    }
    const task: Task = {
      ...current,
      ...defined(update),
      version: current.version + 1,
      updatedAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit(workId, { type: 'task.updated', task }, options);
    return next.tasks[taskId]!;
  }

  /**
   * Claims a dispatchable Task and creates its Run and run Session in one
   * append. The one-revision boundary prevents partially claimed work after a
   * process crash.
   */
  async claimTaskExecution(
    workId: string,
    input: ClaimTaskExecutionInput,
    options: AppendEventOptions,
  ): Promise<ClaimTaskExecutionResult> {
    return this.commitTaskExecutionClaim(workId, input, options, 'claim');
  }

  /**
   * Creates a revision attempt with the same atomic Task/Run/Session boundary
   * as an initial claim.
   */
  async retryTaskExecution(
    workId: string,
    input: ClaimTaskExecutionInput,
    options: AppendEventOptions,
  ): Promise<ClaimTaskExecutionResult> {
    return this.commitTaskExecutionClaim(workId, input, options, 'retry');
  }

  async startTaskExecution(
    workId: string,
    input: StartTaskExecutionInput,
    options: AppendEventOptions,
  ): Promise<{ task: Task; run: Run; leases: WorkspaceLeaseRecord[]; revision: number }> {
    const projection = await this.requireWorkProjection(workId);
    const currentRun = requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
    const currentTask = requireEntity(
      projection.tasks[currentRun.taskId],
      `Task not found: ${currentRun.taskId}`,
    );
    if (currentRun.status !== 'queued' || currentTask.status !== 'claimed') {
      throw conflict('Only a queued Run with a claimed Task can start');
    }
    const now = options.occurredAt ?? this.clock();
    const task: Task = {
      ...currentTask,
      status: 'running',
      version: currentTask.version + 1,
      updatedAt: now,
    };
    const run: Run = {
      ...currentRun,
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
      ...(input.workspaceExecution
        ? { workspaceExecution: cloneWorkspaceExecution(input.workspaceExecution) }
        : {}),
    };
    const leases = (input.leases ?? []).map((lease): WorkspaceLeaseRecord => {
      if (projection.workspaceLeases[lease.id]) {
        throw alreadyExists('Workspace lease', lease.id);
      }
      requireFutureTimestamp(lease.expiresAt, now, 'lease expiresAt');
      if (lease.fencingToken !== run.fencingToken) {
        throw conflict('Workspace lease fencingToken does not match its Run');
      }
      const record: WorkspaceLeaseRecord = {
        ...lease,
        workId,
        writeScope: normalizeWriteScopes(
          lease.writeScope.length > 0 ? lease.writeScope : ['.'],
        ),
        ownerRunId: run.id,
        ownerTaskId: task.id,
        ownerAgentId: run.agentId,
        status: 'active',
        acquiredAt: now,
      };
      assertNoActiveLeaseConflict(projection, record);
      return record;
    });
    if (run.workspaceExecution.mode === 'lease') {
      const leaseExecution = run.workspaceExecution;
      const leaseIds = new Set(leases.map((lease) => lease.id));
      if (
        leaseExecution.leaseIds.some((leaseId) => !leaseIds.has(leaseId))
        || leases.some((lease) => (
          lease.workspaceId !== leaseExecution.workspaceId
        ))
      ) {
        throw conflict('Workspace execution does not match its persistent leases');
      }
    }
    const next = await this.commit(
      workId,
      { type: 'execution.started', task, run, leases },
      options,
    );
    return {
      task: next.tasks[task.id]!,
      run: next.runs[run.id]!,
      leases: leases.map((lease) => next.workspaceLeases[lease.id]!),
      revision: next.revision,
    };
  }

  async heartbeatTaskExecution(
    workId: string,
    runId: string,
    input: { leaseExpiresAt?: string },
    options: AppendEventOptions,
  ): Promise<{ run: Run; leases: WorkspaceLeaseRecord[]; revision: number }> {
    const projection = await this.requireWorkProjection(workId);
    const currentRun = requireEntity(projection.runs[runId], `Run not found: ${runId}`);
    if (currentRun.status !== 'running') throw conflict('Only a running Run can heartbeat');
    const now = options.occurredAt ?? this.clock();
    const run: Run = { ...currentRun, heartbeatAt: now };
    const leases = Object.values(projection.workspaceLeases)
      .filter((lease) => lease.ownerRunId === runId && lease.status === 'active')
      .map((lease): WorkspaceLeaseRecord => {
        if (!input.leaseExpiresAt) return lease;
        requireFutureTimestamp(input.leaseExpiresAt, now, 'lease expiresAt');
        return {
          ...lease,
          expiresAt: input.leaseExpiresAt,
          renewedAt: now,
        };
      });
    const next = await this.commit(
      workId,
      { type: 'execution.heartbeat', run, leases },
      options,
    );
    return { run: next.runs[runId]!, leases, revision: next.revision };
  }

  /**
   * Commits the terminal Task/Run/Session state and releases every persistent
   * lease owned by the Run in one event.
   */
  async finishTaskExecution(
    workId: string,
    input: FinishTaskExecutionInput,
    options: AppendEventOptions,
  ): Promise<{
    task: Task;
    run: Run;
    session: Session;
    leases: WorkspaceLeaseRecord[];
    report?: TaskReport;
    decision?: OrchestrationDecision;
    revision: number;
  }> {
    const projection = await this.requireWorkProjection(workId);
    const currentRun = requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
    const currentTask = requireEntity(
      projection.tasks[currentRun.taskId],
      `Task not found: ${currentRun.taskId}`,
    );
    const currentSession = requireEntity(
      projection.sessions[currentRun.sessionId],
      `Session not found: ${currentRun.sessionId}`,
    );
    const currentOwnedLeases = Object.values(projection.workspaceLeases)
      .filter((lease) => lease.ownerRunId === currentRun.id);
    const cleanupComplete = currentSession.status === 'closed'
      && currentOwnedLeases.every((lease) => lease.status !== 'active');
    if (
      (isTerminalRun(currentRun.status) || isTerminalTask(currentTask.status))
      && cleanupComplete
    ) {
      return {
        task: currentTask,
        run: currentRun,
        session: currentSession,
        leases: currentOwnedLeases,
        revision: projection.revision,
      };
    }
    if (
      currentRun.status !== 'running'
      && currentRun.status !== 'queued'
      && currentRun.status !== input.runStatus
    ) {
      throw conflict(`Run cannot finish from ${currentRun.status}`);
    }
    const now = options.occurredAt ?? this.clock();
    const task: Task = {
      ...currentTask,
      status: input.taskStatus,
      version: currentTask.version + 1,
      updatedAt: now,
      ...(isTerminalTask(input.taskStatus) ? { completedAt: now } : {}),
    };
    const turnsConsumed = input.turnsConsumed ?? currentRun.turnsConsumed;
    if (
      !Number.isSafeInteger(turnsConsumed)
      || turnsConsumed < 0
      || turnsConsumed > currentRun.maxTurns
    ) {
      throw invalid('Run turnsConsumed must be between zero and maxTurns');
    }
    if (input.tokenUsage) validateTokenUsage(input.tokenUsage);
    if (
      input.cost
      && (
        input.cost.currency !== 'USD'
        || !Number.isFinite(input.cost.amount)
        || input.cost.amount < 0
      )
    ) {
      throw invalid('Run cost must be a non-negative USD amount');
    }
    if (
      input.toolCount !== undefined
      && (!Number.isSafeInteger(input.toolCount) || input.toolCount < 0)
    ) {
      throw invalid('Run toolCount must be a non-negative integer');
    }
    const run: Run = {
      ...currentRun,
      status: input.runStatus,
      turnsConsumed,
      heartbeatAt: now,
      finishedAt: now,
      terminationReason: input.terminationReason,
      ...(input.tokenUsage ? { tokenUsage: { ...input.tokenUsage } } : {}),
      ...(input.cost ? { cost: { ...input.cost } } : {}),
      ...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
      ...(input.lastCompletedToolCallId
        ? { lastCompletedToolCallId: input.lastCompletedToolCallId }
        : {}),
      ...(input.resultSummary !== undefined ? { resultSummary: input.resultSummary } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    const session: Session = {
      ...currentSession,
      status: 'closed',
      closedAt: now,
    };
    let report: TaskReport | undefined;
    if (input.report) {
      requireText(input.report.summary, 'task report summary');
      report = {
        id: input.report.id ?? this.idFactory(),
        taskId: task.id,
        runId: run.id,
        agentId: run.agentId,
        outcome: input.report.outcome,
        summary: input.report.summary,
        ...(input.report.details !== undefined ? { details: input.report.details } : {}),
        artifacts: [...input.report.artifacts],
        createdAt: now,
      };
      assertAbsent(projection.taskReports[report.id], 'Task report', report.id);
      if (
        input.taskStatus === 'submitted'
        && report.outcome !== 'submitted'
        && report.outcome !== 'completed'
      ) {
        throw conflict('A submitted Task requires a submitted or completed TaskReport');
      }
    } else if (input.taskStatus === 'submitted') {
      throw conflict('A submitted Task requires a non-empty TaskReport');
    }
    let decision: OrchestrationDecision | undefined;
    if (input.decision) {
      requireText(input.decision.decision, 'orchestration decision');
      requireText(input.decision.reason, 'orchestration reason');
      decision = {
        id: input.decision.id ?? this.idFactory(),
        workId,
        missionId: run.missionId,
        taskId: task.id,
        runId: run.id,
        kind: input.decision.kind,
        decision: input.decision.decision,
        reason: input.decision.reason,
        candidateAgentIds: normalizedStrings(
          input.decision.candidateAgentIds,
          'orchestration candidateAgentIds',
        ),
        ...(input.decision.selectedAgentId
          ? { selectedAgentId: input.decision.selectedAgentId }
          : {}),
        ...(input.decision.inputs ? { inputs: { ...input.decision.inputs } } : {}),
        createdAt: now,
      };
      assertAbsent(
        projection.orchestrationDecisions[decision.id],
        'Orchestration decision',
        decision.id,
      );
    }
    const leases = Object.values(projection.workspaceLeases)
      .filter((lease) => lease.ownerRunId === run.id && lease.status === 'active')
      .map((lease): WorkspaceLeaseRecord => ({
        ...lease,
        status: 'released',
        releasedAt: now,
        releaseReason: input.terminationReason,
      }));
    const next = await this.commit(
      workId,
      {
        type: 'execution.terminal',
        task,
        run,
        session,
        leases,
        ...(report ? { report } : {}),
        ...(decision ? { decision } : {}),
      },
      options,
    );
    return {
      task: next.tasks[task.id]!,
      run: next.runs[run.id]!,
      session: next.sessions[session.id]!,
      leases,
      ...(report ? { report: next.taskReports[report.id]! } : {}),
      ...(decision ? { decision: next.orchestrationDecisions[decision.id]! } : {}),
      revision: next.revision,
    };
  }

  async gateTaskVerification(
    workId: string,
    input: GateTaskVerificationInput,
    options: AppendEventOptions,
  ): Promise<{ task: Task; verification: VerificationRecord; revision: number }> {
    const projection = await this.requireWorkProjection(workId);
    const run = requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
    const currentTask = requireEntity(projection.tasks[run.taskId], `Task not found: ${run.taskId}`);
    if (run.status !== 'succeeded' || currentTask.status !== 'submitted') {
      throw conflict('Verification can only gate a submitted Task from a succeeded Run');
    }
    if (
      input.verification.mode === 'independent_agent'
      && input.verification.reviewerAgentId === run.agentId
    ) {
      throw conflict('Independent verification requires a different reviewer Agent');
    }
    if (
      input.verification.mode === 'independent_agent'
      && !input.verification.reviewerAgentId
    ) {
      throw conflict('Independent verification requires a reviewer Agent');
    }
    const now = options.occurredAt ?? this.clock();
    const task: Task = {
      ...currentTask,
      status: input.taskStatus,
      version: currentTask.version + 1,
      updatedAt: now,
      ...(input.taskStatus === 'completed' ? { completedAt: now } : {}),
    };
    const verification: VerificationRecord = {
      id: input.verification.id ?? this.idFactory(),
      workId,
      missionId: run.missionId,
      taskId: task.id,
      runId: run.id,
      mode: input.verification.mode,
      workerAgentId: run.agentId,
      ...(input.verification.reviewerAgentId
        ? { reviewerAgentId: input.verification.reviewerAgentId }
        : {}),
      outcome: input.verification.outcome,
      summary: input.verification.summary,
      criteria: cloneVerificationCriteria(input.verification.criteria),
      revisionAttempt: input.verification.revisionAttempt,
      createdAt: now,
      ...(input.verification.completedAt
        ? { completedAt: input.verification.completedAt }
        : {}),
    };
    requireText(verification.summary, 'verification summary');
    assertAbsent(
      projection.verificationRecords[verification.id],
      'Verification record',
      verification.id,
    );
    const next = await this.commit(
      workId,
      { type: 'execution.verification_gated', task, verification },
      options,
    );
    return {
      task: next.tasks[task.id]!,
      verification: next.verificationRecords[verification.id]!,
      revision: next.revision,
    };
  }

  /**
   * Atomically completes an already-pending independent/user verification and
   * moves its Task to the matching terminal or revision state.
   */
  async completeTaskVerification(
    workId: string,
    input: CompleteTaskVerificationInput,
    options: AppendEventOptions,
  ): Promise<{ task: Task; verification: VerificationRecord; revision: number }> {
    const projection = await this.requireWorkProjection(workId);
    const currentVerification = requireEntity(
      projection.verificationRecords[input.verificationId],
      `Verification record not found: ${input.verificationId}`,
    );
    const currentTask = requireEntity(
      projection.tasks[currentVerification.taskId],
      `Task not found: ${currentVerification.taskId}`,
    );
    const run = requireEntity(
      projection.runs[currentVerification.runId],
      `Run not found: ${currentVerification.runId}`,
    );
    if (currentVerification.outcome !== 'pending') {
      throw conflict(`Verification is already ${currentVerification.outcome}`);
    }
    if (currentTask.status !== 'verifying' || run.status !== 'succeeded') {
      throw conflict(
        'Only a pending verification for a verifying Task and succeeded Run can be completed',
      );
    }
    requireText(input.summary, 'verification summary');
    const criteria = cloneVerificationCriteria(input.criteria);
    if (criteria.length === 0) {
      throw invalid('Verification criteria must not be empty');
    }
    if (input.outcome === 'approved' && criteria.some((criterion) => !criterion.passed)) {
      throw conflict('Approved verification requires every criterion to pass');
    }
    if (
      input.outcome === 'revision_required'
      && criteria.every((criterion) => criterion.passed)
    ) {
      throw conflict('Revision-required verification needs at least one failed criterion');
    }
    const now = options.occurredAt ?? this.clock();
    const task: Task = {
      ...currentTask,
      status: input.outcome === 'approved' ? 'completed' : 'revision_required',
      version: currentTask.version + 1,
      updatedAt: now,
      ...(input.outcome === 'approved' ? { completedAt: now } : {}),
    };
    const verification: VerificationRecord = {
      ...currentVerification,
      outcome: input.outcome,
      summary: input.summary,
      criteria,
      completedAt: now,
    };
    const next = await this.commit(
      workId,
      { type: 'execution.verification_gated', task, verification },
      options,
    );
    return {
      task: next.tasks[task.id]!,
      verification: next.verificationRecords[verification.id]!,
      revision: next.revision,
    };
  }

  async reportTask(
    workId: string,
    input: Omit<TaskReport, 'id' | 'createdAt'> & { id?: string },
    options: AppendEventOptions,
  ): Promise<TaskReport> {
    const projection = await this.requireWorkProjection(workId);
    requireEntity(projection.tasks[input.taskId], `Task not found: ${input.taskId}`);
    if (input.runId) requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
    requireText(input.summary, 'task report summary');
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.taskReports[id], 'Task report', id);
    const report: TaskReport = {
      id,
      taskId: input.taskId,
      ...(input.runId ? { runId: input.runId } : {}),
      agentId: input.agentId,
      outcome: input.outcome,
      summary: input.summary,
      ...(input.details !== undefined ? { details: input.details } : {}),
      artifacts: [...input.artifacts],
      createdAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit(workId, { type: 'task.reported', report }, options);
    return next.taskReports[id]!;
  }

  async createRun(
    workId: string,
    input: {
      id?: string;
      missionId: string;
      taskId: string;
      agentId: string;
      sessionId: string;
      attempt: number;
      maxTurns: number;
      status?: Run['status'];
      fencingToken?: number;
      workspaceExecution?: WorkspaceExecution;
    },
    options: AppendEventOptions,
  ): Promise<Run> {
    const projection = await this.requireWorkProjection(workId);
    const task = requireEntity(projection.tasks[input.taskId], `Task not found: ${input.taskId}`);
    if (task.missionId !== input.missionId) throw conflict('Run mission does not match its task');
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
      throw invalid('Run attempt must be a positive integer');
    }
    if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1) {
      throw invalid('Run maxTurns must be a positive integer');
    }
    if (
      input.fencingToken !== undefined
      && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1)
    ) {
      throw invalid('Run fencingToken must be a positive integer');
    }
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.runs[id], 'Run', id);
    const now = options.occurredAt ?? this.clock();
    const run: Run = {
      id,
      workId,
      missionId: input.missionId,
      taskId: input.taskId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      status: input.status ?? 'queued',
      attempt: input.attempt,
      maxTurns: input.maxTurns,
      turnsConsumed: 0,
      heartbeatAt: now,
      fencingToken: input.fencingToken ?? 1,
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      cost: { currency: 'USD', amount: 0, estimated: true },
      toolCount: 0,
      workspaceExecution: cloneWorkspaceExecution(input.workspaceExecution ?? { mode: 'none' }),
      createdAt: now,
    };
    const next = await this.commit(workId, { type: 'run.created', run }, options);
    return next.runs[id]!;
  }

  async updateRun(
    workId: string,
    runId: string,
    update: RunUpdate,
    options: AppendEventOptions,
  ): Promise<Run> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(projection.runs[runId], `Run not found: ${runId}`);
    if (
      update.turnsConsumed !== undefined
      && (
        !Number.isSafeInteger(update.turnsConsumed)
        || update.turnsConsumed < 0
        || update.turnsConsumed > current.maxTurns
      )
    ) {
      throw invalid('Run turnsConsumed must be between zero and maxTurns');
    }
    if (
      update.fencingToken !== undefined
      && (!Number.isSafeInteger(update.fencingToken) || update.fencingToken < current.fencingToken)
    ) {
      throw invalid('Run fencingToken must not move backwards');
    }
    if (
      update.toolCount !== undefined
      && (!Number.isSafeInteger(update.toolCount) || update.toolCount < 0)
    ) {
      throw invalid('Run toolCount must be a non-negative integer');
    }
    if (update.tokenUsage !== undefined) {
      validateTokenUsage(update.tokenUsage);
      update = { ...update, tokenUsage: { ...update.tokenUsage } };
    }
    if (update.cost !== undefined) {
      if (
        update.cost.currency !== 'USD'
        || !Number.isFinite(update.cost.amount)
        || update.cost.amount < 0
      ) {
        throw invalid('Run cost must be a non-negative USD amount');
      }
      update = { ...update, cost: { ...update.cost } };
    }
    if (update.workspaceExecution !== undefined) {
      update = {
        ...update,
        workspaceExecution: cloneWorkspaceExecution(update.workspaceExecution),
      };
    }
    const run: Run = { ...current, ...defined(update) };
    const next = await this.commit(workId, { type: 'run.updated', run }, options);
    return next.runs[runId]!;
  }

  async createSession(
    workId: string,
    input: {
      id: string;
      kind: Session['kind'];
      missionId?: string;
      taskId?: string;
      runId?: string;
      parentSessionId?: string;
      agentId: string;
      actorSnapshot: Session['actorSnapshot'];
      status?: Session['status'];
    },
    options: AppendEventOptions,
  ): Promise<Session> {
    const projection = await this.requireWorkProjection(workId);
    if (input.actorSnapshot.agentId !== input.agentId) {
      throw conflict('Session actorSnapshot does not match agentId');
    }
    if (input.kind === 'primary') {
      if (input.missionId || input.taskId || input.runId || input.parentSessionId) {
        throw conflict('Primary sessions cannot belong to a Mission, Task, Run, or parent Session');
      }
      if (input.id !== projection.work.primarySessionId) {
        throw conflict('Primary Session id must match Work.primarySessionId');
      }
    } else {
      if (!input.missionId || !input.taskId || !input.runId || !input.parentSessionId) {
        throw invalid('Run sessions require missionId, taskId, runId, and parentSessionId');
      }
      const run = requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
      const parent = requireEntity(
        projection.sessions[input.parentSessionId],
        `Parent Session not found: ${input.parentSessionId}`,
      );
      if (parent.kind !== 'primary') throw conflict('Run Session parent must be a primary Session');
      if (
        run.sessionId !== input.id
        || run.missionId !== input.missionId
        || run.taskId !== input.taskId
        || run.agentId !== input.agentId
      ) {
        throw conflict('Session lineage does not match its run');
      }
    }
    assertAbsent(projection.sessions[input.id], 'Session', input.id);
    const session: Session = {
      id: input.id,
      workId,
      kind: input.kind,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      agentId: input.agentId,
      actorSnapshot: cloneActorSnapshot(input.actorSnapshot),
      status: input.status ?? 'active',
      transcriptRevision: 0,
      createdAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit(workId, { type: 'session.created', session }, options);
    return next.sessions[input.id]!;
  }

  async updateSession(
    workId: string,
    sessionId: string,
    update: SessionUpdate,
    options: AppendEventOptions,
  ): Promise<Session> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(projection.sessions[sessionId], `Session not found: ${sessionId}`);
    if (
      update.transcriptRevision !== undefined
      && (!Number.isSafeInteger(update.transcriptRevision) || update.transcriptRevision < 0)
    ) {
      throw invalid('Session transcriptRevision must be a non-negative integer');
    }
    const session: Session = { ...current, ...defined(update) };
    const next = await this.commit(workId, { type: 'session.updated', session }, options);
    return next.sessions[sessionId]!;
  }

  async enqueueCoordinationMessage(
    workId: string,
    input: {
      id?: string;
      teamId?: string;
      taskId?: string;
      senderAgentId: string;
      recipientAgentId: string;
      recipientSessionId?: string;
      kind: CoordinationMessage['kind'];
      content: string;
      summary?: string;
      idempotencyKey: string;
    },
    options: AppendEventOptions,
  ): Promise<CoordinationMessage> {
    const projection = await this.requireWorkProjection(workId);
    requireText(input.senderAgentId, 'message senderAgentId');
    requireText(input.recipientAgentId, 'message recipientAgentId');
    requireText(input.content, 'message content');
    requireText(input.idempotencyKey, 'message idempotencyKey');
    const duplicate = Object.values(projection.coordinationMessages).find(
      (message) => (
        message.recipientAgentId === input.recipientAgentId
        && message.idempotencyKey === input.idempotencyKey
      ),
    );
    if (duplicate) return duplicate;
    if (input.taskId) {
      requireEntity(projection.tasks[input.taskId], `Task not found: ${input.taskId}`);
    }
    if (input.recipientSessionId) {
      requireEntity(
        projection.sessions[input.recipientSessionId],
        `Session not found: ${input.recipientSessionId}`,
      );
    }
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.coordinationMessages[id], 'Coordination message', id);
    const sequence = Object.values(projection.coordinationMessages)
      .filter((message) => message.recipientAgentId === input.recipientAgentId)
      .reduce((maximum, message) => Math.max(maximum, message.sequence), 0) + 1;
    const message: CoordinationMessage = {
      id,
      workId,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      senderAgentId: input.senderAgentId,
      recipientAgentId: input.recipientAgentId,
      ...(input.recipientSessionId ? { recipientSessionId: input.recipientSessionId } : {}),
      kind: input.kind,
      content: input.content,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      sequence,
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      deliveryAttempts: 0,
      createdAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit(
      workId,
      { type: 'coordination.message.enqueued', message },
      options,
    );
    return requireEntity(
      next.coordinationMessages[id]
        ?? Object.values(next.coordinationMessages).find(
          (entry) => (
            entry.recipientAgentId === input.recipientAgentId
            && entry.idempotencyKey === input.idempotencyKey
          ),
        ),
      'Coordination message was not projected',
    );
  }

  async transitionCoordinationMessage(
    workId: string,
    messageId: string,
    nextStatus: CoordinationMessage['status'],
    input: {
      consumingTurnId?: string;
      recipientSessionId?: string;
      error?: string;
    },
    options: AppendEventOptions,
  ): Promise<CoordinationMessage> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(
      projection.coordinationMessages[messageId],
      `Coordination message not found: ${messageId}`,
    );
    if (input.recipientSessionId) {
      const session = requireEntity(
        projection.sessions[input.recipientSessionId],
        `Session not found: ${input.recipientSessionId}`,
      );
      if (session.agentId !== current.recipientAgentId) {
        throw conflict(
          `Session ${session.id} does not belong to message recipient ${current.recipientAgentId}`,
        );
      }
      if (
        current.recipientSessionId
        && current.recipientSessionId !== input.recipientSessionId
      ) {
        throw conflict(
          `Message ${messageId} is already bound to Session ${current.recipientSessionId}`,
        );
      }
    }
    assertMessageTransition(current, nextStatus, input.consumingTurnId);
    const now = options.occurredAt ?? this.clock();
    const message: CoordinationMessage = {
      ...current,
      status: nextStatus,
      ...(input.recipientSessionId
        ? { recipientSessionId: input.recipientSessionId }
        : {}),
      ...(input.error !== undefined ? { lastError: input.error } : {}),
    };
    if (nextStatus === 'delivered') {
      message.deliveryAttempts = current.deliveryAttempts + 1;
      message.deliveredAt = now;
      delete message.consumedAt;
      delete message.consumingTurnId;
    } else if (nextStatus === 'consumed') {
      message.consumedAt = now;
      message.consumingTurnId = input.consumingTurnId;
    } else if (nextStatus === 'acknowledged') {
      message.acknowledgedAt = now;
      message.consumingTurnId = input.consumingTurnId;
    } else if (nextStatus === 'dead_letter') {
      message.deadLetteredAt = now;
    }
    const next = await this.commit(
      workId,
      { type: 'coordination.message.updated', message },
      options,
    );
    return next.coordinationMessages[messageId]!;
  }

  async acquireWorkspaceLease(
    workId: string,
    input: {
      id?: string;
      workspaceId: string;
      writeScope: string[];
      ownerRunId: string;
      ownerTaskId: string;
      ownerAgentId: string;
      fencingToken: number;
      expiresAt: string;
    },
    options: AppendEventOptions,
  ): Promise<WorkspaceLeaseRecord> {
    const projection = await this.requireWorkProjection(workId);
    requireText(input.workspaceId, 'lease workspaceId');
    const task = requireEntity(
      projection.tasks[input.ownerTaskId],
      `Task not found: ${input.ownerTaskId}`,
    );
    const run = requireEntity(
      projection.runs[input.ownerRunId],
      `Run not found: ${input.ownerRunId}`,
    );
    if (
      task.id !== run.taskId
      || run.agentId !== input.ownerAgentId
      || run.fencingToken !== input.fencingToken
    ) {
      throw conflict('Workspace lease ownership does not match its Task and Run');
    }
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw invalid('Workspace lease fencingToken must be a positive integer');
    }
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.workspaceLeases[id], 'Workspace lease', id);
    const now = options.occurredAt ?? this.clock();
    requireFutureTimestamp(input.expiresAt, now, 'lease expiresAt');
    const lease: WorkspaceLeaseRecord = {
      id,
      workId,
      workspaceId: input.workspaceId,
      writeScope: normalizeWriteScopes(input.writeScope.length > 0 ? input.writeScope : ['.']),
      ownerRunId: input.ownerRunId,
      ownerTaskId: input.ownerTaskId,
      ownerAgentId: input.ownerAgentId,
      fencingToken: input.fencingToken,
      status: 'active',
      acquiredAt: now,
      expiresAt: input.expiresAt,
    };
    const next = await this.commit(workId, { type: 'workspace.lease.acquired', lease }, options);
    return next.workspaceLeases[id]!;
  }

  async updateWorkspaceLease(
    workId: string,
    leaseId: string,
    update: WorkspaceLeaseUpdate,
    options: AppendEventOptions,
  ): Promise<WorkspaceLeaseRecord> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(
      projection.workspaceLeases[leaseId],
      `Workspace lease not found: ${leaseId}`,
    );
    if (current.status !== 'active') {
      throw conflict(`Workspace lease is already ${current.status}`);
    }
    const now = options.occurredAt ?? this.clock();
    if (update.status === 'active' && update.expiresAt === undefined) {
      throw invalid('Renewing a Workspace lease requires expiresAt');
    }
    if (update.expiresAt !== undefined) {
      requireFutureTimestamp(update.expiresAt, now, 'lease expiresAt');
    }
    if (update.status === 'released' && update.releasedAt === undefined) {
      update = { ...update, releasedAt: now };
    }
    if (update.status === 'expired' && update.releasedAt === undefined) {
      update = { ...update, releasedAt: now };
    }
    if (update.status === undefined && update.expiresAt !== undefined) {
      update = { ...update, status: 'active', renewedAt: update.renewedAt ?? now };
    }
    const lease: WorkspaceLeaseRecord = { ...current, ...defined(update) };
    const next = await this.commit(workId, { type: 'workspace.lease.updated', lease }, options);
    return next.workspaceLeases[leaseId]!;
  }

  async recordOrchestrationDecision(
    workId: string,
    input: Omit<OrchestrationDecision, 'id' | 'workId' | 'createdAt'> & { id?: string },
    options: AppendEventOptions,
  ): Promise<OrchestrationDecision> {
    const projection = await this.requireWorkProjection(workId);
    if (input.missionId) {
      requireEntity(projection.missions[input.missionId], `Mission not found: ${input.missionId}`);
    }
    if (input.taskId) {
      requireEntity(projection.tasks[input.taskId], `Task not found: ${input.taskId}`);
    }
    if (input.runId) {
      requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
    }
    requireText(input.decision, 'orchestration decision');
    requireText(input.reason, 'orchestration reason');
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.orchestrationDecisions[id], 'Orchestration decision', id);
    const decision: OrchestrationDecision = {
      id,
      workId,
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      kind: input.kind,
      decision: input.decision,
      reason: input.reason,
      candidateAgentIds: normalizedStrings(
        input.candidateAgentIds,
        'orchestration candidateAgentIds',
      ),
      ...(input.selectedAgentId ? { selectedAgentId: input.selectedAgentId } : {}),
      ...(input.inputs ? { inputs: { ...input.inputs } } : {}),
      createdAt: options.occurredAt ?? this.clock(),
    };
    const next = await this.commit(
      workId,
      { type: 'orchestration.decision.recorded', decision },
      options,
    );
    return next.orchestrationDecisions[id]!;
  }

  async recordVerification(
    workId: string,
    input: Omit<VerificationRecord, 'id' | 'workId' | 'createdAt'> & { id?: string },
    options: AppendEventOptions,
  ): Promise<VerificationRecord> {
    const projection = await this.requireWorkProjection(workId);
    const task = requireEntity(projection.tasks[input.taskId], `Task not found: ${input.taskId}`);
    const run = requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
    if (
      task.missionId !== input.missionId
      || run.taskId !== input.taskId
      || run.agentId !== input.workerAgentId
    ) {
      throw conflict('Verification lineage does not match its Mission, Task, and Run');
    }
    if (input.mode === 'independent_agent' && input.reviewerAgentId === input.workerAgentId) {
      throw conflict('Independent verification requires a different reviewer Agent');
    }
    if (!Number.isSafeInteger(input.revisionAttempt) || input.revisionAttempt < 0) {
      throw invalid('Verification revisionAttempt must be a non-negative integer');
    }
    requireText(input.summary, 'verification summary');
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.verificationRecords[id], 'Verification record', id);
    const verification: VerificationRecord = {
      id,
      workId,
      missionId: input.missionId,
      taskId: input.taskId,
      runId: input.runId,
      mode: input.mode,
      workerAgentId: input.workerAgentId,
      ...(input.reviewerAgentId ? { reviewerAgentId: input.reviewerAgentId } : {}),
      outcome: input.outcome,
      summary: input.summary,
      criteria: cloneVerificationCriteria(input.criteria),
      revisionAttempt: input.revisionAttempt,
      createdAt: options.occurredAt ?? this.clock(),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    };
    const next = await this.commit(
      workId,
      { type: 'verification.recorded', verification },
      options,
    );
    return next.verificationRecords[id]!;
  }

  async updateVerification(
    workId: string,
    verificationId: string,
    update: VerificationUpdate,
    options: AppendEventOptions,
  ): Promise<VerificationRecord> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(
      projection.verificationRecords[verificationId],
      `Verification record not found: ${verificationId}`,
    );
    if (update.summary !== undefined) requireText(update.summary, 'verification summary');
    if (update.criteria !== undefined) {
      update = { ...update, criteria: cloneVerificationCriteria(update.criteria) };
    }
    const verification: VerificationRecord = { ...current, ...defined(update) };
    const next = await this.commit(
      workId,
      { type: 'verification.updated', verification },
      options,
    );
    return next.verificationRecords[verificationId]!;
  }

  async prepareToolCall(
    workId: string,
    input: {
      id?: string;
      missionId: string;
      taskId: string;
      runId: string;
      sessionId: string;
      agentId: string;
      toolCallId: string;
      toolName: string;
      readOnly: boolean;
      writeScope?: string[];
      idempotencyKey: string;
      processId?: number;
    },
    options: AppendEventOptions,
  ): Promise<ToolCallJournalRecord> {
    const projection = await this.requireWorkProjection(workId);
    const task = requireEntity(projection.tasks[input.taskId], `Task not found: ${input.taskId}`);
    const run = requireEntity(projection.runs[input.runId], `Run not found: ${input.runId}`);
    const session = requireEntity(
      projection.sessions[input.sessionId],
      `Session not found: ${input.sessionId}`,
    );
    if (
      task.missionId !== input.missionId
      || run.taskId !== input.taskId
      || run.agentId !== input.agentId
      || run.sessionId !== input.sessionId
      || session.runId !== input.runId
    ) {
      throw conflict('Tool call lineage does not match its Task, Run, Session, and Agent');
    }
    requireText(input.toolCallId, 'toolCallId');
    requireText(input.toolName, 'toolName');
    requireText(input.idempotencyKey, 'tool call idempotencyKey');
    const duplicate = Object.values(projection.toolCallJournal).find(
      (entry) => entry.idempotencyKey === input.idempotencyKey,
    );
    if (duplicate) return duplicate;
    const id = input.id ?? this.idFactory();
    assertAbsent(projection.toolCallJournal[id], 'Tool call journal record', id);
    const requestedWriteScope = input.writeScope ?? [];
    if (input.readOnly && requestedWriteScope.length > 0) {
      throw conflict('A read-only tool call cannot declare writeScope');
    }
    const writeScope = input.readOnly
      ? []
      : normalizeWriteScopes(requestedWriteScope.length > 0 ? requestedWriteScope : ['.']);
    if (input.processId !== undefined && (!Number.isSafeInteger(input.processId) || input.processId < 1)) {
      throw invalid('Tool call processId must be a positive integer');
    }
    const toolCall: ToolCallJournalRecord = {
      id,
      workId,
      missionId: input.missionId,
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      readOnly: input.readOnly,
      writeScope,
      idempotencyKey: input.idempotencyKey,
      status: 'prepared',
      recoveryStatus: 'start_pending',
      preparedAt: options.occurredAt ?? this.clock(),
      ...(input.processId !== undefined ? { processId: input.processId } : {}),
    };
    const next = await this.commit(workId, { type: 'tool_call.journaled', toolCall }, options);
    return requireEntity(
      next.toolCallJournal[id]
        ?? Object.values(next.toolCallJournal).find(
          (entry) => entry.idempotencyKey === input.idempotencyKey,
        ),
      'Tool call journal record was not projected',
    );
  }

  async transitionToolCall(
    workId: string,
    toolCallRecordId: string,
    nextStatus: Exclude<ToolCallJournalRecord['status'], 'prepared'>,
    input: { resultRef?: string; error?: string },
    options: AppendEventOptions,
  ): Promise<ToolCallJournalRecord> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(
      projection.toolCallJournal[toolCallRecordId],
      `Tool call journal record not found: ${toolCallRecordId}`,
    );
    assertToolCallTransition(current.status, nextStatus);
    const now = options.occurredAt ?? this.clock();
    const toolCall: ToolCallJournalRecord = {
      ...current,
      status: nextStatus,
      recoveryStatus: toolRecoveryStatus(nextStatus, current.readOnly),
      ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(nextStatus === 'started' ? { startedAt: now } : {}),
      ...(nextStatus === 'finished' ? { finishedAt: now } : {}),
      ...(nextStatus === 'transcript_committed' ? { transcriptCommittedAt: now } : {}),
    };
    const next = await this.commit(workId, { type: 'tool_call.updated', toolCall }, options);
    return next.toolCallJournal[toolCallRecordId]!;
  }

  private async requireWorkProjection(
    workId: string,
  ): Promise<WorkProjection & { work: Work }> {
    const projection = await this.getProjection(workId);
    if (!projection.work) throw new V3DomainError('NOT_FOUND', `Work not found: ${workId}`);
    return projection as WorkProjection & { work: Work };
  }

  private async commitTaskExecutionClaim(
    workId: string,
    input: ClaimTaskExecutionInput,
    options: AppendEventOptions,
    operation: 'claim' | 'retry',
  ): Promise<ClaimTaskExecutionResult> {
    const projection = await this.requireWorkProjection(workId);
    const current = requireEntity(projection.tasks[input.taskId], `Task not found: ${input.taskId}`);
    const mission = requireEntity(
      projection.missions[current.missionId],
      `Mission not found: ${current.missionId}`,
    );
    if (
      (operation === 'claim' && current.status !== 'ready')
      || (operation === 'retry' && current.status !== 'revision_required')
    ) {
      throw conflict(
        operation === 'claim'
          ? 'Only a ready Task can be claimed'
          : 'Only a revision_required Task can be retried',
      );
    }
    const incompleteDependencies = current.dependsOnTaskIds.filter(
      (taskId) => projection.tasks[taskId]?.status !== 'completed',
    );
    if (incompleteDependencies.length > 0) {
      throw conflict(`Task dependencies are not completed: ${incompleteDependencies.join(', ')}`);
    }
    if (current.assignedAgentId && current.assignedAgentId !== input.agentId) {
      throw conflict('Task is assigned to another agent');
    }
    if (input.actorSnapshot.agentId !== input.agentId) {
      throw conflict('Session actorSnapshot does not match agentId');
    }
    if (projection.sessions[input.sessionId]) {
      throw alreadyExists('Session', input.sessionId);
    }
    if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1) {
      throw invalid('Run maxTurns must be a positive integer');
    }
    const previousRuns = Object.values(projection.runs)
      .filter((run) => run.taskId === current.id)
      .sort((left, right) => right.attempt - left.attempt);
    const previousRun = previousRuns[0];
    if (operation === 'retry' && (!previousRun || previousRun.status !== 'succeeded')) {
      throw conflict('A retry requires a previous succeeded Run');
    }
    const now = options.occurredAt ?? this.clock();
    const task: Task = {
      ...current,
      status: 'claimed',
      assignedAgentId: input.agentId,
      version: current.version + 1,
      updatedAt: now,
    };
    const runId = input.runId ?? this.idFactory();
    assertAbsent(projection.runs[runId], 'Run', runId);
    const run: Run = {
      id: runId,
      workId,
      missionId: mission.id,
      taskId: task.id,
      agentId: input.agentId,
      sessionId: input.sessionId,
      status: 'queued',
      attempt: (previousRun?.attempt ?? 0) + 1,
      maxTurns: input.maxTurns,
      turnsConsumed: 0,
      heartbeatAt: now,
      fencingToken: (previousRun?.fencingToken ?? 0) + 1,
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      cost: { currency: 'USD', amount: 0, estimated: true },
      toolCount: 0,
      workspaceExecution: { mode: 'none' },
      createdAt: now,
    };
    const parentSession = requireEntity(
      projection.sessions[projection.work.primarySessionId],
      `Primary Session not found: ${projection.work.primarySessionId}`,
    );
    if (parentSession.kind !== 'primary') throw conflict('Run Session parent must be primary');
    const session: Session = {
      id: input.sessionId,
      workId,
      kind: 'run',
      missionId: mission.id,
      taskId: task.id,
      runId: run.id,
      parentSessionId: parentSession.id,
      agentId: input.agentId,
      actorSnapshot: cloneActorSnapshot(input.actorSnapshot),
      status: 'active',
      transcriptRevision: 0,
      createdAt: now,
    };
    const decision: OrchestrationDecision = {
      id: input.decisionId ?? this.idFactory(),
      workId,
      missionId: mission.id,
      taskId: task.id,
      runId: run.id,
      kind: operation === 'retry' ? 'retry' : 'assignment',
      decision: operation === 'retry' ? 'retry_task' : 'claim_task',
      reason: input.decisionReason ?? (
        operation === 'retry'
          ? 'A revision attempt was assigned atomically.'
          : 'The scheduler selected an eligible worker and reserved capacity.'
      ),
      candidateAgentIds: normalizedStrings(
        input.candidateAgentIds ?? [input.agentId],
        'orchestration candidateAgentIds',
      ),
      selectedAgentId: input.agentId,
      inputs: {
        operation,
        attempt: run.attempt,
        readOnly: task.readOnly,
      },
      createdAt: now,
    };
    assertAbsent(
      projection.orchestrationDecisions[decision.id],
      'Orchestration decision',
      decision.id,
    );
    const next = await this.commit(
      workId,
      {
        type: 'execution.claimed',
        operation,
        task,
        run,
        session,
        decision,
      },
      options,
    );
    return {
      task: next.tasks[task.id]!,
      run: next.runs[run.id]!,
      session: next.sessions[session.id]!,
      decision: next.orchestrationDecisions[decision.id]!,
      revision: next.revision,
    };
  }

  private async commit(
    workId: string,
    event: WorkEvent,
    options: AppendEventOptions,
  ): Promise<WorkProjection> {
    const envelope = await this.store.appendWorkEvent(
      workId,
      {
        eventId: options.eventId ?? this.idFactory(),
        occurredAt: options.occurredAt ?? this.clock(),
        ...(options.actor ? { actor: options.actor } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.causationId ? { causationId: options.causationId } : {}),
        event,
      },
      options.expectedRevision,
    );
    const projection = await this.rebuildProjection(workId);
    this.emit('changed', {
      workId,
      revision: envelope.revision,
      event,
    } satisfies WorkRepositoryChange);
    return projection;
  }

  private async writeCheckpoint(
    workId: string,
    projection: WorkProjection,
    lastEventId: string | null,
  ): Promise<void> {
    await this.store.writeCheckpoint({
      schemaVersion: 3,
      scopeType: 'work',
      scopeId: workId,
      revision: projection.revision,
      lastEventId,
      updatedAt: projection.updatedAt,
      projection,
    });
  }
}

export function emptyWorkProjection(): WorkProjection {
  return {
    work: null,
    missions: {},
    tasks: {},
    runs: {},
    sessions: {},
    taskReports: {},
    coordinationMessages: {},
    coordinationMessageOrder: [],
    workspaceLeases: {},
    orchestrationDecisions: {},
    verificationRecords: {},
    toolCallJournal: {},
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

export function applyWorkEvent(
  projection: WorkProjection,
  envelope: WorkEventEnvelope,
): WorkProjection {
  const next: WorkProjection = {
    ...projection,
    missions: { ...projection.missions },
    tasks: { ...projection.tasks },
    runs: { ...projection.runs },
    sessions: { ...projection.sessions },
    taskReports: { ...projection.taskReports },
    coordinationMessages: { ...projection.coordinationMessages },
    coordinationMessageOrder: [...projection.coordinationMessageOrder],
    workspaceLeases: { ...projection.workspaceLeases },
    orchestrationDecisions: { ...projection.orchestrationDecisions },
    verificationRecords: { ...projection.verificationRecords },
    toolCallJournal: { ...projection.toolCallJournal },
    revision: envelope.revision,
    updatedAt: envelope.occurredAt,
  };
  const event = envelope.event;
  switch (event.type) {
    case 'work.created':
    case 'work.updated':
      next.work = event.work;
      break;
    case 'mission.created':
    case 'mission.updated':
      next.missions[event.mission.id] = event.mission;
      break;
    case 'task.created':
    case 'task.updated':
      next.tasks[event.task.id] = event.task;
      break;
    case 'task.reported':
      next.taskReports[event.report.id] = event.report;
      break;
    case 'run.created':
    case 'run.updated':
      next.runs[event.run.id] = event.run;
      break;
    case 'session.created':
    case 'session.updated':
      next.sessions[event.session.id] = event.session;
      break;
    case 'coordination.message.enqueued':
      next.coordinationMessages[event.message.id] = event.message;
      next.coordinationMessageOrder.push(event.message.id);
      break;
    case 'coordination.message.updated':
      next.coordinationMessages[event.message.id] = event.message;
      break;
    case 'workspace.lease.acquired':
    case 'workspace.lease.updated':
      next.workspaceLeases[event.lease.id] = event.lease;
      break;
    case 'orchestration.decision.recorded':
      next.orchestrationDecisions[event.decision.id] = event.decision;
      break;
    case 'verification.recorded':
    case 'verification.updated':
      next.verificationRecords[event.verification.id] = event.verification;
      break;
    case 'tool_call.journaled':
    case 'tool_call.updated':
      next.toolCallJournal[event.toolCall.id] = event.toolCall;
      break;
    case 'execution.claimed':
      next.tasks[event.task.id] = event.task;
      next.runs[event.run.id] = event.run;
      next.sessions[event.session.id] = event.session;
      next.orchestrationDecisions[event.decision.id] = event.decision;
      break;
    case 'execution.started':
      next.tasks[event.task.id] = event.task;
      next.runs[event.run.id] = event.run;
      for (const lease of event.leases) next.workspaceLeases[lease.id] = lease;
      break;
    case 'execution.heartbeat':
      next.runs[event.run.id] = event.run;
      for (const lease of event.leases) next.workspaceLeases[lease.id] = lease;
      break;
    case 'execution.terminal':
      next.tasks[event.task.id] = event.task;
      next.runs[event.run.id] = event.run;
      next.sessions[event.session.id] = event.session;
      for (const lease of event.leases) next.workspaceLeases[lease.id] = lease;
      if (event.report) next.taskReports[event.report.id] = event.report;
      if (event.decision) {
        next.orchestrationDecisions[event.decision.id] = event.decision;
      }
      break;
    case 'execution.verification_gated':
      next.tasks[event.task.id] = event.task;
      next.verificationRecords[event.verification.id] = event.verification;
      break;
  }
  return next;
}

function isUsableCheckpoint(
  checkpoint: ProjectionCheckpoint<WorkProjection> | null,
  events: WorkEventEnvelope[],
): checkpoint is ProjectionCheckpoint<WorkProjection> {
  if (!checkpoint || checkpoint.revision > events.length) return false;
  if (checkpoint.projection.revision !== checkpoint.revision) return false;
  const expectedEventId = checkpoint.revision === 0
    ? null
    : events[checkpoint.revision - 1]?.eventId;
  return checkpoint.lastEventId === expectedEventId;
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function normalizedStrings(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    throw invalid(`${label} must contain only non-empty strings`);
  }
  return [...new Set(normalized)];
}

function normalizeVerificationPolicy(policy: VerificationPolicy): VerificationPolicy {
  if (
    policy.mode !== 'automatic'
    && policy.mode !== 'independent_agent'
    && policy.mode !== 'user'
  ) {
    throw invalid('Mission verificationPolicy mode is invalid');
  }
  if (policy.reviewerAgentId && policy.mode !== 'independent_agent') {
    throw invalid('reviewerAgentId is only valid for independent_agent verification');
  }
  if (policy.mode === 'independent_agent' && !policy.requireDifferentAgent) {
    throw invalid('independent_agent verification must require a different agent');
  }
  if (
    !Number.isSafeInteger(policy.maxRevisionAttempts)
    || policy.maxRevisionAttempts < 0
  ) {
    throw invalid('Mission maxRevisionAttempts must be a non-negative integer');
  }
  return {
    mode: policy.mode,
    ...(policy.reviewerAgentId ? { reviewerAgentId: policy.reviewerAgentId } : {}),
    requireDifferentAgent: policy.requireDifferentAgent,
    maxRevisionAttempts: policy.maxRevisionAttempts,
    requiredEvidence: normalizedStrings(
      policy.requiredEvidence,
      'Mission requiredEvidence',
    ),
  };
}

function validateTokenUsage(usage: TokenUsage): void {
  for (const [field, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalid(`Run tokenUsage.${field} must be a non-negative integer`);
    }
  }
}

function cloneWorkspaceExecution(execution: WorkspaceExecution): WorkspaceExecution {
  if (execution.mode === 'none') return { mode: 'none' };
  if (execution.mode === 'lease') {
    requireText(execution.workspaceId, 'workspaceExecution workspaceId');
    return {
      mode: 'lease',
      workspaceId: execution.workspaceId,
      leaseIds: normalizedStrings(execution.leaseIds, 'workspaceExecution leaseIds'),
      writeScope: normalizedStrings(execution.writeScope, 'workspaceExecution writeScope'),
    };
  }
  for (const [field, value] of Object.entries({
    workspaceId: execution.workspaceId,
    integrationBranch: execution.integrationBranch,
    taskBranch: execution.taskBranch,
    worktreePath: execution.worktreePath,
    baselineHead: execution.baselineHead,
  })) {
    requireText(value, `workspaceExecution ${field}`);
  }
  return { ...execution };
}

function cloneActorSnapshot(snapshot: Session['actorSnapshot']): Session['actorSnapshot'] {
  requireText(snapshot.agentId, 'actorSnapshot agentId');
  requireText(snapshot.name, 'actorSnapshot name');
  return {
    ...snapshot,
    capabilities: normalizedStrings(snapshot.capabilities, 'actorSnapshot capabilities'),
    enabledSkills: normalizedStrings(snapshot.enabledSkills, 'actorSnapshot enabledSkills'),
    allowedTools: normalizedStrings(snapshot.allowedTools, 'actorSnapshot allowedTools'),
  };
}

function assertMessageTransition(
  current: CoordinationMessage,
  nextStatus: CoordinationMessage['status'],
  consumingTurnId?: string,
): void {
  const transitions: Record<
    CoordinationMessage['status'],
    CoordinationMessage['status'][]
  > = {
    queued: ['delivered', 'dead_letter'],
    delivered: ['consumed', 'dead_letter'],
    consumed: ['acknowledged', 'delivered', 'dead_letter'],
    acknowledged: [],
    dead_letter: [],
  };
  if (!transitions[current.status].includes(nextStatus)) {
    throw conflict(`Message cannot transition from ${current.status} to ${nextStatus}`);
  }
  if (
    (nextStatus === 'consumed' || nextStatus === 'acknowledged')
    && !consumingTurnId?.trim()
  ) {
    throw invalid(`${nextStatus} requires consumingTurnId`);
  }
  if (
    nextStatus === 'acknowledged'
    && current.consumingTurnId !== consumingTurnId
  ) {
    throw conflict('Only the consuming turn can acknowledge a message');
  }
}

function normalizeWriteScopes(scopes: readonly string[]): string[] {
  if (scopes.length === 0) {
    throw invalid('writeScope must contain at least one path');
  }
  const normalized = scopes.map((scope) => {
    requireText(scope, 'writeScope path');
    let value = scope.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    while (value.startsWith('./')) value = value.slice(2);
    value = value.replace(/\/$/, '');
    if (!value) value = '.';
    if (
      value.startsWith('/')
      || /^[a-zA-Z]:\//.test(value)
      || value.split('/').some((segment) => segment === '..')
    ) {
      throw invalid(`writeScope must be workspace-relative: ${scope}`);
    }
    return value;
  });
  if (normalized.includes('.')) return ['.'];
  return [...new Set(normalized)].sort();
}

function assertNoActiveLeaseConflict(
  projection: WorkProjection,
  requested: WorkspaceLeaseRecord,
): void {
  const conflictLease = Object.values(projection.workspaceLeases).find((lease) => (
    lease.status === 'active'
    && Date.parse(lease.expiresAt) > Date.parse(requested.acquiredAt)
    && lease.workspaceId === requested.workspaceId
    && lease.ownerRunId !== requested.ownerRunId
    && lease.writeScope.some((held) => (
      requested.writeScope.some((candidate) => scopesOverlap(held, candidate))
    ))
  ));
  if (conflictLease) {
    throw conflict(`Workspace lease conflicts with active lease ${conflictLease.id}`);
  }
}

function scopesOverlap(left: string, right: string): boolean {
  return left === '.'
    || right === '.'
    || left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function isTerminalRun(status: Run['status']): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'recovery_required';
}

function isTerminalTask(status: Task['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function requireFutureTimestamp(value: string, now: string, label: string): void {
  const parsed = Date.parse(value);
  const current = Date.parse(now);
  if (!Number.isFinite(parsed) || !Number.isFinite(current) || parsed <= current) {
    throw invalid(`${label} must be a valid timestamp after the event time`);
  }
}

function cloneVerificationCriteria(
  criteria: VerificationRecord['criteria'],
): VerificationRecord['criteria'] {
  return criteria.map((result) => {
    requireText(result.criterion, 'verification criterion');
    return {
      criterion: result.criterion,
      passed: result.passed,
      evidence: normalizedStrings(result.evidence, 'verification evidence'),
      ...(result.note !== undefined ? { note: result.note } : {}),
    };
  });
}

function assertToolCallTransition(
  current: ToolCallJournalRecord['status'],
  next: ToolCallJournalRecord['status'],
): void {
  const transitions: Record<
    ToolCallJournalRecord['status'],
    ToolCallJournalRecord['status'][]
  > = {
    prepared: ['started'],
    started: ['finished'],
    finished: ['transcript_committed'],
    transcript_committed: [],
  };
  if (!transitions[current].includes(next)) {
    throw conflict(`Tool call cannot transition from ${current} to ${next}`);
  }
}

function toolRecoveryStatus(
  status: ToolCallJournalRecord['status'],
  readOnly: boolean,
): ToolCallJournalRecord['recoveryStatus'] {
  if (status === 'prepared') return 'start_pending';
  if (status === 'started') return readOnly ? 'replayable' : 'recovery_required';
  if (status === 'finished') return 'result_pending_commit';
  return 'committed';
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw invalid(`${label} is required`);
}

function assertAbsent(value: unknown, label: string, id: string): void {
  if (value) throw alreadyExists(label, id);
}

function requireEntity<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new V3DomainError('NOT_FOUND', message);
  return value;
}

function invalid(message: string): V3DomainError {
  return new V3DomainError('INVALID_ARGUMENT', message);
}

function conflict(message: string): V3DomainError {
  return new V3DomainError('CONFLICT', message);
}

function alreadyExists(label: string, id: string): V3DomainError {
  return new V3DomainError('ALREADY_EXISTS', `${label} already exists: ${id}`);
}
