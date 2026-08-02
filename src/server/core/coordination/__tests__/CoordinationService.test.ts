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
import {
  InterruptController,
  InterruptReason,
} from '../../agent/supervision/InterruptController.js';

describe('CoordinationService', () => {
  let dir = '';
  let service: CoordinationService;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-coordination-'));
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    (InterruptController as any)._instance = null;
    service = CoordinationService.getInstance();
    await service.initialize(dir);
  });

  afterEach(async () => {
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    (InterruptController as any)._instance = null;
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

  it('bounds direct children to the owned parent lifetime and requires the exact delivered final result', async () => {
    const historical = await service.createTask({
      rootSessionId: 'root-1',
      sourceSessionId: 'manager-session',
      mode: 'subagent',
      subject: 'Historical child',
      description: 'Predates the current parent task lifetime.',
      acceptanceCriteria: ['Ignored by the new parent'],
      creatorAgentId: 'manager',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const parent = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Current parent',
      description: 'Own only children created during this execution lifetime.',
      acceptanceCriteria: ['Only current children are included'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'manager',
      readOnly: true,
    });
    const claimedParent = await service.claimTask('root-1', parent.id, 'manager', parent.version);
    const runningParent = await service.updateTask('root-1', parent.id, {
      status: 'running',
      sessionId: 'manager-session',
    }, 'manager', claimedParent.version);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const child = await service.createTask({
      rootSessionId: 'root-1',
      sourceSessionId: 'manager-session',
      mode: 'subagent',
      subject: 'Current child',
      description: 'Belongs to the current parent execution.',
      acceptanceCriteria: ['Final result becomes consumable'],
      creatorAgentId: 'manager',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    await service.createTask({
      rootSessionId: 'root-1',
      sourceSessionId: 'manager-session',
      mode: 'subagent',
      subject: 'Wrong creator',
      description: 'Shares a session id but not the owning parent agent.',
      acceptanceCriteria: ['Excluded'],
      creatorAgentId: 'other-manager',
      assigneeAgentId: 'worker',
      readOnly: true,
    });

    expect(service.listDirectChildTasks(runningParent).map((task) => task.id)).toEqual([child.id]);
    expect(service.listDirectChildTasks({
      ...runningParent,
      attempt: 0,
    })).toEqual([]);
    expect(service.listDirectChildTasks(runningParent).some((task) => task.id === historical.id)).toBe(false);

    const claimedChild = await service.claimTask('root-1', child.id, 'worker', child.version);
    const runningChild = await service.updateTask('root-1', child.id, {
      status: 'running',
      sessionId: 'worker-session',
    }, 'worker', claimedChild.version);
    const completedChild = await service.updateTask('root-1', child.id, {
      status: 'completed',
      resultSummary: 'Current child result',
    }, 'worker', runningChild.version);
    expect(service.hasConsumableTaskResult(completedChild)).toBe(false);

    const queued = await service.queueMessage({
      rootSessionId: 'root-1',
      taskId: child.id,
      fromAgentId: 'worker',
      toAgentId: 'manager',
      kind: 'task_result',
      summary: `${child.subject}: completed`,
      content: completedChild.resultSummary!,
    });
    expect(service.hasConsumableTaskResult(completedChild)).toBe(false);
    await service.updateMessageStatus('root-1', queued.id, 'delivered', 'manager');
    expect(service.hasConsumableTaskResult(completedChild)).toBe(true);
  });

  it.each([
    ['worker', InterruptReason.TaskSelfCancel],
    ['ceo', InterruptReason.TaskCreatorCancel],
    ['team-leader', InterruptReason.TaskCoordinatorCancel],
  ])('attributes cancellation by %s without degrading it to ParentStop', async (actor, expectedReason) => {
    const created = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: `Cancellation by ${actor}`,
      description: 'Exercise cancellation attribution',
      acceptanceCriteria: ['The precise cancellation reason is retained'],
      creatorAgentId: 'ceo',
      assigneeAgentId: 'worker',
      readOnly: true,
    });
    const claimed = await service.claimTask('root-1', created.id, 'worker', created.version);
    const sessionId = `session-${actor}`;
    const running = await service.updateTask('root-1', created.id, {
      status: 'running',
      sessionId,
    }, 'worker', claimed.version);
    const interrupts = InterruptController.getInstance();
    interrupts.createController(sessionId);

    const cancelled = await service.requestTaskCancellation(
      'root-1',
      running.id,
      actor,
      `Cancelled by ${actor}`,
    );
    // Legacy callers used to send this immediately after the state change.
    // The first, precise cancellation reason must remain authoritative.
    interrupts.requestInterruptWhenAvailable(sessionId, InterruptReason.ParentStop);

    expect(cancelled.blocker).toBe('cancellation_requested');
    expect(interrupts.reason(sessionId)).toBe(expectedReason);
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
