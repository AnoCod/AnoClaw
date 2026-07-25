import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CompanyProjection,
  Run,
  WorkProjection,
  WorkspaceExecution,
  WorkspaceLeaseRecord,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import type { WorkRepository } from '../store/WorkRepository.js';
import type {
  PreparedV3Workspace,
  V3WorkspacePreparer,
} from '../orchestration/V3RunExecutor.js';
import {
  GitWorkspaceIsolationService,
  type MissionWorkspace,
  type PreparedMissionWorkspace,
  type TaskWorkspace,
} from './GitWorkspaceIsolationService.js';
import {
  WorkspaceLeaseManager,
  normalizeWriteScope,
  type WorkspaceLease,
} from './WorkspaceLeaseManager.js';

const DEFAULT_LEASE_TTL_MS = 30_000;

interface WorkspaceWorkRepository {
  listWorkIds(): Promise<string[]>;
  getProjection(workId: string): Promise<WorkProjection>;
}

interface GitIsolation {
  prepareMission(input: {
    workId: string;
    missionId: string;
    workspaceRoot: string;
  }): Promise<PreparedMissionWorkspace>;
  prepareTask(
    mission: MissionWorkspace,
    taskId: string,
  ): Promise<TaskWorkspace>;
}

export interface V3RepositoryWorkspacePreparerOptions {
  workRepository: WorkspaceWorkRepository;
  leaseManager?: WorkspaceLeaseManager;
  gitIsolation?: GitIsolation;
  leaseTtlMs?: number;
  clock?: () => number;
}

interface PreparedRunState {
  prepared: PreparedV3Workspace;
  fencingToken: number;
}

/**
 * Resolves a Work's persistent Workspace and prepares one Run safely.
 *
 * The append-only WorkRepository remains the durable lease source of truth.
 * WorkspaceLeaseManager is rebuilt from all active Work streams before every
 * acquisition/renewal, while provisional acquisitions are retained until the
 * Run's execution.started event becomes durable. Git repositories additionally
 * receive task-local worktrees; pessimistic leases still fence real tool writes.
 */
