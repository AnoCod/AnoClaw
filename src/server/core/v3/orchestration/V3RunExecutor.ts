import { randomUUID } from 'node:crypto';
import type {
  Agent,
  CompanyProjection,
  Mission,
  Run,
  RunCost,
  Session,
  Task,
  TaskReportOutcome,
  TokenUsage,
  ToolCallJournalRecord,
  VerificationCriterionResult,
  Work,
  WorkspaceExecution,
  WorkspaceLeaseRecord,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import { V3ToolExecutionRegistry } from '../runtime/V3ToolExecutionRegistry.js';
import type { CompanyRepository } from '../store/CompanyRepository.js';
import type {
  FinishTaskExecutionInput,
  WorkRepository,
} from '../store/WorkRepository.js';

export interface V3TaskReportDraft {
  outcome: Extract<TaskReportOutcome, 'submitted' | 'completed'>;
  summary: string;
  details?: string;
  artifacts: string[];
}

export interface V3AgentTurnRequest {
  work: Work;
  mission: Mission;
  task: Task;
  run: Run;
  session: Session;
  agent: Agent;
  signal: AbortSignal;
  recovering: boolean;
  onHeartbeat: (progress?: V3AgentTurnProgress) => void;
}

export interface V3AgentTurnProgress {
  turnsConsumed?: number;
  lastCompletedToolCallId?: string;
}

export type V3AgentTurnResult =
  | {
    type: 'done';
    report: V3TaskReportDraft;
    turnsConsumed: number;
    tokenUsage?: TokenUsage;
    cost?: RunCost;
    toolCount?: number;
    lastCompletedToolCallId?: string;
  }
  | {
    type: 'max_turns' | 'error' | 'cancelled' | 'interrupted';
    turnsConsumed: number;
    message?: string;
    tokenUsage?: TokenUsage;
    cost?: RunCost;
    toolCount?: number;
    lastCompletedToolCallId?: string;
  };

export interface AgentTurnExecutor {
  execute(request: V3AgentTurnRequest): Promise<V3AgentTurnResult>;
  abort?(sessionId: string, reason?: string): void | Promise<void>;
  wakeSafeTurnBoundary?(sessionId: string): void;
}

export interface PreparedV3Workspace {
  workspaceExecution: WorkspaceExecution;
  workspaceRoot?: string;
  leases?: Array<Omit<
    WorkspaceLeaseRecord,
    'workId' | 'ownerRunId' | 'ownerTaskId' | 'ownerAgentId' | 'status' | 'acquiredAt'
  >>;
}

export interface V3WorkspacePreparer {
  prepare(input: {
    company: CompanyProjection;
    work: Work;
    mission: Mission;
    task: Task;
    run: Run;
    agent: Agent;
    recovering: boolean;
    activeLeases: WorkspaceLeaseRecord[];
  }): Promise<PreparedV3Workspace>;
  heartbeat?(input: {
    workId: string;
    run: Run;
    leases: WorkspaceLeaseRecord[];
  }): Promise<{ leaseExpiresAt?: string } | void>;
  release(input: {
    workId: string;
    run: Run;
    workspaceExecution: WorkspaceExecution;
    leases: WorkspaceLeaseRecord[];
    reason: string;
  }): Promise<void>;
}

export interface V3RunExecutorOptions {
  workRepository: WorkRepository;
  companyRepository: CompanyRepository;
  turnExecutor: AgentTurnExecutor;
  workspacePreparer: V3WorkspacePreparer;
  toolRegistry?: V3ToolExecutionRegistry;
  clock?: () => string;
  idFactory?: () => string;
  maxTaskRuntimeMs?: number;
}

export interface ExecuteRunOptions {
  recovering?: boolean;
}

/**
 * Owns one v3 Run from its durable queue record through its terminal cleanup.
 *
 * AgentLoop is deliberately hidden behind AgentTurnExecutor. This keeps the
 * scheduler server-owned and makes a real Done result, rather than a stopped
 * loop or exhausted maxTurns, the only path that may submit a TaskReport.
 */
export class V3RunExecutor {
  private readonly workRepository: WorkRepository;
  private readonly companyRepository: CompanyRepository;
  private readonly turnExecutor: AgentTurnExecutor;
  private readonly workspacePreparer: V3WorkspacePreparer;
  private readonly toolRegistry: V3ToolExecutionRegistry;
  private readonly clock: () => string;
  private readonly idFactory: () => string;
  private readonly maxTaskRuntimeMs: number;
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();

  constructor(options: V3RunExecutorOptions) {
    this.workRepository = options.workRepository;
    this.companyRepository = options.companyRepository;
    this.turnExecutor = options.turnExecutor;
    this.workspacePreparer = options.workspacePreparer;
    this.toolRegistry = options.toolRegistry ?? V3ToolExecutionRegistry.getInstance();
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxTaskRuntimeMs = options.maxTaskRuntimeMs ?? 600_000;
    if (!Number.isSafeInteger(this.maxTaskRuntimeMs) || this.maxTaskRuntimeMs <= 0) {
      throw new V3DomainError(
        'INVALID_ARGUMENT',
        'maxTaskRuntimeMs must be a positive integer',
      );
    }
  }

  isExecuting(runId: string): boolean {
    return this.executions.has(runId);
  }

  /** Stable callback that API/tool adapters may invoke after durable enqueue. */
  readonly wakeSafeTurnBoundary = (sessionId: string): void => {
    this.turnExecutor.wakeSafeTurnBoundary?.(sessionId);
  };

  execute(workId: string, runId: string, options: ExecuteRunOptions = {}): Promise<void> {
    const existing = this.executions.get(runId);
    if (existing) return existing;
    const execution = this.executeInternal(workId, runId, options)
      .finally(() => {
        this.executions.delete(runId);
        this.controllers.delete(runId);
      });
    this.executions.set(runId, execution);
    return execution;
  }

  async recover(workId: string, runId: string): Promise<void> {
    const projection = await this.workRepository.getProjection(workId);
    const run = projection.runs[runId];
    if (!run) return;
    if (run.status === 'recovery_required') {
      await this.finish(
        workId,
        run,
        {
          taskStatus: 'blocked',
          runStatus: 'recovery_required',
          terminationReason: 'interrupted',
          error: 'Manual recovery is required before this Run can continue.',
          decision: {
            kind: 'recovery',
            decision: 'manual_recovery_required',
            reason: 'The durable Run was already marked recovery_required.',
            candidateAgentIds: [run.agentId],
            selectedAgentId: run.agentId,
          },
        },
      );
      await this.releaseExternal(workId, run, 'recovery_required');
      return;
    }
    if (run.status !== 'queued' && run.status !== 'running') return;
    const journals = Object.values(projection.toolCallJournal)
      .filter((journal) => journal.runId === runId);
    if (hasAmbiguousWrite(journals)) {
      await this.finish(
        workId,
        run,
        {
          taskStatus: 'blocked',
          runStatus: 'recovery_required',
          terminationReason: 'interrupted',
          error: 'An interrupted write tool call may already have side effects.',
          decision: {
            kind: 'recovery',
            decision: 'manual_recovery_required',
            reason: 'An ambiguous write-ahead journal entry must not be replayed blindly.',
            candidateAgentIds: [run.agentId],
            selectedAgentId: run.agentId,
          },
        },
      );
      await this.releaseExternal(workId, run, 'ambiguous_write_wal');
      return;
    }
    await this.execute(workId, runId, { recovering: run.status === 'running' });
  }

  async stop(workId: string, taskId: string, reason = 'Stopped by request'): Promise<void> {
    const projection = await this.workRepository.getProjection(workId);
    const run = Object.values(projection.runs)
      .filter((candidate) => candidate.taskId === taskId)
      .sort((left, right) => right.attempt - left.attempt)[0];
    if (!run || isTerminalRun(run.status)) return;
    this.controllers.get(run.id)?.abort(reason);
    await this.turnExecutor.abort?.(run.sessionId, reason);
    try {
      await this.finish(
        workId,
        run,
        {
          taskStatus: 'cancelled',
          runStatus: 'cancelled',
          terminationReason: 'cancelled',
          error: reason,
          decision: {
            kind: 'recovery',
            decision: 'stop_cascade',
            reason,
            candidateAgentIds: [run.agentId],
            selectedAgentId: run.agentId,
          },
        },
      );
    } finally {
      this.toolRegistry.unregister(run.sessionId, run.id);
      await this.releaseExternal(workId, run, 'cancelled');
    }
  }

  private async executeInternal(
    workId: string,
    runId: string,
    options: ExecuteRunOptions,
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    let runForCleanup: Run | undefined;
    let registered = false;
    let terminalReason = 'error';
    let preparedWorkspaceRoot: string | undefined;
    let timedOut = false;
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let projection = await this.workRepository.getProjection(workId);
      const company = await this.companyRepository.getProjection();
      const work = requireValue(projection.work, `Work not found: ${workId}`);
      let run = requireValue(projection.runs[runId], `Run not found: ${runId}`);
      let task = requireValue(projection.tasks[run.taskId], `Task not found: ${run.taskId}`);
      const mission = requireValue(
        projection.missions[run.missionId],
        `Mission not found: ${run.missionId}`,
      );
      const session = requireValue(
        projection.sessions[run.sessionId],
        `Session not found: ${run.sessionId}`,
      );
      const agent = requireValue(company.agents[run.agentId], `Agent not found: ${run.agentId}`);
      runForCleanup = run;
      const independentReviewerId = mission.verificationPolicy.mode === 'independent_agent'
        ? resolveIndependentReviewer(
          mission.verificationPolicy.reviewerAgentId,
          run.agentId,
          task.teamId,
          company,
        )
        : undefined;

      if (run.status === 'queued') {
        const prepared = await this.workspacePreparer.prepare({
          company,
          work,
          mission,
          task,
          run,
          agent,
          recovering: false,
          activeLeases: [],
        });
        preparedWorkspaceRoot = prepared.workspaceRoot;
        const started = await withRevisionRetry(
          this.workRepository,
          workId,
          (revision) => this.workRepository.startTaskExecution(
            workId,
            {
              runId,
              workspaceExecution: prepared.workspaceExecution,
              leases: prepared.leases,
            },
            command(revision, this.clock()),
          ),
        );
        run = started.run;
        task = started.task;
      } else if (run.status !== 'running') {
        return;
      }

      projection = await this.workRepository.getProjection(workId);
      run = requireValue(projection.runs[runId], `Run not found: ${runId}`);
      task = requireValue(projection.tasks[run.taskId], `Task not found: ${run.taskId}`);
      runForCleanup = run;
      const activeLeases = ownedActiveLeases(projection.workspaceLeases, run);
      const workspace = work.workspaceId ? company.workspaces[work.workspaceId] : undefined;
      const workspaceRoot = preparedWorkspaceRoot
        ?? executionWorkspaceRoot(run.workspaceExecution, workspace?.rootPath);
      this.toolRegistry.register({
        companyId: work.companyId,
        ...(task.teamId ?? mission.teamId ? { teamId: task.teamId ?? mission.teamId } : {}),
        workId,
        missionId: mission.id,
        taskId: task.id,
        runId: run.id,
        sessionId: run.sessionId,
        agentId: run.agentId,
        ...(work.workspaceId ? { workspaceId: work.workspaceId } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        readOnly: task.readOnly,
        writeScope: [...task.writeScope],
        fencingToken: run.fencingToken,
        activeLeases,
        allowedTools: [...agent.allowedTools],
        journal: this.createJournalHooks(workId, run),
      });
      registered = true;

      runtimeTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(`Task runtime exceeded ${this.maxTaskRuntimeMs}ms`);
        void this.turnExecutor.abort?.(
          run.sessionId,
          `Task runtime exceeded ${this.maxTaskRuntimeMs}ms`,
        );
      }, this.maxTaskRuntimeMs);
      runtimeTimer.unref?.();
      const result = await this.turnExecutor.execute({
        work,
        mission,
        task,
        run,
        session,
        agent,
        signal: controller.signal,
        recovering: options.recovering === true,
        onHeartbeat: (progress) => {
          void this.heartbeat(workId, runId, progress).catch(() => {});
        },
      });
      clearTimeout(runtimeTimer);
      runtimeTimer = undefined;

      if (timedOut) {
        terminalReason = 'timeout';
        await this.finish(
          workId,
          run,
          {
            taskStatus: 'failed',
            runStatus: 'failed',
            terminationReason: 'timeout',
            turnsConsumed: result.turnsConsumed,
            tokenUsage: result.tokenUsage,
            cost: result.cost,
            toolCount: result.toolCount,
            lastCompletedToolCallId: result.lastCompletedToolCallId,
            error: `Task runtime exceeded ${this.maxTaskRuntimeMs}ms`,
          },
        );
        return;
      }

      if (result.type === 'done' && hasNonEmptyReport(result.report)) {
        terminalReason = 'completed';
        const terminal = await this.finish(
          workId,
          run,
          {
            taskStatus: 'submitted',
            runStatus: 'succeeded',
            terminationReason: 'completed',
            turnsConsumed: result.turnsConsumed,
            tokenUsage: result.tokenUsage,
            cost: result.cost,
            toolCount: result.toolCount,
            lastCompletedToolCallId: result.lastCompletedToolCallId,
            resultSummary: result.report.summary,
            report: result.report,
            decision: {
              kind: 'recovery',
              decision: 'agent_turn_done',
              reason: 'AgentTurnExecutor returned Done with a non-empty TaskReport.',
              candidateAgentIds: [run.agentId],
              selectedAgentId: run.agentId,
            },
          },
        );
        if (terminal.run.status === 'succeeded') {
          await this.applyVerificationGate(
            workId,
            mission,
            terminal.task,
            terminal.run,
            result.report,
            company,
            independentReviewerId,
          );
        }
        return;
      }

      const cancelled = result.type === 'cancelled'
        || result.type === 'interrupted'
        || controller.signal.aborted;
      terminalReason = cancelled ? 'cancelled' : result.type;
      await this.finish(
        workId,
        run,
        {
          taskStatus: cancelled ? 'cancelled' : 'failed',
          runStatus: cancelled ? 'cancelled' : 'failed',
          terminationReason: cancelled
            ? 'cancelled'
            : result.type === 'max_turns'
              ? 'max_turns'
              : 'error',
          turnsConsumed: result.turnsConsumed,
          tokenUsage: result.tokenUsage,
          cost: result.cost,
          toolCount: result.toolCount,
          lastCompletedToolCallId: result.lastCompletedToolCallId,
          error: result.type === 'done'
            ? 'Done did not include a non-empty TaskReport.'
            : result.message,
          decision: {
            kind: 'recovery',
            decision: result.type === 'done' ? 'reject_empty_report' : 'agent_turn_not_done',
            reason: result.type === 'done'
              ? 'A Done result without a non-empty TaskReport cannot submit the Task.'
              : `AgentTurnExecutor terminated with ${result.type}.`,
            candidateAgentIds: [run.agentId],
            selectedAgentId: run.agentId,
          },
        },
      );
    } catch (error) {
      if (runForCleanup && !isTerminalRun(runForCleanup.status)) {
        terminalReason = timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'error';
        await this.finish(
          workId,
          runForCleanup,
          {
            taskStatus: timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed',
            runStatus: timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed',
            terminationReason: timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'error',
            error: timedOut
              ? `Task runtime exceeded ${this.maxTaskRuntimeMs}ms`
              : errorMessage(error),
          },
        ).catch(() => {});
      }
      if (!controller.signal.aborted) throw error;
    } finally {
      if (runtimeTimer) clearTimeout(runtimeTimer);
      if (registered && runForCleanup) {
        this.toolRegistry.unregister(runForCleanup.sessionId, runForCleanup.id);
      }
      if (runForCleanup) {
        await this.releaseExternal(workId, runForCleanup, terminalReason).catch(() => {});
      }
    }
  }

  private async heartbeat(
    workId: string,
    runId: string,
    _progress?: V3AgentTurnProgress,
  ): Promise<void> {
    const projection = await this.workRepository.getProjection(workId);
    const run = projection.runs[runId];
    if (!run || run.status !== 'running') return;
    const leases = ownedActiveLeases(projection.workspaceLeases, run);
    const prepared = await this.workspacePreparer.heartbeat?.({ workId, run, leases });
    const heartbeat = await withRevisionRetry(
      this.workRepository,
      workId,
      (revision) => this.workRepository.heartbeatTaskExecution(
        workId,
        runId,
        { ...(prepared?.leaseExpiresAt ? { leaseExpiresAt: prepared.leaseExpiresAt } : {}) },
        command(revision, this.clock()),
      ),
    );
    const context = this.toolRegistry.get(run.sessionId);
    if (context) {
      this.toolRegistry.register({
        ...context,
        activeLeases: heartbeat.leases,
      });
    }
  }

  private async finish(
    workId: string,
    run: Run,
    input: Omit<FinishTaskExecutionInput, 'runId'>,
  ) {
    return withRevisionRetry(
      this.workRepository,
      workId,
      (revision) => this.workRepository.finishTaskExecution(
        workId,
        { runId: run.id, ...defined(input) },
        command(revision, this.clock()),
      ),
    );
  }

  private async applyVerificationGate(
    workId: string,
    mission: Mission,
    task: Task,
    run: Run,
    report: V3TaskReportDraft,
    company: CompanyProjection,
    preflightReviewerId?: string,
  ): Promise<void> {
    const policy = mission.verificationPolicy;
    const evidence = [
      report.summary,
      report.details ?? '',
      ...report.artifacts,
    ].filter(Boolean);
    const criteria = automaticCriteria(mission, task, policy.requiredEvidence, evidence);
    if (policy.mode === 'automatic') {
      const approved = criteria.every((criterion) => criterion.passed);
      await withRevisionRetry(
        this.workRepository,
        workId,
        (revision) => this.workRepository.gateTaskVerification(
          workId,
          {
            runId: run.id,
            taskStatus: approved ? 'completed' : 'revision_required',
            verification: {
              id: this.idFactory(),
              mode: 'automatic',
              outcome: approved ? 'approved' : 'revision_required',
              summary: approved
                ? 'Automatic verification approved the submitted TaskReport.'
                : 'Automatic verification requires another revision.',
              criteria,
              revisionAttempt: Math.max(0, run.attempt - 1),
              completedAt: this.clock(),
            },
          },
          command(revision, this.clock()),
        ),
      );
      return;
    }

    const reviewerAgentId = policy.mode === 'independent_agent'
      ? preflightReviewerId
        ?? resolveIndependentReviewer(policy.reviewerAgentId, run.agentId, task.teamId, company)
      : undefined;
    await withRevisionRetry(
      this.workRepository,
      workId,
      (revision) => this.workRepository.gateTaskVerification(
        workId,
        {
          runId: run.id,
          taskStatus: 'verifying',
          verification: {
            id: this.idFactory(),
            mode: policy.mode,
            ...(reviewerAgentId ? { reviewerAgentId } : {}),
            outcome: 'pending',
            summary: policy.mode === 'independent_agent'
              ? 'Waiting for independent Agent verification.'
              : 'Waiting for user verification.',
            criteria: criteria.map((criterion) => ({ ...criterion, passed: false })),
            revisionAttempt: Math.max(0, run.attempt - 1),
          },
        },
        command(revision, this.clock()),
      ),
    );
  }

  private createJournalHooks(workId: string, run: Run) {
    return {
      prepare: async (input: {
        toolCallId: string;
        toolName: string;
        readOnly: boolean;
        writeScope: string[];
      }): Promise<string> => {
        const record = await withRevisionRetry(
          this.workRepository,
          workId,
          (revision) => this.workRepository.prepareToolCall(
            workId,
            {
              runId: run.id,
              sessionId: run.sessionId,
              agentId: run.agentId,
              taskId: run.taskId,
              missionId: run.missionId,
              toolCallId: input.toolCallId,
              toolName: input.toolName,
              readOnly: input.readOnly,
              writeScope: input.writeScope,
              idempotencyKey: `${run.id}:${input.toolCallId}`,
            },
            command(revision, this.clock()),
          ),
        );
        return record.id;
      },
      markStarted: async (recordId: string): Promise<void> => {
        await this.transitionJournal(workId, recordId, 'started');
      },
      markFinished: async (recordId: string, result: unknown): Promise<void> => {
        await this.transitionJournal(
          workId,
          recordId,
          'finished',
          JSON.stringify(result),
        );
      },
      markTranscriptCommitted: async (toolCallId: string): Promise<void> => {
        const projection = await this.workRepository.getProjection(workId);
        const record = Object.values(projection.toolCallJournal).find(
          (candidate) => candidate.runId === run.id
            && candidate.toolCallId === toolCallId
            && candidate.status === 'finished',
        );
        if (record) await this.transitionJournal(workId, record.id, 'transcript_committed');
      },
    };
  }

  private async transitionJournal(
    workId: string,
    recordId: string,
    status: Extract<ToolCallJournalRecord['status'], 'started' | 'finished' | 'transcript_committed'>,
    resultRef?: string,
  ): Promise<void> {
    await withRevisionRetry(
      this.workRepository,
      workId,
      (revision) => this.workRepository.transitionToolCall(
        workId,
        recordId,
        status,
        { ...(resultRef !== undefined ? { resultRef } : {}) },
        command(revision, this.clock()),
      ),
    );
  }

  private async releaseExternal(workId: string, run: Run, reason: string): Promise<void> {
    const projection = await this.workRepository.getProjection(workId);
    const currentRun = projection.runs[run.id] ?? run;
    const leases = Object.values(projection.workspaceLeases)
      .filter((lease) => lease.ownerRunId === run.id);
    await this.workspacePreparer.release({
      workId,
      run: currentRun,
      workspaceExecution: currentRun.workspaceExecution,
      leases,
      reason,
    });
  }
}

