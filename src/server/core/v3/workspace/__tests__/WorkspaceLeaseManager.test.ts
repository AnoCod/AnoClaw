import { describe, expect, it } from 'vitest';
import {
  WorkspaceLeaseManager,
  normalizeWriteScope,
} from '../WorkspaceLeaseManager.js';

describe('WorkspaceLeaseManager', () => {
  it('normalizes scopes and removes descendants covered by ancestors', () => {
    expect(normalizeWriteScope(['src/app', 'src', './docs\\guide'])).toEqual([
      'docs/guide',
      'src',
    ]);
    expect(normalizeWriteScope([])).toEqual(['.']);
  });

  it('blocks ancestor and descendant conflicts but permits disjoint paths', () => {
    let now = 1_000;
    let nextId = 0;
    const manager = new WorkspaceLeaseManager({
      clock: () => now,
      idFactory: () => `lease-${++nextId}`,
    });
    const first = manager.acquire(request({
      runId: 'run-a',
      fencingToken: 1,
      writeScope: ['src/features'],
    }));
    expect(first.acquired).toBe(true);
    expect(manager.acquire(request({
      runId: 'run-b',
      taskId: 'task-b',
      fencingToken: 2,
      writeScope: ['src/features/chat'],
    }))).toMatchObject({
      acquired: false,
      conflict: {
        requestedScope: 'src/features/chat',
        heldScope: 'src/features',
      },
    });
    expect(manager.acquire(request({
      runId: 'run-c',
      taskId: 'task-c',
      fencingToken: 3,
      writeScope: ['docs'],
    }))).toMatchObject({ acquired: true });
    now += 31_000;
    expect(manager.expire()).toHaveLength(2);
  });

  it('requires the current fencing token and declared path scope for writes', () => {
    const manager = new WorkspaceLeaseManager({
      clock: () => 1_000,
      idFactory: () => 'lease-a',
    });
    manager.acquire(request({
      runId: 'run-a',
      fencingToken: 1,
      writeScope: ['src'],
    }));
    expect(manager.validateWrite({
      workspaceId: 'workspace-a',
      runId: 'run-a',
      fencingToken: 0,
      relativePath: 'src/index.ts',
    })).toMatchObject({
      allowed: false,
      code: 'stale_fencing_token',
    });
    expect(manager.validateWrite({
      workspaceId: 'workspace-a',
      runId: 'run-a',
      fencingToken: 1,
      relativePath: 'docs/guide.md',
    })).toMatchObject({
      allowed: false,
      code: 'scope_violation',
    });
    expect(manager.validateWrite({
      workspaceId: 'workspace-a',
      runId: 'run-a',
      fencingToken: 1,
      relativePath: 'src/index.ts',
    })).toMatchObject({
      allowed: true,
      relativePath: 'src/index.ts',
    });
  });

  it('does not release a recovered Run lease with a stale fencing token', () => {
    const manager = new WorkspaceLeaseManager({
      clock: () => 1_000,
      idFactory: () => 'lease-a',
    });
    manager.acquire(request({
      runId: 'run-a',
      fencingToken: 1,
      writeScope: ['.'],
    }));
    expect(manager.releaseRun('run-a', 0)).toEqual([]);
    expect(manager.list()).toHaveLength(1);
    expect(manager.releaseRun('run-a', 1)).toHaveLength(1);
    expect(manager.list()).toEqual([]);
  });
});

function request(overrides: Partial<{
  workspaceId: string;
  workId: string;
  missionId: string;
  taskId: string;
  runId: string;
  fencingToken: number;
  writeScope: string[];
  ttlMs: number;
}> = {}) {
  return {
    workspaceId: 'workspace-a',
    workId: 'work-a',
    missionId: 'mission-a',
    taskId: 'task-a',
    runId: 'run-a',
    fencingToken: 1,
    writeScope: ['src'],
    ttlMs: 30_000,
    ...overrides,
  };
}
