import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceLease } from '../../../shared/types/coordination.js';

export interface LeaseRequest {
  rootSessionId: string;
  taskId: string;
  agentId: string;
  workspace: string;
  scopes: string[];
  ttlMs: number;
}

export interface LeaseConflict {
  requestedScopes: string[];
  holder: WorkspaceLease;
}

export class WorkspaceLeaseService {
  private static instance: WorkspaceLeaseService | null = null;

  static getInstance(): WorkspaceLeaseService {
    if (!this.instance) this.instance = new WorkspaceLeaseService();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  private readonly leases = new Map<string, WorkspaceLease>();

  private constructor() {}

  clear(): void {
    this.leases.clear();
  }

  restore(leases: WorkspaceLease[]): void {
    for (const lease of leases) {
      if (Date.parse(lease.expiresAt) > Date.now()) {
        this.leases.set(lease.id, { ...lease, scopes: [...lease.scopes] });
      }
    }
  }

  acquire(request: LeaseRequest): { lease?: WorkspaceLease; conflict?: LeaseConflict } {
    this.reapExpired();
    const scopes = normalizeScopes(request.scopes);
    const conflict = this.findConflict(request.rootSessionId, request.taskId, request.workspace, scopes);
    if (conflict) return { conflict: { requestedScopes: scopes, holder: conflict } };

    const now = new Date();
    const lease: WorkspaceLease = {
      id: `lease-${randomUUID()}`,
      rootSessionId: request.rootSessionId,
      taskId: request.taskId,
      agentId: request.agentId,
      workspace: path.resolve(request.workspace),
      scopes,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.ttlMs).toISOString(),
    };
    this.leases.set(lease.id, lease);
    return { lease: { ...lease, scopes: [...lease.scopes] } };
  }

  renew(leaseId: string, ttlMs: number): WorkspaceLease | null {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    lease.expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return { ...lease, scopes: [...lease.scopes] };
  }

  release(leaseId: string): WorkspaceLease | null {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    this.leases.delete(leaseId);
    return { ...lease, scopes: [...lease.scopes] };
  }

  releaseTask(taskId: string): WorkspaceLease[] {
    const released: WorkspaceLease[] = [];
    for (const [id, lease] of this.leases) {
      if (lease.taskId !== taskId) continue;
      this.leases.delete(id);
      released.push({ ...lease, scopes: [...lease.scopes] });
    }
    return released;
  }

  getForTask(taskId: string): WorkspaceLease[] {
    this.reapExpired();
    return [...this.leases.values()]
      .filter((lease) => lease.taskId === taskId)
      .map((lease) => ({ ...lease, scopes: [...lease.scopes] }));
  }

  list(rootSessionId?: string): WorkspaceLease[] {
    this.reapExpired();
    return [...this.leases.values()]
      .filter((lease) => !rootSessionId || lease.rootSessionId === rootSessionId)
      .map((lease) => ({ ...lease, scopes: [...lease.scopes] }));
  }

  isPathCovered(lease: WorkspaceLease, candidate: string): boolean {
    const rawRelative = path.relative(lease.workspace, path.resolve(candidate));
    if (
      rawRelative === '..'
      || rawRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(rawRelative)
    ) return false;
    const relative = normalizeScope(rawRelative || '.');
    return lease.scopes.some((scope) => pathWithinScope(scope, relative));
  }

  findConflict(
    rootSessionId: string,
    taskId: string,
    workspace: string,
    scopes: string[],
  ): WorkspaceLease | undefined {
    this.reapExpired();
    void rootSessionId;
    const workspaceKey = normalizeCase(path.resolve(workspace));
    for (const lease of this.leases.values()) {
      if (lease.taskId === taskId) continue;
      if (normalizeCase(path.resolve(lease.workspace)) !== workspaceKey) continue;
      if (lease.scopes.some((held) => scopes.some((wanted) => pathPrefixesOverlap(held, wanted)))) {
        return { ...lease, scopes: [...lease.scopes] };
      }
    }
    return undefined;
  }

  private reapExpired(): void {
    const now = Date.now();
    for (const [id, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) <= now) this.leases.delete(id);
    }
  }
}

export function normalizeScopes(scopes: string[]): string[] {
  const normalized = [...new Set((scopes.length ? scopes : ['.']).map(normalizeScope))];
  if (normalized.includes('.')) return ['.'];
  return normalized.sort();
}

export function normalizeScope(scope: string): string {
  const normalized = path.normalize(scope.trim() || '.').replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`writeScope must be workspace-relative: ${scope}`);
  }
  const clean = normalized.replace(/^\.\/+/, '').replace(/\/+$/, '');
  return clean || '.';
}

export function pathPrefixesOverlap(left: string, right: string): boolean {
  const a = normalizeCase(normalizeScope(left));
  const b = normalizeCase(normalizeScope(right));
  if (a === '.' || b === '.') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** True when candidate equals scope or is a descendant of scope. */
export function pathWithinScope(scope: string, candidate: string): boolean {
  const normalizedScope = normalizeCase(normalizeScope(scope));
  const normalizedCandidate = normalizeCase(normalizeScope(candidate));
  return normalizedScope === '.'
    || normalizedCandidate === normalizedScope
    || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function normalizeCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