function automaticCriteria(
  mission: Mission,
  task: Task,
  requiredEvidence: readonly string[],
  evidence: string[],
): VerificationCriterionResult[] {
  const evidenceText = evidence.join('\n').toLocaleLowerCase();
  const acceptance = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria
    : mission.acceptanceCriteria;
  const criteria = acceptance.map((criterion): VerificationCriterionResult => ({
    criterion,
    passed: evidence.length > 0,
    evidence: [...evidence],
  }));
  for (const required of requiredEvidence) {
    criteria.push({
      criterion: `Required evidence: ${required}`,
      passed: evidenceText.includes(required.toLocaleLowerCase()),
      evidence: evidence.filter((entry) => (
        entry.toLocaleLowerCase().includes(required.toLocaleLowerCase())
      )),
    });
  }
  return criteria.length > 0
    ? criteria
    : [{ criterion: 'AgentTurn Done with TaskReport', passed: true, evidence }];
}

function resolveIndependentReviewer(
  configuredReviewerId: string | undefined,
  workerAgentId: string,
  teamId: string | undefined,
  company: CompanyProjection,
): string {
  if (configuredReviewerId) {
    if (configuredReviewerId === workerAgentId) {
      throw new V3DomainError(
        'CONFLICT',
        'Independent verification reviewer must differ from the worker',
      );
    }
    const reviewer = company.agents[configuredReviewerId];
    if (!reviewer || reviewer.status !== 'active') {
      throw new V3DomainError('NOT_FOUND', 'Independent verification reviewer is unavailable');
    }
    return configuredReviewerId;
  }
  const memberAgentIds = teamId
    ? new Set(Object.values(company.memberships)
      .filter((membership) => membership.teamId === teamId && !membership.removedAt)
      .map((membership) => membership.agentId))
    : null;
  const reviewer = Object.values(company.agents)
    .filter((agent) => (
      agent.id !== workerAgentId
      && agent.status === 'active'
      && (!memberAgentIds || memberAgentIds.has(agent.id))
    ))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!reviewer) {
    throw new V3DomainError(
      'CONFLICT',
      'Independent verification requires an active reviewer distinct from the worker',
    );
  }
  return reviewer.id;
}

