import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  CompanyProjection,
  Mission,
  Run,
  Task,
  Work,
  WorkProjection,
  WorkspaceLeaseRecord,
} from '../../../../../shared/types/v3/index.js';
import type {
  MissionWorkspace,
  PreparedMissionWorkspace,
  TaskWorkspace,
} from '../GitWorkspaceIsolationService.js';
import { WorkspaceLeaseManager } from '../WorkspaceLeaseManager.js';
import { V3RepositoryWorkspacePreparer } from '../V3RepositoryWorkspacePreparer.js';

const temporaryRoots: string[] = [];
const NOW = Date.parse('2026-07-25T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fsp.rm(root, { recursive: true, force: true })
  )));
});

class FakeWorkRepository {
  constructor(readonly projections: Record<string, WorkProjection>) {}

  async listWorkIds(): Promise<string[]> {
    return Object.keys(this.projections);
  }

  async getProjection(workId: string): Promise<WorkProjection> {
    const projection = this.projections[workId];
    if (!projection) throw new Error(`unknown Work ${workId}`);
    return projection;
  }
}

class FakeGitIsolation {
  readonly prepareMission = vi.fn(async (): Promise<PreparedMissionWorkspace> => ({
    mode: 'lease',
    workspaceRoot: 'unused',
    reason: 'not_git_repository',
  }));
  readonly prepareTask = vi.fn(async (): Promise<TaskWorkspace> => {
    throw new Error('prepareTask should not be called');
  });
}

