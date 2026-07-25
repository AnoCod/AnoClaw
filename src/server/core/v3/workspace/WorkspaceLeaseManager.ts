import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

export interface WorkspaceLease {
  id: string;
  workspaceId: string;
  workId: string;
  missionId: string;
  taskId: string;
  runId: string;
  fencingToken: number;
  writeScope: string[];
  acquiredAt: string;
  expiresAt: string;
}

export interface WorkspaceLeaseRequest {
  workspaceId: string;
  workId: string;
  missionId: string;
  taskId: string;
  runId: string;
  fencingToken: number;
  writeScope: readonly string[];
  ttlMs: number;
}

export type WorkspaceLeaseAcquireResult =
  | { acquired: true; lease: WorkspaceLease }
  | {
      acquired: false;
      conflict: {
        holder: WorkspaceLease;
        requestedScope: string;
        heldScope: string;
      };
    };

export type WorkspaceWriteDecision =
  | { allowed: true; relativePath: string; lease: WorkspaceLease }
  | {
      allowed: false;
      code: 'lease_missing' | 'scope_violation' | 'stale_fencing_token';
      message: string;
    };

export interface WorkspaceLeaseManagerOptions {
  clock?: () => number;
  idFactory?: () => string;
}

/**
 * Pessimistic write leases for non-Git workspaces and integration operations.
 *
 * Equal paths and ancestor/descendant paths conflict. Every write is checked
 * against both the lease and its Run fencing token so a recovered stale Run
 * cannot continue mutating files after ownership changed.
 */
export class WorkspaceLeaseManager {
  private readonly leases = new Map<string, WorkspaceLease>();
  private readonly clock: () => number;
  private readonly idFactory: () => string;

  constructor(options: WorkspaceLeaseManagerOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  restore(leases: readonly WorkspaceLease[]): void {
    this.leases.clear();
    for (const lease of leases) {
      this.leases.set(lease.id, {
        ...lease,
        writeScope: normalizeWriteScope(lease.writeScope),
      });
    }
    this.expire();
  }

  acquire(request: WorkspaceLeaseRequest): WorkspaceLeaseAcquireResult {
    assertPositiveTtl(request.ttlMs);
    this.expire();
    const requestedScope = normalizeWriteScope(request.writeScope);
    for (const holder of this.leases.values()) {
      if (holder.workspaceId !== request.workspaceId || holder.runId === request.runId) {
        continue;
      }
      for (const requested of requestedScope) {
        const held = holder.writeScope.find((scope) => scopesConflict(scope, requested));
        if (held) {
          return {
            acquired: false,
            conflict: {
              holder: cloneLease(holder),
              requestedScope: requested,
              heldScope: held,
            },
          };
        }
      }
    }

    const acquiredAtMs = this.clock();
    const lease: WorkspaceLease = {
      id: this.idFactory(),
      workspaceId: request.workspaceId,
      workId: request.workId,
      missionId: request.missionId,
      taskId: request.taskId,
      runId: request.runId,
      fencingToken: request.fencingToken,
      writeScope: requestedScope,
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      expiresAt: new Date(acquiredAtMs + request.ttlMs).toISOString(),
    };
    this.leases.set(lease.id, lease);
    return { acquired: true, lease: cloneLease(lease) };
  }

  renew(
    leaseId: string,
    fencingToken: number,
    ttlMs: number,
  ): WorkspaceLease | null {
    assertPositiveTtl(ttlMs);
    this.expire();
    const lease = this.leases.get(leaseId);
    if (!lease || lease.fencingToken !== fencingToken) return null;
    lease.expiresAt = new Date(this.clock() + ttlMs).toISOString();
    return cloneLease(lease);
  }

  releaseRun(runId: string, fencingToken?: number): WorkspaceLease[] {
    const released: WorkspaceLease[] = [];
    for (const [leaseId, lease] of this.leases) {
      if (
        lease.runId !== runId
        || (fencingToken != null && lease.fencingToken !== fencingToken)
      ) {
        continue;
      }
      this.leases.delete(leaseId);
      released.push(cloneLease(lease));
    }
    return released;
  }

  validateWrite(input: {
    workspaceId: string;
    runId: string;
    fencingToken: number;
    relativePath: string;
  }): WorkspaceWriteDecision {
    this.expire();
    const runLeases = [...this.leases.values()].filter(
      (lease) => lease.workspaceId === input.workspaceId && lease.runId === input.runId,
    );
    if (runLeases.length === 0) {
      return {
        allowed: false,
        code: 'lease_missing',
        message: 'The active Run does not own a workspace write lease.',
      };
    }
    if (!runLeases.some((lease) => lease.fencingToken === input.fencingToken)) {
      return {
        allowed: false,
        code: 'stale_fencing_token',
        message: 'The Run fencing token no longer owns this workspace.',
      };
    }
    const relativePath = normalizeRelativePath(input.relativePath);
    const lease = runLeases.find(
      (candidate) => candidate.fencingToken === input.fencingToken
        && candidate.writeScope.some((scope) => scopeCovers(scope, relativePath)),
    );
    if (!lease) {
      return {
        allowed: false,
        code: 'scope_violation',
        message: `Write target is outside the declared task scope: ${relativePath}`,
      };
    }
    return {
      allowed: true,
      relativePath,
      lease: cloneLease(lease),
    };
  }

  list(workspaceId?: string): WorkspaceLease[] {
    this.expire();
    return [...this.leases.values()]
      .filter((lease) => workspaceId == null || lease.workspaceId === workspaceId)
      .map(cloneLease)
      .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt));
  }

  expire(): WorkspaceLease[] {
    const now = this.clock();
    const expired: WorkspaceLease[] = [];
    for (const [leaseId, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) > now) continue;
      this.leases.delete(leaseId);
      expired.push(cloneLease(lease));
    }
    return expired;
  }
}

export function normalizeWriteScope(scopes: readonly string[]): string[] {
  const normalized = scopes.length > 0
    ? scopes.map(normalizeRelativePath)
    : ['.'];
  if (normalized.includes('.')) return ['.'];
  return [...new Set(normalized)]
    .filter((scope, _, all) => !all.some(
      (candidate) => candidate !== scope && scopeCovers(candidate, scope),
    ))
    .sort();
}

export function scopesConflict(left: string, right: string): boolean {
  return scopeCovers(left, right) || scopeCovers(right, left);
}

function scopeCovers(scope: string, candidate: string): boolean {
  return scope === '.'
    || candidate === scope
    || candidate.startsWith(`${scope}/`);
}

function normalizeRelativePath(value: string): string {
  const unixValue = value.trim().replace(/\\/g, '/');
  if (!unixValue || unixValue === '.') return '.';
  if (
    path.posix.isAbsolute(unixValue)
    || /^[A-Za-z]:\//.test(unixValue)
    || unixValue.startsWith('//')
  ) {
    throw new Error(`Workspace scope must be relative: ${value}`);
  }
  const normalized = path.posix.normalize(unixValue).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Workspace scope escapes the workspace: ${value}`);
  }
  return normalized || '.';
}

function assertPositiveTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Workspace lease ttlMs must be a positive integer.');
  }
}

function cloneLease(lease: WorkspaceLease): WorkspaceLease {
  return { ...lease, writeScope: [...lease.writeScope] };
}
