import { randomUUID } from 'node:crypto';
import type {
  Agent,
  CompanyProjection,
  Mission,
  SessionActorSnapshot,
  Task,
  WorkProjection,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import type { CompanyRepository } from '../store/CompanyRepository.js';
import type { WorkRepository } from '../store/WorkRepository.js';
import {
  CapabilityMatcher,
  type AgentCapabilitySnapshot,
  type CapabilityRequirements,
} from './CapabilityMatcher.js';
import {
  ConcurrencyPolicy,
  type LoopReservation,
} from './ConcurrencyPolicy.js';
import { FairTaskQueue } from './FairTaskQueue.js';
import type { V3RunExecutor } from './V3RunExecutor.js';

export interface CoordinationSchedulerOptions {
  companyRepository: CompanyRepository;
  workRepository: WorkRepository;
  runExecutor: V3RunExecutor;
  fairQueue?: FairTaskQueue;
  concurrencyPolicy?: ConcurrencyPolicy;
  capabilityMatcher?: CapabilityMatcher;
  requirementsForTask?: (
    task: Task,
    mission: Mission,
  ) => CapabilityRequirements | Promise<CapabilityRequirements>;
  snapshotForAgent?: (
    agent: Agent,
    company: CompanyProjection,
    activeLoops: readonly LoopReservation[],
  ) => AgentCapabilitySnapshot | Promise<AgentCapabilitySnapshot>;
  maxTurnsForTask?: (task: Task, mission: Mission) => number;
  clock?: () => string;
  idFactory?: () => string;
  onError?: (error: unknown) => void;
}

interface DispatchableTask {
  task: Task;
  mission: Mission;
  projection: WorkProjection;
  retry: boolean;
}

interface WorkerSelection {
  agent: Agent;
  candidateAgentIds: string[];
  reason: string;
}

/**
 * Event-driven, server-owned dispatcher. Repositories wake it after durable
 * Work or Company changes; there is intentionally no polling interval.
 */
export class CoordinationScheduler {
  private readonly companyRepository: CompanyRepository;
  private readonly workRepository: WorkRepository;
  private readonly runExecutor: V3RunExecutor;
  private readonly fairQueue: FairTaskQueue;
  private readonly concurrencyPolicy: ConcurrencyPolicy;
  private readonly capabilityMatcher: CapabilityMatcher;
  private readonly requirementsForTask: NonNullable<
    CoordinationSchedulerOptions['requirementsForTask']
  >;
  private readonly snapshotForAgent: NonNullable<
    CoordinationSchedulerOptions['snapshotForAgent']
  >;
  private readonly maxTurnsForTask: NonNullable<
    CoordinationSchedulerOptions['maxTurnsForTask']
  >;
  private readonly clock: () => string;
  private readonly idFactory: () => string;
  private readonly onError: (error: unknown) => void;
  private readonly launchedRuns = new Set<string>();
  private started = false;
  private wakePending = false;
  private drainPromise: Promise<void> | null = null;
  private wakeWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private readonly repositoryWake = () => {
    void this.wake();
  };

  constructor(options: CoordinationSchedulerOptions) {
    this.companyRepository = options.companyRepository;
    this.workRepository = options.workRepository;
    this.runExecutor = options.runExecutor;
    this.fairQueue = options.fairQueue ?? new FairTaskQueue();
    this.concurrencyPolicy = options.concurrencyPolicy ?? new ConcurrencyPolicy();
    this.capabilityMatcher = options.capabilityMatcher ?? new CapabilityMatcher();
    this.requirementsForTask = options.requirementsForTask ?? (() => ({}));
    this.snapshotForAgent = options.snapshotForAgent ?? defaultCapabilitySnapshot;
    this.maxTurnsForTask = options.maxTurnsForTask ?? (() => 24);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.onError = options.onError ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.companyRepository.on('changed', this.repositoryWake);
    this.workRepository.on('changed', this.repositoryWake);
    await this.recover();
    await this.wake();
  }

  /**
   * Coalesces repository changes into one serialized dispatch pass. The
   * returned promise settles after all currently coalesced changes are read.
   */
  wake(): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.wakePending = true;
    const promise = new Promise<void>((resolve, reject) => {
      this.wakeWaiters.push({ resolve, reject });
    });
    if (!this.drainPromise) {
      this.drainPromise = Promise.resolve()
        .then(() => this.drain())
        .finally(() => {
          this.drainPromise = null;
          if (this.started && this.wakePending) void this.wake();
        });
    }
    return promise;
  }

  /**
   * Stops dispatching new work. Active Runs are not cancelled; stopTask owns
   * the explicit Task -> Run -> Session cancellation cascade.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.companyRepository.off('changed', this.repositoryWake);
    this.workRepository.off('changed', this.repositoryWake);
    await this.drainPromise?.catch(() => {});
    this.resolveWakeWaiters();
  }

  async stopTask(workId: string, taskId: string, reason?: string): Promise<void> {
    await this.runExecutor.stop(workId, taskId, reason);
    await this.wake();
  }

  /**
   * Startup recovery is a finite scan. Queued and safely resumable Runs are
   * relaunched; ambiguous write WAL is delegated to V3RunExecutor, which marks
   * recovery_required instead of replaying it.
   */
  async recover(): Promise<void> {
    const workIds = await this.workRepository.listWorkIds();
    for (const workId of workIds) {
      const projection = await this.workRepository.getProjection(workId);
      const recoverable = Object.values(projection.runs)
        .filter((run) => (
          run.status === 'queued'
          || run.status === 'running'
          || run.status === 'recovery_required'
        ))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      for (const run of recoverable) {
        this.launch(workId, run.id, true);
      }
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.started && this.wakePending) {
        this.wakePending = false;
        await this.dispatchReadyTasks();
      }
      this.resolveWakeWaiters();
    } catch (error) {
      this.onError(error);
      this.rejectWakeWaiters(error);
      throw error;
    }
  }

  private async dispatchReadyTasks(): Promise<void> {
    const company = await this.companyRepository.getProjection();
    if (!company.company) return;
    const projections = await this.loadOwnedWorkProjections(company.company.id);
    await this.promoteDependencyReadyTasks(projections);
    const refreshed = await this.loadOwnedWorkProjections(company.company.id);
    const activeLoops = activeReservations(refreshed);
    const dispatchable = dispatchableTasks(refreshed);
    const orderedTasks = this.fairQueue.order(
      dispatchable.map((entry) => entry.task),
      Date.parse(this.clock()),
    );
    const byTask = new Map(dispatchable.map((entry) => [entry.task, entry]));

    for (const orderedTask of orderedTasks) {
      if (!this.started) return;
      const entry = byTask.get(orderedTask);
      if (!entry) continue;
      const latest = await this.workRepository.getProjection(entry.task.workId);
      const task = latest.tasks[entry.task.id];
      const mission = task ? latest.missions[task.missionId] : undefined;
      if (
        !task
        || !mission
        || (task.status !== 'ready' && task.status !== 'revision_required')
        || !dependenciesCompleted(task, latest)
      ) {
        continue;
      }
      if (task.status === 'revision_required' && !retryAllowed(task, mission, latest)) {
        await this.failExhaustedRetry(task, latest);
        continue;
      }
      const selection = await this.selectWorker(task, mission, company, activeLoops);
      if (!selection) continue;
      const reservation: LoopReservation = {
        companyId: company.company.id,
        missionId: mission.id,
        agentId: selection.agent.id,
        accessMode: task.readOnly ? 'read' : 'write',
      };
      if (!this.concurrencyPolicy.canStart(reservation, activeLoops).allowed) continue;
      const now = this.clock();
      const claimInput = {
        taskId: task.id,
        agentId: selection.agent.id,
        sessionId: this.idFactory(),
        runId: this.idFactory(),
        decisionId: this.idFactory(),
        actorSnapshot: actorSnapshot(
          selection.agent,
          primaryTeamId(selection.agent.id, company),
        ),
        maxTurns: this.maxTurnsForTask(task, mission),
        candidateAgentIds: selection.candidateAgentIds,
        decisionReason: selection.reason,
      };
      try {
        const claimed = task.status === 'revision_required'
          ? await this.workRepository.retryTaskExecution(
            task.workId,
            claimInput,
            command(latest.revision, now),
          )
          : await this.workRepository.claimTaskExecution(
            task.workId,
            claimInput,
            command(latest.revision, now),
          );
        activeLoops.push(reservation);
        this.launch(task.workId, claimed.run.id, false);
      } catch (error) {
        if (error instanceof V3DomainError && error.code === 'REVISION_CONFLICT') {
          this.wakePending = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async promoteDependencyReadyTasks(
    projections: WorkProjection[],
  ): Promise<void> {
    for (const projection of projections) {
      if (projection.work?.status !== 'active') continue;
      for (const task of Object.values(projection.tasks)) {
        const mission = projection.missions[task.missionId];
        if (
          task.status !== 'pending'
          || mission?.status !== 'active'
          || !dependenciesCompleted(task, projection)
        ) {
          continue;
        }
        try {
          await this.workRepository.updateTask(
            task.workId,
            task.id,
            { status: 'ready' },
            command(projection.revision, this.clock()),
          );
          break;
        } catch (error) {
          if (error instanceof V3DomainError && error.code === 'REVISION_CONFLICT') {
            this.wakePending = true;
            break;
          }
          throw error;
        }
      }
    }
  }

  private async selectWorker(
    task: Task,
    mission: Mission,
    company: CompanyProjection,
    activeLoops: readonly LoopReservation[],
  ): Promise<WorkerSelection | null> {
    const teamMemberships = Object.values(company.memberships).filter((membership) => (
      !membership.removedAt
      && (!task.teamId || membership.teamId === task.teamId)
    ));
    const teamAgentIds = new Set(teamMemberships.map((membership) => membership.agentId));
    let candidates = Object.values(company.agents).filter((agent) => (
      agent.status === 'active'
      && (!task.teamId || teamAgentIds.has(agent.id))
      && (
        mission.verificationPolicy.mode !== 'independent_agent'
        || mission.verificationPolicy.reviewerAgentId !== agent.id
      )
    ));
    if (task.assignedAgentId) {
      candidates = candidates.filter((agent) => agent.id === task.assignedAgentId);
    }
    if (candidates.length === 0) return null;
    const requirements = await this.requirementsForTask(task, mission);
    const snapshots = await Promise.all(
      candidates.map((agent) => this.snapshotForAgent(agent, company, activeLoops)),
    );
    const memberIds = new Set(teamMemberships
      .filter((membership) => membership.role === 'member')
      .map((membership) => membership.agentId));
    const workerSnapshots = snapshots.filter((snapshot) => memberIds.has(snapshot.agent.id));
    const workerMatch = this.capabilityMatcher.match(requirements, workerSnapshots);
    const allMatch = this.capabilityMatcher.match(requirements, snapshots);
    const requestFor = (agent: Agent): LoopReservation => ({
      companyId: agent.companyId,
      missionId: mission.id,
      agentId: agent.id,
      accessMode: task.readOnly ? 'read' : 'write',
    });
    const availableWorker = workerMatch.ranked.find((candidate) => (
      this.concurrencyPolicy.canStart(requestFor(candidate.agent), activeLoops).allowed
    ));
    const availableCandidate = allMatch.ranked.find((candidate) => (
      this.concurrencyPolicy.canStart(requestFor(candidate.agent), activeLoops).allowed
    ));
    const selected = availableWorker ?? availableCandidate;
    if (!selected) return null;
    return {
      agent: selected.agent,
      candidateAgentIds: allMatch.ranked.map((candidate) => candidate.agent.id),
      reason: availableWorker
        ? 'Selected the highest-ranked capable team worker; the leader remains coordinator.'
        : 'No capable team worker had capacity, so the highest-ranked available leader may execute.',
    };
  }

  private launch(workId: string, runId: string, recovering: boolean): void {
    if (this.launchedRuns.has(runId) || this.runExecutor.isExecuting(runId)) return;
    this.launchedRuns.add(runId);
    const execution = recovering
      ? this.runExecutor.recover(workId, runId)
      : this.runExecutor.execute(workId, runId);
    void execution
      .catch(this.onError)
      .finally(() => {
        this.launchedRuns.delete(runId);
        void this.wake();
      });
  }

  private async failExhaustedRetry(
    task: Task,
    projection: WorkProjection,
  ): Promise<void> {
    await this.workRepository.updateTask(
      task.workId,
      task.id,
      { status: 'failed', completedAt: this.clock() },
      command(projection.revision, this.clock()),
    );
  }

  private async loadOwnedWorkProjections(companyId: string): Promise<WorkProjection[]> {
    const workIds = await this.workRepository.listWorkIds();
    const projections = await Promise.all(
      workIds.map((workId) => this.workRepository.getProjection(workId)),
    );
    return projections.filter((projection) => projection.work?.companyId === companyId);
  }

  private resolveWakeWaiters(): void {
    const waiters = this.wakeWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private rejectWakeWaiters(error: unknown): void {
    const waiters = this.wakeWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}

function dispatchableTasks(projections: WorkProjection[]): DispatchableTask[] {
  return projections.flatMap((projection): DispatchableTask[] => {
    if (projection.work?.status !== 'active') return [];
    return Object.values(projection.tasks)
      .filter((task) => {
        const mission = projection.missions[task.missionId];
        return (
          (task.status === 'ready' || task.status === 'revision_required')
          && mission?.status === 'active'
          && dependenciesCompleted(task, projection)
        );
      })
      .map((task) => ({
        task,
        mission: projection.missions[task.missionId]!,
        projection,
        retry: task.status === 'revision_required',
      }));
  });
}

function dependenciesCompleted(task: Task, projection: WorkProjection): boolean {
  return task.dependsOnTaskIds.every(
    (dependencyId) => projection.tasks[dependencyId]?.status === 'completed',
  );
}

function retryAllowed(task: Task, mission: Mission, projection: WorkProjection): boolean {
  const latestAttempt = Math.max(
    0,
    ...Object.values(projection.runs)
      .filter((run) => run.taskId === task.id)
      .map((run) => run.attempt),
  );
  return Math.max(0, latestAttempt - 1) < mission.verificationPolicy.maxRevisionAttempts;
}

function activeReservations(projections: WorkProjection[]): LoopReservation[] {
  return projections.flatMap((projection): LoopReservation[] => {
    const companyId = projection.work?.companyId;
    if (!companyId) return [];
    return Object.values(projection.runs)
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run): LoopReservation => ({
        companyId,
        missionId: run.missionId,
        agentId: run.agentId,
        accessMode: projection.tasks[run.taskId]?.readOnly ? 'read' : 'write',
      }));
  });
}

function defaultCapabilitySnapshot(
  agent: Agent,
  company: CompanyProjection,
  activeLoops: readonly LoopReservation[],
): AgentCapabilitySnapshot {
  const activeCount = activeLoops.filter((loop) => loop.agentId === agent.id).length;
  return {
    agent,
    relevantMemoryKeys: [],
    successRate: 1,
    activeLoadRatio: Math.min(1, activeCount / 2),
    estimatedCost: 0,
    availableContextTokens: Number.MAX_SAFE_INTEGER,
    teamIds: Object.values(company.memberships)
      .filter((membership) => membership.agentId === agent.id && !membership.removedAt)
      .map((membership) => membership.teamId),
    idleSince: agent.updatedAt,
  };
}

function actorSnapshot(agent: Agent, teamId: string | undefined): SessionActorSnapshot {
  return {
    agentId: agent.id,
    name: agent.name,
    ...(teamId ? { teamId } : {}),
    ...(agent.instructions ? { instructions: agent.instructions } : {}),
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    capabilities: [...agent.capabilities],
    enabledSkills: [...agent.enabledSkills],
    allowedTools: [...agent.allowedTools],
  };
}

function primaryTeamId(agentId: string, company: CompanyProjection): string | undefined {
  return Object.values(company.memberships).find((membership) => (
    membership.agentId === agentId
    && membership.isPrimary
    && !membership.removedAt
  ))?.teamId;
}

function command(expectedRevision: number, occurredAt: string) {
  return {
    expectedRevision,
    occurredAt,
    actor: { type: 'system' as const, id: 'coordination-scheduler' },
  };
}