describe('V3RepositoryWorkspacePreparer', () => {
  it('restores durable leases from every Work and rejects overlapping scopes', async () => {
    const root = await temporaryWorkspace();
    const existing = activeLease({
      id: 'lease-existing',
      workId: 'work-other',
      ownerRunId: 'run-other',
      ownerTaskId: 'task-other',
      writeScope: ['src/features'],
    });
    const repository = new FakeWorkRepository({
      'work-other': projectionWithLease(existing),
      'work-1': emptyProjection(),
    });
    const preparer = new V3RepositoryWorkspacePreparer({
      workRepository: repository,
      leaseManager: new WorkspaceLeaseManager({
        clock: () => NOW,
        idFactory: () => 'lease-new',
      }),
      gitIsolation: new FakeGitIsolation(),
      leaseTtlMs: 30_000,
      clock: () => NOW,
    });

    await expect(preparer.prepare(prepareInput(root, {
      task: { ...task(), writeScope: ['src/features/chat'] },
    }))).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        holderRunId: 'run-other',
        requestedScope: 'src/features/chat',
        heldScope: 'src/features',
      },
    });
  });

  it('normalizes a fallback lease, renews it, and releases idempotently', async () => {
    const root = await temporaryWorkspace();
    let now = NOW;
    let leaseSequence = 0;
    const repository = new FakeWorkRepository({ 'work-1': emptyProjection() });
    const leaseManager = new WorkspaceLeaseManager({
      clock: () => now,
      idFactory: () => `lease-${++leaseSequence}`,
    });
    const git = new FakeGitIsolation();
    const preparer = new V3RepositoryWorkspacePreparer({
      workRepository: repository,
      leaseManager,
      gitIsolation: git,
      leaseTtlMs: 30_000,
      clock: () => now,
    });
    const input = prepareInput(root, {
      task: { ...task(), writeScope: ['src/app', 'src', './docs\\guide'] },
    });

    const prepared = await preparer.prepare(input);

    expect(prepared.workspaceExecution).toEqual({
      mode: 'lease',
      workspaceId: 'workspace-1',
      leaseIds: ['lease-1'],
      writeScope: ['docs/guide', 'src'],
    });
    expect(prepared.workspaceRoot).toBe(path.resolve(root));
    expect(prepared.leases).toMatchObject([{
      id: 'lease-1',
      workspaceId: 'workspace-1',
      writeScope: ['docs/guide', 'src'],
      fencingToken: 1,
      expiresAt: '2026-07-25T00:00:30.000Z',
    }]);

    const persistent = persistentLease(prepared.leases?.[0], input);
    repository.projections['work-1'] = projectionWithLease(persistent, input.run);
    now += 5_000;
    await expect(preparer.heartbeat({
      workId: 'work-1',
      run: input.run,
      leases: [persistent],
    })).resolves.toEqual({
      leaseExpiresAt: '2026-07-25T00:00:35.000Z',
    });

    await preparer.release({
      workId: 'work-1',
      run: input.run,
      workspaceExecution: prepared.workspaceExecution,
      leases: [persistent],
      reason: 'completed',
    });
    await preparer.release({
      workId: 'work-1',
      run: input.run,
      workspaceExecution: prepared.workspaceExecution,
      leases: [persistent],
      reason: 'completed',
    });
    expect(leaseManager.list()).toEqual([]);
  });

  it('uses a task-local Git worktree while retaining a fencing lease', async () => {
    const root = await temporaryWorkspace();
    const integrationPath = path.join(root, '.anoclaw-integration');
    const worktreePath = path.join(root, '.anoclaw-task');
    const missionWorkspace: MissionWorkspace = {
      mode: 'git-worktree',
      workId: 'work-1',
      missionId: 'mission-1',
      sourceWorkspaceRoot: root,
      repositoryRoot: root,
      baselineHead: 'abc123',
      baselineFiles: [],
      integrationBranch: 'anoclaw/work-1/mission-1/integration',
      integrationPath,
    };
    const git = {
      prepareMission: vi.fn(async () => missionWorkspace),
      prepareTask: vi.fn(async () => ({
        taskId: 'task-1',
        branch: 'anoclaw/work-1/mission-1/task-task-1',
        worktreePath,
        integrationBranch: missionWorkspace.integrationBranch,
      })),
    };
    const preparer = new V3RepositoryWorkspacePreparer({
      workRepository: new FakeWorkRepository({ 'work-1': emptyProjection() }),
      leaseManager: new WorkspaceLeaseManager({
        clock: () => NOW,
        idFactory: () => 'lease-git',
      }),
      gitIsolation: git,
      clock: () => NOW,
    });

    const prepared = await preparer.prepare(prepareInput(root));

    expect(prepared.workspaceExecution).toEqual({
      mode: 'git_worktree',
      workspaceId: 'workspace-1',
      integrationBranch: missionWorkspace.integrationBranch,
      taskBranch: 'anoclaw/work-1/mission-1/task-task-1',
      worktreePath,
      baselineHead: 'abc123',
    });
    expect(prepared.workspaceRoot).toBe(worktreePath);
    expect(prepared.leases).toMatchObject([{
      id: 'lease-git',
      writeScope: ['src'],
      fencingToken: 1,
    }]);
    expect(git.prepareTask).toHaveBeenCalledWith(missionWorkspace, 'task-1');
  });

  it('keeps read-only work on the configured Workspace without acquiring or preparing writes', async () => {
    const root = await temporaryWorkspace();
    const git = new FakeGitIsolation();
    const leaseManager = new WorkspaceLeaseManager({
      clock: () => NOW,
      idFactory: () => 'must-not-be-used',
    });
    const preparer = new V3RepositoryWorkspacePreparer({
      workRepository: new FakeWorkRepository({ 'work-1': emptyProjection() }),
      leaseManager,
      gitIsolation: git,
      clock: () => NOW,
    });

    const prepared = await preparer.prepare(prepareInput(root, {
      task: { ...task(), readOnly: true, writeScope: [] },
    }));

    expect(prepared).toEqual({
      workspaceExecution: { mode: 'none' },
      workspaceRoot: path.resolve(root),
      leases: [],
    });
    expect(leaseManager.list()).toEqual([]);
    expect(git.prepareMission).not.toHaveBeenCalled();
  });
});

async function temporaryWorkspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-workspace-'));
  temporaryRoots.push(root);
  return root;
}

function prepareInput(
  root: string,
  overrides: {
    task?: Task;
    run?: Run;
  } = {},
) {
  const taskValue = overrides.task ?? task();
  const runValue = overrides.run ?? run();
  return {
    company: company(root),
    work: work(),
    mission: mission(),
    task: taskValue,
    run: runValue,
    agent: agent(),
    recovering: false,
    activeLeases: [] as WorkspaceLeaseRecord[],
  };
}