export class V3RepositoryWorkspacePreparer implements V3WorkspacePreparer {
  private readonly workRepository: WorkspaceWorkRepository;
  private readonly leaseManager: WorkspaceLeaseManager;
  private readonly gitIsolation: GitIsolation;
  private readonly leaseTtlMs: number;
  private readonly clock: () => number;
  private readonly preparedRuns = new Map<string, PreparedRunState>();
  private readonly provisionalLeases = new Map<string, WorkspaceLease>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: V3RepositoryWorkspacePreparerOptions) {
    this.workRepository = options.workRepository;
    this.leaseManager = options.leaseManager ?? new WorkspaceLeaseManager({
      clock: options.clock,
    });
    this.gitIsolation = options.gitIsolation ?? new GitWorkspaceIsolationService();
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new V3DomainError(
        'INVALID_ARGUMENT',
        'Workspace lease TTL must be a positive integer.',
      );
    }
  }

  prepare(
    input: Parameters<V3WorkspacePreparer['prepare']>[0],
  ): Promise<PreparedV3Workspace> {
    return this.withLock(async () => {
      const existing = this.preparedRuns.get(input.run.id);
      if (existing) {
        if (existing.fencingToken !== input.run.fencingToken) {
          throw new V3DomainError(
            'CONFLICT',
            `Run ${input.run.id} was already prepared with another fencing token.`,
          );
        }
        const activeUntil = existing.prepared.leases
          ?.map((lease) => Date.parse(lease.expiresAt))
          .sort((left, right) => left - right)[0];
        if (activeUntil === undefined || activeUntil > this.clock()) {
          return clonePrepared(existing.prepared);
        }
        this.leaseManager.releaseRun(input.run.id, input.run.fencingToken);
        for (const [leaseId, lease] of this.provisionalLeases) {
          if (lease.runId === input.run.id) this.provisionalLeases.delete(leaseId);
        }
        this.preparedRuns.delete(input.run.id);
      }

      const workspace = resolveWorkspace(input.company, input.work.workspaceId);
      if (!workspace) {
        if (!input.task.readOnly) {
          throw new V3DomainError(
            'CONFLICT',
            `Writable Task ${input.task.id} requires a bound Workspace.`,
          );
        }
        const prepared: PreparedV3Workspace = {
          workspaceExecution: { mode: 'none' },
        };
        this.preparedRuns.set(input.run.id, {
          prepared,
          fencingToken: input.run.fencingToken,
        });
        return clonePrepared(prepared);
      }

      const workspaceRoot = await requireWorkspaceDirectory(workspace.rootPath);
      if (input.task.readOnly) {
        const prepared: PreparedV3Workspace = {
          workspaceExecution: { mode: 'none' },
          workspaceRoot,
          leases: [],
        };
        this.preparedRuns.set(input.run.id, {
          prepared,
          fencingToken: input.run.fencingToken,
        });
        return clonePrepared(prepared);
      }

      const writeScope = normalizeWriteScope(input.task.writeScope);
      await this.restoreActiveLeases(input.activeLeases);
      const acquired = this.leaseManager.acquire({
        workspaceId: workspace.id,
        workId: input.work.id,
        missionId: input.mission.id,
        taskId: input.task.id,
        runId: input.run.id,
        fencingToken: input.run.fencingToken,
        writeScope,
        ttlMs: this.leaseTtlMs,
      });
      if (!acquired.acquired) {
        throw new V3DomainError(
          'CONFLICT',
          [
            `Workspace write scope conflicts with Run ${acquired.conflict.holder.runId}.`,
            `requested=${acquired.conflict.requestedScope}`,
            `held=${acquired.conflict.heldScope}`,
          ].join(' '),
          {
            workspaceId: workspace.id,
            requestedScope: acquired.conflict.requestedScope,
            heldScope: acquired.conflict.heldScope,
            holderRunId: acquired.conflict.holder.runId,
          },
        );
      }
      this.provisionalLeases.set(acquired.lease.id, acquired.lease);

      try {
        const missionWorkspace = await this.gitIsolation.prepareMission({
          workId: input.work.id,
          missionId: input.mission.id,
          workspaceRoot,
        });
        const prepared = missionWorkspace.mode === 'git-worktree'
          ? await this.prepareGitWorkspace(
            workspace.id,
            input.run,
            input.task.id,
            missionWorkspace,
            acquired.lease,
          )
          : prepareLeaseWorkspace(
            workspace.id,
            workspaceRoot,
            acquired.lease,
          );
        this.preparedRuns.set(input.run.id, {
          prepared,
          fencingToken: input.run.fencingToken,
        });
        return clonePrepared(prepared);
      } catch (error) {
        this.leaseManager.releaseRun(input.run.id, input.run.fencingToken);
        this.provisionalLeases.delete(acquired.lease.id);
        throw error;
      }
    });
  }

  heartbeat(
    input: Parameters<NonNullable<V3WorkspacePreparer['heartbeat']>>[0],
  ): Promise<{ leaseExpiresAt?: string } | void> {
    return this.withLock(async () => {
      if (input.leases.length === 0) return {};
      await this.restoreActiveLeases(input.leases);
      const expirations: string[] = [];
      for (const record of input.leases) {
        if (
          record.status !== 'active'
          || record.ownerRunId !== input.run.id
          || record.fencingToken !== input.run.fencingToken
        ) {
          continue;
        }
        const renewed = this.leaseManager.renew(
          record.id,
          input.run.fencingToken,
          this.leaseTtlMs,
        );
        if (!renewed) {
          throw new V3DomainError(
            'CONFLICT',
            `Workspace lease ${record.id} could not be renewed.`,
          );
        }
        this.provisionalLeases.set(renewed.id, renewed);
        expirations.push(renewed.expiresAt);
      }
      if (expirations.length === 0) return {};
      expirations.sort();
      return { leaseExpiresAt: expirations[0] };
    });
  }

  release(
    input: Parameters<V3WorkspacePreparer['release']>[0],
  ): Promise<void> {
    return this.withLock(async () => {
      this.leaseManager.releaseRun(input.run.id, input.run.fencingToken);
      for (const lease of input.leases) {
        if (lease.ownerRunId === input.run.id) {
          this.provisionalLeases.delete(lease.id);
        }
      }
      for (const [leaseId, lease] of this.provisionalLeases) {
        if (lease.runId === input.run.id) this.provisionalLeases.delete(leaseId);
      }
      this.preparedRuns.delete(input.run.id);
    });
  }

  private async prepareGitWorkspace(
    workspaceId: string,
    run: Run,
    taskId: string,
    missionWorkspace: MissionWorkspace,
    lease: WorkspaceLease,
  ): Promise<PreparedV3Workspace> {
    const taskWorkspace = await this.gitIsolation.prepareTask(
      missionWorkspace,
      taskId,
    );
    return {
      workspaceExecution: {
        mode: 'git_worktree',
        workspaceId,
        integrationBranch: missionWorkspace.integrationBranch,
        taskBranch: taskWorkspace.branch,
        worktreePath: taskWorkspace.worktreePath,
        baselineHead: missionWorkspace.baselineHead,
      },
      workspaceRoot: taskWorkspace.worktreePath,
      leases: [persistentLeaseDraft(lease)],
    };
  }

  private async restoreActiveLeases(
    supplied: readonly WorkspaceLeaseRecord[],
  ): Promise<void> {
    const restored = new Map<string, WorkspaceLease>();
    const workIds = await this.workRepository.listWorkIds();
    for (const workId of workIds) {
      const projection = await this.workRepository.getProjection(workId);
      addProjectionLeases(restored, projection);
    }
    for (const record of supplied) {
      const projection = workIds.includes(record.workId)
        ? undefined
        : await this.workRepository.getProjection(record.workId).catch(() => undefined);
      const missionId = projection?.runs[record.ownerRunId]?.missionId ?? 'unknown-mission';
      if (record.status === 'active') {
        restored.set(record.id, runtimeLease(record, missionId));
      }
    }
    for (const lease of this.provisionalLeases.values()) {
      restored.set(lease.id, cloneRuntimeLease(lease));
    }
    this.leaseManager.restore([...restored.values()]);

    const now = this.clock();
    for (const [leaseId, lease] of this.provisionalLeases) {
      if (Date.parse(lease.expiresAt) <= now) this.provisionalLeases.delete(leaseId);
    }
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function resolveWorkspace(
  company: CompanyProjection,
  workspaceId: string | undefined,
) {
  if (!workspaceId) return undefined;
  const workspace = company.workspaces[workspaceId];
  if (!workspace || workspace.archivedAt) {
    throw new V3DomainError('NOT_FOUND', `Workspace not found: ${workspaceId}`);
  }
  if (company.company && workspace.companyId !== company.company.id) {
    throw new V3DomainError('NOT_FOUND', `Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

async function requireWorkspaceDirectory(rootPath: string): Promise<string> {
  const resolved = path.resolve(rootPath);
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw new V3DomainError(
      'NOT_FOUND',
      `Workspace root does not exist: ${resolved}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new V3DomainError(
      'INVALID_ARGUMENT',
      `Workspace root is not a directory: ${resolved}`,
    );
  }
  return resolved;
}

function prepareLeaseWorkspace(
  workspaceId: string,
  workspaceRoot: string,
  lease: WorkspaceLease,
): PreparedV3Workspace {
  return {
    workspaceExecution: {
      mode: 'lease',
      workspaceId,
      leaseIds: [lease.id],
      writeScope: [...lease.writeScope],
    },
    workspaceRoot,
    leases: [persistentLeaseDraft(lease)],
  };
}

function persistentLeaseDraft(
  lease: WorkspaceLease,
): NonNullable<PreparedV3Workspace['leases']>[number] {
  return {
    id: lease.id,
    workspaceId: lease.workspaceId,
    writeScope: [...lease.writeScope],
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt,
  };
}

function addProjectionLeases(
  output: Map<string, WorkspaceLease>,
  projection: WorkProjection,
): void {
  for (const record of Object.values(projection.workspaceLeases)) {
    if (record.status !== 'active') continue;
    const run = projection.runs[record.ownerRunId];
    if (!run) continue;
    output.set(record.id, runtimeLease(record, run.missionId));
  }
}

function runtimeLease(
  record: WorkspaceLeaseRecord,
  missionId: string,
): WorkspaceLease {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    workId: record.workId,
    missionId,
    taskId: record.ownerTaskId,
    runId: record.ownerRunId,
    fencingToken: record.fencingToken,
    writeScope: [...record.writeScope],
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
  };
}

function cloneRuntimeLease(lease: WorkspaceLease): WorkspaceLease {
  return { ...lease, writeScope: [...lease.writeScope] };
}

function clonePrepared(prepared: PreparedV3Workspace): PreparedV3Workspace {
  return {
    workspaceExecution: cloneExecution(prepared.workspaceExecution),
    ...(prepared.workspaceRoot ? { workspaceRoot: prepared.workspaceRoot } : {}),
    ...(prepared.leases
      ? {
        leases: prepared.leases.map((lease) => ({
          ...lease,
          writeScope: [...lease.writeScope],
        })),
      }
      : {}),
  };
}

function cloneExecution(execution: WorkspaceExecution): WorkspaceExecution {
  if (execution.mode === 'lease') {
    return {
      ...execution,
      leaseIds: [...execution.leaseIds],
      writeScope: [...execution.writeScope],
    };
  }
  return { ...execution };
}
