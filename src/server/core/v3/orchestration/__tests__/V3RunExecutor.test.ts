import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompanyProjection, Run, WorkspaceLeaseRecord } from '../../../../../shared/types/v3/index.js';
import { V3ToolExecutionRegistry } from '../../runtime/V3ToolExecutionRegistry.js';
import { CompanyRepository } from '../../store/CompanyRepository.js';
import { WorkRepository } from '../../store/WorkRepository.js';
import {
  type AgentTurnExecutor,
  type V3AgentTurnRequest,
  type V3AgentTurnResult,
  type V3WorkspacePreparer,
  V3RunExecutor,
} from '../V3RunExecutor.js';

describe('V3RunExecutor', () => {
  let tempRoot = '';
  let companyRepository: CompanyRepository;
  let workRepository: WorkRepository;
  let company: CompanyProjection;
  let run: Run;
  let release: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-executor-'));
    companyRepository = new CompanyRepository(tempRoot);
    workRepository = new WorkRepository(tempRoot);
    await companyRepository.bootstrapCompany(
      {
        id: 'company-1',
        rootTeamId: 'team-1',
        mainAgentId: 'agent-1',
        membershipId: 'membership-1',
        name: 'AnoClaw',
        defaultLocale: 'en-US',
      },
      command(0),
    );
    await companyRepository.createWorkspace(
      { id: 'workspace-1', name: 'Workspace', rootPath: tempRoot },
      command(1),
    );
    company = await companyRepository.getProjection();
    await createWorkLineage(workRepository);
    const claimed = await workRepository.claimTaskExecution(
      'work-1',
      {
        taskId: 'task-1',
        agentId: 'agent-1',
        sessionId: 'run-session-1',
        runId: 'run-1',
        decisionId: 'decision-1',
        actorSnapshot: actorSnapshot(),
        maxTurns: 8,
      },
      command(4),
    );
    run = claimed.run;
    release = vi.fn(async () => {});
    V3ToolExecutionRegistry.resetInstance();
  });

  afterEach(async () => {
    V3ToolExecutionRegistry.resetInstance();
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('submits only after true Done, automatically verifies, and releases every terminal resource', async () => {
    const turnExecutor: AgentTurnExecutor = {
      execute: vi.fn(async () => ({
        type: 'done' as const,
        report: {
          outcome: 'submitted' as const,
          summary: 'Tests pass',
          artifacts: ['vitest:pass'],
        },
        turnsConsumed: 3,
        toolCount: 2,
      })),
    };
    const registry = V3ToolExecutionRegistry.getInstance();
    const executor = new V3RunExecutor({
      workRepository,
      companyRepository,
      turnExecutor,
      workspacePreparer: preparer(release),
      toolRegistry: registry,
    });

    await executor.execute('work-1', run.id);

    const projection = await workRepository.getProjection('work-1');
    expect(projection.runs[run.id]).toMatchObject({
      status: 'succeeded',
      terminationReason: 'completed',
      turnsConsumed: 3,
      toolCount: 2,
    });
    expect(projection.tasks['task-1']?.status).toBe('completed');
    expect(projection.sessions['run-session-1']).toMatchObject({
      status: 'closed',
      closedAt: expect.any(String),
    });
    expect(Object.values(projection.taskReports)).toEqual([
      expect.objectContaining({ runId: run.id, summary: 'Tests pass' }),
    ]);
    expect(Object.values(projection.verificationRecords)).toEqual([
      expect.objectContaining({ mode: 'automatic', outcome: 'approved' }),
    ]);
    expect(Object.values(projection.workspaceLeases)).toEqual([
      expect.objectContaining({ status: 'released', ownerRunId: run.id }),
    ]);
    expect(registry.get(run.sessionId)).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it('exposes a stable safe-turn wake callback for message adapters', () => {
    const wakeSafeTurnBoundary = vi.fn();
    const executor = new V3RunExecutor({
      workRepository,
      companyRepository,
      turnExecutor: {
        execute: vi.fn(),
        wakeSafeTurnBoundary,
      },
      workspacePreparer: preparer(release),
    });
    const wake = executor.wakeSafeTurnBoundary;

    wake('run-session-1');

    expect(wakeSafeTurnBoundary).toHaveBeenCalledWith('run-session-1');
  });

  it('does not submit max-turns or empty-report results', async () => {
    const turnExecutor: AgentTurnExecutor = {
      execute: vi.fn(async () => ({
        type: 'max_turns' as const,
        turnsConsumed: 8,
        message: 'budget exhausted',
      })),
    };
    const executor = new V3RunExecutor({
      workRepository,
      companyRepository,
      turnExecutor,
      workspacePreparer: preparer(release),
    });

    await executor.execute('work-1', run.id);

    const projection = await workRepository.getProjection('work-1');
    expect(projection.runs[run.id]).toMatchObject({
      status: 'failed',
      terminationReason: 'max_turns',
    });
    expect(projection.tasks['task-1']?.status).toBe('failed');
    expect(Object.values(projection.taskReports)).toHaveLength(0);
  });

  it.each([
    {
      mode: 'user' as const,
      reviewerAgentId: undefined,
    },
    {
      mode: 'independent_agent' as const,
      reviewerAgentId: 'reviewer-1',
    },
  ])('leaves $mode verification pending with an independent reviewer when required', async ({
    mode,
    reviewerAgentId,
  }) => {
    if (reviewerAgentId) {
      await companyRepository.createAgent(
        { id: reviewerAgentId, name: 'Reviewer' },
        command(company.revision),
      );
    }
    const projection = await workRepository.getProjection('work-1');
    await workRepository.updateMission(
      'work-1',
      'mission-1',
      {
        verificationPolicy: {
          mode,
          ...(reviewerAgentId ? { reviewerAgentId } : {}),
          requireDifferentAgent: mode === 'independent_agent',
          maxRevisionAttempts: 2,
          requiredEvidence: [],
        },
      },
      command(projection.revision),
    );
    const executor = new V3RunExecutor({
      workRepository,
      companyRepository,
      turnExecutor: {
        execute: vi.fn(async () => ({
          type: 'done' as const,
          report: {
            outcome: 'submitted' as const,
            summary: 'Ready for review',
            artifacts: [],
          },
          turnsConsumed: 1,
        })),
      },
      workspacePreparer: preparer(release),
    });

    await executor.execute('work-1', run.id);

    const finished = await workRepository.getProjection('work-1');
    expect(finished.tasks['task-1']?.status).toBe('verifying');
    expect(Object.values(finished.verificationRecords)).toEqual([
      expect.objectContaining({
        mode,
        outcome: 'pending',
        ...(reviewerAgentId ? { reviewerAgentId } : {}),
      }),
    ]);
    if (reviewerAgentId) {
      expect(Object.values(finished.verificationRecords)[0]?.workerAgentId)
        .not.toBe(reviewerAgentId);
    }
  });

  it('cascades stop through AbortSignal, Task, Run, Session, and lease cleanup', async () => {
    let request!: V3AgentTurnRequest;
    const turnExecutor: AgentTurnExecutor = {
      execute: vi.fn((input: V3AgentTurnRequest): Promise<V3AgentTurnResult> => {
        request = input;
        return new Promise<V3AgentTurnResult>((resolve) => {
          input.signal.addEventListener('abort', () => resolve({
            type: 'cancelled',
            turnsConsumed: 1,
          }), { once: true });
        });
      }),
      abort: vi.fn(),
    };
    const executor = new V3RunExecutor({
      workRepository,
      companyRepository,
      turnExecutor,
      workspacePreparer: preparer(release),
    });

    const executing = executor.execute('work-1', run.id);
    await waitUntil(() => Boolean(request));
    await executor.stop('work-1', 'task-1', 'user stop');
    await executing;

    const projection = await workRepository.getProjection('work-1');
    expect(request.signal.aborted).toBe(true);
    expect(projection.tasks['task-1']?.status).toBe('cancelled');
    expect(projection.runs[run.id]?.status).toBe('cancelled');
    expect(projection.sessions[run.sessionId]?.status).toBe('closed');
    expect(Object.values(projection.workspaceLeases)[0]?.status).toBe('released');
  });

  it('fails and cleans up a Run that exceeds the server runtime limit', async () => {
    const abort = vi.fn();
    const turnExecutor: AgentTurnExecutor = {
      execute(input) {
        return new Promise<V3AgentTurnResult>((resolve) => {
          input.signal.addEventListener('abort', () => resolve({
            type: 'cancelled',
            turnsConsumed: 1,
          }), { once: true });
        });
      },
      abort,
    };
    const executor = new V3RunExecutor({
      workRepository,
      companyRepository,
      turnExecutor,
      workspacePreparer: preparer(release),
      maxTaskRuntimeMs: 10,
    });

    await executor.execute('work-1', run.id);

    const projection = await workRepository.getProjection('work-1');
    expect(abort).toHaveBeenCalledWith(
      run.sessionId,
      'Task runtime exceeded 10ms',
    );
    expect(projection.tasks['task-1']?.status).toBe('failed');
    expect(projection.runs[run.id]).toMatchObject({
      status: 'failed',
      terminationReason: 'timeout',
      error: 'Task runtime exceeded 10ms',
    });
    expect(projection.sessions[run.sessionId]?.status).toBe('closed');
    expect(release).toHaveBeenCalledOnce();
  });

  it('marks interrupted write WAL recovery_required without replaying it', async () => {
    const started = await workRepository.startTaskExecution(
      'work-1',
      {
        runId: run.id,
        workspaceExecution: { mode: 'none' },
      },
      command(5),
    );
    const journal = await workRepository.prepareToolCall(
      'work-1',
      {
        runId: run.id,
        sessionId: run.sessionId,
        agentId: run.agentId,
        taskId: run.taskId,
        missionId: run.missionId,
        toolCallId: 'write-1',
        toolName: 'Write',
        readOnly: false,
        writeScope: ['src'],
        idempotencyKey: 'write-1',
      },
      command(started.revision),
    );
    await workRepository.transitionToolCall(
      'work-1',
      journal.id,
      'started',
      {},
      command(started.revision + 1),
    );
    const execute = vi.fn(async (): Promise<V3AgentTurnResult> => ({
      type: 'cancelled' as const,
      turnsConsumed: 0,
    }));
    const executor = new V3RunExecutor({
      workRepository,
      companyRepository,
      turnExecutor: { execute },
      workspacePreparer: preparer(release),
    });

    await executor.recover('work-1', run.id);

    const projection = await workRepository.getProjection('work-1');
    expect(execute).not.toHaveBeenCalled();
    expect(projection.runs[run.id]?.status).toBe('recovery_required');
    expect(projection.tasks['task-1']?.status).toBe('blocked');
    expect(projection.sessions[run.sessionId]?.status).toBe('closed');
  });
});

function preparer(release: ReturnType<typeof vi.fn>): V3WorkspacePreparer {
  return {
    prepare: vi.fn(async ({ run }) => ({
      workspaceExecution: {
        mode: 'lease' as const,
        workspaceId: 'workspace-1',
        leaseIds: ['lease-1'],
        writeScope: ['src'],
      },
      workspaceRoot: 'unused',
      leases: [{
        id: 'lease-1',
        workspaceId: 'workspace-1',
        writeScope: ['src'],
        fencingToken: run.fencingToken,
        expiresAt: '2099-01-01T00:00:00.000Z',
      }],
    })),
    release,
  };
}

async function createWorkLineage(repository: WorkRepository): Promise<void> {
  await repository.createWork(
    {
      id: 'work-1',
      companyId: 'company-1',
      workspaceId: 'workspace-1',
      primarySessionId: 'primary-session',
      title: 'Work',
      objective: 'Ship',
      status: 'active',
    },
    command(0),
  );
  await repository.createSession(
    'work-1',
    {
      id: 'primary-session',
      kind: 'primary',
      agentId: 'agent-1',
      actorSnapshot: actorSnapshot(),
    },
    command(1),
  );
  await repository.createMission(
    'work-1',
    {
      id: 'mission-1',
      title: 'Mission',
      objective: 'Deliver',
      acceptanceCriteria: ['Tests pass'],
      status: 'active',
      teamId: 'team-1',
      verificationPolicy: {
        mode: 'automatic',
        requireDifferentAgent: false,
        maxRevisionAttempts: 2,
        requiredEvidence: [],
      },
    },
    command(2),
  );
  await repository.createTask(
    'work-1',
    {
      id: 'task-1',
      missionId: 'mission-1',
      title: 'Task',
      status: 'ready',
      teamId: 'team-1',
      writeScope: ['src'],
    },
    command(3),
  );
}

function actorSnapshot() {
  return {
    agentId: 'agent-1',
    name: 'MainAgent',
    teamId: 'team-1',
    capabilities: [],
    enabledSkills: [],
    allowedTools: ['*'],
  };
}

function command(expectedRevision: number) {
  return {
    expectedRevision,
    occurredAt: `2026-01-01T00:00:${String(expectedRevision).padStart(2, '0')}.000Z`,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Condition was not reached');
}