function company(root: string): CompanyProjection {
  return {
    company: {
      id: 'company-1',
      name: 'AnoClaw',
      mainAgentId: 'agent-main',
      rootTeamId: 'team-1',
      defaultLocale: 'en-US',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    },
    workspaces: {
      'workspace-1': {
        id: 'workspace-1',
        companyId: 'company-1',
        name: 'Workspace',
        rootPath: root,
        createdAt: '2026-07-25T00:00:00.000Z',
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
    },
    teams: {},
    memberships: {},
    agents: {},
    revision: 1,
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function work(): Work {
  return {
    id: 'work-1',
    companyId: 'company-1',
    workspaceId: 'workspace-1',
    primarySessionId: 'session-primary',
    title: 'Work',
    objective: 'Ship',
    status: 'active',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function mission(): Mission {
  return {
    id: 'mission-1',
    workId: 'work-1',
    title: 'Mission',
    objective: 'Deliver',
    acceptanceCriteria: ['Done'],
    priority: 'normal',
    verificationPolicy: {
      mode: 'automatic',
      requireDifferentAgent: false,
      maxRevisionAttempts: 2,
      requiredEvidence: [],
    },
    status: 'active',
    teamId: 'team-1',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function task(): Task {
  return {
    id: 'task-1',
    workId: 'work-1',
    missionId: 'mission-1',
    title: 'Task',
    acceptanceCriteria: ['Done'],
    status: 'claimed',
    priority: 'normal',
    teamId: 'team-1',
    assignedAgentId: 'agent-1',
    dependsOnTaskIds: [],
    readOnly: false,
    writeScope: ['src'],
    version: 1,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function run(): Run {
  return {
    id: 'run-1',
    workId: 'work-1',
    missionId: 'mission-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    sessionId: 'session-run-1',
    status: 'queued',
    attempt: 1,
    maxTurns: 8,
    turnsConsumed: 0,
    fencingToken: 1,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    cost: { currency: 'USD', amount: 0, estimated: true },
    toolCount: 0,
    workspaceExecution: { mode: 'none' },
    createdAt: '2026-07-25T00:00:00.000Z',
  };
}

function agent(): Agent {
  return {
    id: 'agent-1',
    companyId: 'company-1',
    name: 'Worker',
    status: 'active',
    capabilities: [],
    enabledSkills: [],
    allowedTools: ['Read', 'Write'],
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function emptyProjection(): WorkProjection {
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
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function projectionWithLease(
  lease: WorkspaceLeaseRecord,
  runValue: Run = {
    ...run(),
    id: lease.ownerRunId,
    workId: lease.workId,
    taskId: lease.ownerTaskId,
  },
): WorkProjection {
  const projection = emptyProjection();
  projection.workspaceLeases[lease.id] = lease;
  projection.runs[runValue.id] = runValue;
  return projection;
}

function activeLease(
  overrides: Partial<WorkspaceLeaseRecord> = {},
): WorkspaceLeaseRecord {
  return {
    id: 'lease-1',
    workId: 'work-1',
    workspaceId: 'workspace-1',
    writeScope: ['src'],
    ownerRunId: 'run-1',
    ownerTaskId: 'task-1',
    ownerAgentId: 'agent-1',
    fencingToken: 1,
    status: 'active',
    acquiredAt: '2026-07-25T00:00:00.000Z',
    expiresAt: '2026-07-25T00:01:00.000Z',
    ...overrides,
  };
}

function persistentLease(
  lease: {
    id: string;
    workspaceId: string;
    writeScope: string[];
    fencingToken: number;
    expiresAt: string;
  } | undefined,
  input: ReturnType<typeof prepareInput>,
): WorkspaceLeaseRecord {
  if (!lease) throw new Error('lease missing');
  return activeLease({
    ...lease,
    workId: input.work.id,
    ownerRunId: input.run.id,
    ownerTaskId: input.task.id,
    ownerAgentId: input.agent.id,
    acquiredAt: '2026-07-25T00:00:00.000Z',
  });
}