function hasAmbiguousWrite(journals: ToolCallJournalRecord[]): boolean {
  return journals.some((journal) => (
    !journal.readOnly
    && (
      journal.status === 'started'
      || journal.recoveryStatus === 'recovery_required'
    )
  ));
}

function ownedActiveLeases(
  leases: Record<string, WorkspaceLeaseRecord>,
  run: Run,
): WorkspaceLeaseRecord[] {
  return Object.values(leases).filter((lease) => (
    lease.ownerRunId === run.id
    && lease.ownerTaskId === run.taskId
    && lease.ownerAgentId === run.agentId
    && lease.fencingToken === run.fencingToken
    && lease.status === 'active'
  ));
}

function executionWorkspaceRoot(
  execution: WorkspaceExecution,
  configuredRoot: string | undefined,
): string | undefined {
  return execution.mode === 'git_worktree' ? execution.worktreePath : configuredRoot;
}

function hasNonEmptyReport(report: V3TaskReportDraft | undefined): report is V3TaskReportDraft {
  return Boolean(
    report
    && (
      report.summary.trim()
      || report.details?.trim()
      || report.artifacts.some((artifact) => artifact.trim())
    ),
  );
}

function isTerminalRun(status: Run['status']): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'recovery_required';
}

async function withRevisionRetry<T>(
  repository: WorkRepository,
  workId: string,
  operation: (revision: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const revision = (await repository.getProjection(workId)).revision;
    try {
      return await operation(revision);
    } catch (error) {
      lastError = error;
      if (!(error instanceof V3DomainError) || error.code !== 'REVISION_CONFLICT') throw error;
    }
  }
  throw lastError;
}

function command(expectedRevision: number, occurredAt: string) {
  return {
    expectedRevision,
    occurredAt,
    actor: { type: 'system' as const, id: 'coordination-scheduler' },
  };
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new V3DomainError('NOT_FOUND', message);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
