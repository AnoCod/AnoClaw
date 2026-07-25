import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationService } from '../CoordinationService.js';
import {
  WorkspaceLeaseService,
  normalizeScope,
  pathPrefixesOverlap,
  pathWithinScope,
} from '../WorkspaceLeaseService.js';

describe('CoordinationService', () => {
  let dir = '';
  let service: CoordinationService;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-coordination-'));
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
  });

  afterEach(async () => {
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('persists and restores teams, tasks, and FIFO messages', async () => {
    const team = await service.createTeam({
      rootSessionId: 'root-1',
      name: 'Delivery',
      purpose: 'Parallel delivery',
      leaderAgentId: 'ceo',
      memberAgentIds: ['worker'],
      createdByAgentId: 'ceo',
    });
    const task = await service.createTask({
      rootSessionId: 'root-1',
      teamId: team.id,
      mode: 'swarm',
      subject: 'Inspect',
      description: 'Inspect the implementation',
      acceptanceCriteria: ['Report evidence'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    await service.queueMessage({
      rootSessionId: 'root-1',
      teamId: team.id,
      taskId: task.id,
      fromAgentId: 'ceo',
      toAgentId: 'worker',
      kind: 'task_assignment',
      content: 'Begin',
    });
    await service.queueMessage({
      rootSessionId: 'root-1',
      teamId: team.id,
      taskId: task.id,
      fromAgentId: 'ceo',
      toAgentId: 'worker',
      kind: 'note',
      content: 'Check tests too',
    });

    CoordinationService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    expect(service.getActiveTeam('root-1')?.id).toBe(team.id);
    expect(service.getTask('root-1', task.id)?.subject).toBe('Inspect');
    expect(service.pendingMessages('root-1', 'worker').map((message) => message.content))
      .toEqual(['Begin', 'Check tests too']);
  });

  it('claims a task atomically', async () => {
    const team = await service.createTeam({
      rootSessionId: 'root-1',
      name: 'Delivery',
      purpose: 'Parallel delivery',
      leaderAgentId: 'ceo',
      memberAgentIds: ['a', 'b'],
      createdByAgentId: 'ceo',
    });
    const task = await service.createTask({
      rootSessionId: 'root-1',
      teamId: team.id,
      mode: 'swarm',
      subject: 'Claim me',
      description: 'Only one worker may own this',
      acceptanceCriteria: ['One owner'],
      creatorAgentId: 'ceo',
      readOnly: true,
    });

    const results = await Promise.allSettled([
      service.claimTask('root-1', task.id, 'a', 1),
      service.claimTask('root-1', task.id, 'b', 1),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('enforces one active team per root and permits teams in another root', async () => {
    await service.createTeam({
      rootSessionId: 'root-1',
      name: 'First',
      purpose: 'First root team',
      leaderAgentId: 'ceo',
      memberAgentIds: ['a'],
      createdByAgentId: 'ceo',
    });
    await expect(service.createTeam({
      rootSessionId: 'root-1',
      name: 'Second',
      purpose: 'Conflicting root team',
      leaderAgentId: 'ceo',
      memberAgentIds: ['b'],
      createdByAgentId: 'ceo',
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.createTeam({
      rootSessionId: 'root-2',
      name: 'Other root',
      purpose: 'Same employees may collaborate elsewhere',
      leaderAgentId: 'ceo',
      memberAgentIds: ['a'],
      createdByAgentId: 'ceo',
    })).resolves.toMatchObject({ rootSessionId: 'root-2', state: 'active' });
  });

  it('rejects stale versions and illegal terminal transitions', async () => {
    const task = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Versioned task',
      description: 'Exercise optimistic concurrency',
      acceptanceCriteria: ['Version conflict is detected'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    const claimed = await service.claimTask('root-1', task.id, 'worker', task.version);
    await expect(service.updateTask(
      'root-1',
      task.id,
      { progress: 10 },
      'worker',
      task.version,
    )).rejects.toMatchObject({ code: 'conflict' });
    const running = await service.updateTask(
      'root-1',
      task.id,
      { status: 'running' },
      'worker',
      claimed.version,
    );
    const completed = await service.updateTask(
      'root-1',
      task.id,
      { status: 'completed' },
      'worker',
      running.version,
    );
    await expect(service.updateTask(
      'root-1',
      task.id,
      { status: 'running' },
      'worker',
      completed.version,
    )).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('retains idempotency keys across restart', async () => {
    const input = {
      rootSessionId: 'root-1',
      mode: 'hierarchy' as const,
      subject: 'Exactly once',
      description: 'Do not create this task twice',
      acceptanceCriteria: ['One task record'],
      creatorAgentId: 'ceo',
      readOnly: true,
      idempotencyKey: 'create:exactly-once',
    };
    const first = await service.createTask(input);
    CoordinationService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    const duplicate = await service.createTask(input);
    expect(duplicate.id).toBe(first.id);
    expect(service.listTasks('root-1')).toHaveLength(1);
  });

  it('returns the original disbanded team for a retried idempotent create', async () => {
    const input = {
      rootSessionId: 'root-1',
      name: 'Idempotent team',
      purpose: 'Prove retries never create a replacement team',
      leaderAgentId: 'ceo',
      memberAgentIds: ['worker'],
      createdByAgentId: 'ceo',
      idempotencyKey: 'team:create:stable',
    };
    const first = await service.createTeam(input);
    await service.disbandTeam('root-1', first.id, 'ceo');

    CoordinationService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    const duplicate = await service.createTeam(input);

    expect(duplicate).toMatchObject({ id: first.id, state: 'disbanded' });
    expect(service.listTeams('root-1')).toHaveLength(1);
  });

  it('validates FIFO message status transitions', async () => {
    const message = await service.queueMessage({
      rootSessionId: 'root-1',
      fromAgentId: 'ceo',
      toAgentId: 'worker',
      kind: 'note',
      content: 'First',
    });
    await expect(service.updateMessageStatus(
      'root-1',
      message.id,
      'acknowledged',
      'worker',
    )).rejects.toMatchObject({ code: 'invalid_transition' });
    const delivered = await service.updateMessageStatus(
      'root-1',
      message.id,
      'delivered',
      'worker',
    );
    const acknowledged = await service.updateMessageStatus(
      'root-1',
      message.id,
      'acknowledged',
      'worker',
    );
    expect(delivered.deliveredAt).toBeTruthy();
    expect(acknowledged.acknowledgedAt).toBeTruthy();
  });

  it('does not release a dependent task before real completion', async () => {
    const first = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'First',
      description: 'Complete first',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    const second = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Second',
      description: 'Wait for first',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'worker',
      dependsOn: [first.id],
      readOnly: true,
    });

    expect(service.isTaskReady('root-1', second.id)).toBe(false);
    const claimed = await service.claimTask('root-1', first.id, 'worker');
    const running = await service.updateTask('root-1', first.id, { status: 'running' }, 'worker', claimed.version);
    expect(service.isTaskReady('root-1', second.id)).toBe(false);
    await service.updateTask('root-1', first.id, { status: 'completed' }, 'worker', running.version);
    expect(service.isTaskReady('root-1', second.id)).toBe(true);
  });

  it('resolves the active task when a stable team session has older terminal work', async () => {
    const first = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'First session task',
      description: 'Use the stable worker session first',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    const firstClaimed = await service.claimTask('root-1', first.id, 'worker');
    const firstRunning = await service.updateTask('root-1', first.id, {
      status: 'running',
      sessionId: 'stable-worker-session',
    }, 'worker', firstClaimed.version);
    await service.updateTask('root-1', first.id, {
      status: 'completed',
    }, 'worker', firstRunning.version);

    const second = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Second session task',
      description: 'Reuse the stable worker session safely',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    const secondClaimed = await service.claimTask('root-1', second.id, 'worker');
    await service.updateTask('root-1', second.id, {
      status: 'running',
      sessionId: 'stable-worker-session',
    }, 'worker', secondClaimed.version);

    expect(service.findTaskBySession('stable-worker-session', true)?.id).toBe(second.id);
  });

  it('blocks overlapping workspace scopes and allows disjoint scopes', async () => {
    const first = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'First writer',
      description: 'Write server files',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'a',
      writeScope: ['src/server'],
    });
    const second = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Second writer',
      description: 'Write nested server files',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'b',
      writeScope: ['src/server/core'],
    });
    const third = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Frontend writer',
      description: 'Write frontend files',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'c',
      writeScope: ['src/public'],
    });

    expect(await service.acquireTaskLease('root-1', first.id, dir, 30_000)).not.toBeNull();
    expect(await service.acquireTaskLease('root-1', second.id, dir, 30_000)).toBeNull();
    expect(await service.acquireTaskLease('root-1', third.id, dir, 30_000)).not.toBeNull();
  });

  it('normalizes safe relative scopes and distinguishes conflict from containment', () => {
    expect(normalizeScope('./src/server/')).toBe('src/server');
    expect(() => normalizeScope('../outside')).toThrow(/workspace-relative/);
    expect(pathPrefixesOverlap('src/server', 'src/server/core')).toBe(true);
    expect(pathWithinScope('src/server/core', 'src/server')).toBe(false);
    expect(pathWithinScope('src/server', 'src/server/core/file.ts')).toBe(true);
    expect(pathWithinScope('.', 'anything/here')).toBe(true);
  });

  it('protects the same physical workspace across different root sessions', async () => {
    const first = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Root one writer',
      description: 'Write the shared server tree',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'a',
      writeScope: ['src/server'],
    });
    const second = await service.createTask({
      rootSessionId: 'root-2',
      mode: 'hierarchy',
      subject: 'Root two writer',
      description: 'Write the same shared server tree',
      acceptanceCriteria: ['Done'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'b',
      writeScope: ['src/server/core'],
    });
    expect(await service.acquireTaskLease('root-1', first.id, dir, 30_000)).not.toBeNull();
    expect(await service.acquireTaskLease('root-2', second.id, dir, 30_000)).toBeNull();
  });
});
