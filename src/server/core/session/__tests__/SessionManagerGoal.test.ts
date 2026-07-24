import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../SessionManager.js';
import { SessionStore } from '../SessionStore.js';
import { isGoalTransitionAllowed } from '../SessionManager.js';

describe('SessionManager goal context', () => {
  let tmpDir = '';
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-goal-'));
    (SessionManager as any)._instance = undefined;
    (SessionStore as any)._instance = undefined;
    manager = SessionManager.getInstance();
    await manager.initialize(path.join(tmpDir, 'sessions'));
  });

  afterEach(async () => {
    if (tmpDir && path.basename(tmpDir).startsWith('anoclaw-goal-')) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('records each active goal run with workspace and mode context', async () => {
    const workspaceA = path.join(tmpDir, 'workspace-a');
    const workspaceB = path.join(tmpDir, 'workspace-b');
    const session = await manager.createMainSession('agent-main', 'Goal Session', workspaceA);

    await manager.setSessionPermissionMode(session.id, 'Plan');
    await manager.setSessionEffortMode(session.id, false);

    const started = await manager.setGoal(session.id, '强化 workspace 和 goal mode');
    expect(started.runCount).toBe(0);

    const firstRun = await manager.touchGoalRun(session.id, { userMode: 'coding' });
    expect(firstRun?.runCount).toBe(1);
    expect(firstRun?.lastWorkspace).toBe(workspaceA);
    expect(firstRun?.lastPermissionMode).toBe('AutoEdit');
    expect(firstRun?.lastEffort).toBe('NORMAL');
    expect(firstRun?.lastUserMode).toBe('coding');

    await manager.setWorkspace(session.id, workspaceB);
    const secondRun = await manager.touchGoalRun(session.id, {
      permissionMode: 'AutoEdit',
      effort: 'HIGH',
      userMode: 'office',
    });

    expect(secondRun?.runCount).toBe(2);
    // Goal v2 pins the execution contract to the workspace captured at creation.
    expect(secondRun?.lastWorkspace).toBe(workspaceA);
    expect(secondRun?.lastPermissionMode).toBe('AutoEdit');
    expect(secondRun?.lastEffort).toBe('HIGH');
    expect(secondRun?.lastUserMode).toBe('office');

    const meta = JSON.parse(
      await fsp.readFile(path.join(tmpDir, 'sessions', session.id, 'meta.json'), 'utf-8'),
    ) as { metadata: { goal: Record<string, unknown> } };
    expect(meta.metadata.goal.runCount).toBe(2);
    expect(meta.metadata.goal.lastWorkspace).toBe(workspaceA);
    expect(meta.metadata.goal.lastPermissionMode).toBe('AutoEdit');
  });

  it('persists the execution contract and enters review after a structured report', async () => {
    const workspace = path.join(tmpDir, 'workspace-contract');
    const session = await manager.createMainSession('agent-main', 'Contract Goal', workspace);
    const started = await manager.setGoal(session.id, {
      objective: '完成可验证交付物',
      acceptanceCriteria: '报告存在且测试通过',
      workspace,
      permissionMode: 'AutoEdit',
      maxRuns: 8,
      maxConsecutiveFailures: 2,
      wakeIntervalMs: 5000,
    });

    expect(started.goalId).toBeTruthy();
    expect(started.status).toBe('active');
    expect(started.maxRuns).toBe(8);
    expect(started.acceptanceCriteria).toBe('报告存在且测试通过');

    const running = await manager.beginGoalRun(session.id);
    expect(running?.currentRunId).toBeTruthy();
    const reviewed = await manager.reportGoalRun(session.id, {
      runId: running!.currentRunId!,
      outcome: 'waiting_review',
      summary: '已完成报告并通过测试',
      progress: 100,
      evidence: [{ type: 'file', label: '结果报告', path: 'reports/result.md' }],
    });

    expect(reviewed?.status).toBe('waiting_review');
    expect(reviewed?.progress).toBe(100);
    expect(reviewed?.evidence?.[0]?.path).toBe('reports/result.md');
    expect(reviewed?.currentRunId).toBeUndefined();

    const persisted = JSON.parse(
      await fsp.readFile(path.join(tmpDir, 'sessions', session.id, 'meta.json'), 'utf-8'),
    ) as { metadata: { goal: { status: string; lastSummary: string } } };
    expect(persisted.metadata.goal.status).toBe('waiting_review');
    expect(persisted.metadata.goal.lastSummary).toContain('通过测试');
  });

  it('stops before starting a run after the configured run budget is exhausted', async () => {
    const session = await manager.createMainSession('agent-main', 'Budget Goal', tmpDir);
    await manager.setGoal(session.id, { objective: '有限运行', maxRuns: 1 });

    const first = await manager.beginGoalRun(session.id);
    expect(first?.status).toBe('active');
    await manager.reportGoalRun(session.id, {
      runId: first!.currentRunId!,
      outcome: 'progress',
      summary: '完成第一步',
      nextStep: '继续',
    });

    const exhausted = await manager.beginGoalRun(session.id);
    expect(exhausted?.status).toBe('budget_exhausted');
    expect(exhausted?.statusReason).toContain('1');
  });

  it('backs off transient failures and stops at the consecutive failure limit', async () => {
    const session = await manager.createMainSession('agent-main', 'Failure Goal', tmpDir);
    await manager.setGoal(session.id, {
      objective: '失败熔断',
      maxConsecutiveFailures: 2,
      wakeIntervalMs: 5000,
    });

    const first = await manager.beginGoalRun(session.id);
    const retrying = await manager.failGoalRun(session.id, 'temporary error', first!.currentRunId);
    expect(retrying?.status).toBe('active');
    expect(retrying?.consecutiveFailures).toBe(1);
    expect(retrying?.nextRunAt).toBeTruthy();

    const second = await manager.beginGoalRun(session.id);
    const failed = await manager.failGoalRun(session.id, 'still broken', second!.currentRunId);
    expect(failed?.status).toBe('failed');
    expect(failed?.consecutiveFailures).toBe(2);
    expect(failed?.nextRunAt).toBeUndefined();
  });

  it('applies the failure fuse to structured failed reports', async () => {
    const session = await manager.createMainSession('agent-main', 'Reported Failure Goal', tmpDir);
    await manager.setGoal(session.id, {
      objective: 'Retry reported failures',
      maxConsecutiveFailures: 2,
      wakeIntervalMs: 5000,
    });

    const first = await manager.beginGoalRun(session.id);
    const retrying = await manager.reportGoalRun(session.id, {
      runId: first!.currentRunId!,
      outcome: 'failed',
      summary: 'First attempt failed',
      reason: 'temporary failure',
    });
    expect(retrying?.status).toBe('active');
    expect(retrying?.consecutiveFailures).toBe(1);
    expect(retrying?.nextRunAt).toBeTruthy();

    const second = await manager.beginGoalRun(session.id);
    const failed = await manager.reportGoalRun(session.id, {
      runId: second!.currentRunId!,
      outcome: 'failed',
      summary: 'Second attempt failed',
      reason: 'persistent failure',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.consecutiveFailures).toBe(2);
  });

  it('normalizes legacy goal metadata without a manual migration', async () => {
    const session = await manager.createMainSession('agent-main', 'Legacy Goal', tmpDir);
    session.setMetadata('goal', {
      objective: '旧版目标',
      status: 'active',
      permissionMode: 'Ask',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      runCount: 2,
    });

    const migrated = manager.getGoal(session.id);
    expect(migrated?.goalId).toBeTruthy();
    expect(migrated?.maxRuns).toBeGreaterThan(2);
    expect(migrated?.permissionMode).toBe('AutoEdit');
    expect(migrated?.runCount).toBe(2);
  });

  it('keeps legacy waiting-confirmation Goals recoverable under Auto Edit', async () => {
    const session = await manager.createMainSession('agent-main', 'Legacy Approval Goal', tmpDir);
    session.setMetadata('goal', {
      objective: '恢复旧审批等待',
      status: 'waiting_confirmation',
      permissionMode: 'Plan',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      runCount: 1,
    });

    expect(manager.getGoal(session.id)).toMatchObject({
      status: 'waiting_confirmation',
      permissionMode: 'AutoEdit',
    });
    await expect(manager.updateGoalStatus(session.id, 'active')).resolves.toMatchObject({
      status: 'active',
      permissionMode: 'AutoEdit',
    });
  });

  it('records an interrupted persisted run before recovering with a new run', async () => {
    const session = await manager.createMainSession('agent-main', 'Recovery Goal', tmpDir);
    await manager.setGoal(session.id, { objective: 'Recover safely', maxConsecutiveFailures: 3 });
    const interrupted = await manager.beginGoalRun(session.id);

    const recovered = await manager.beginGoalRun(session.id);
    expect(recovered?.status).toBe('active');
    expect(recovered?.currentRunId).not.toBe(interrupted?.currentRunId);
    expect(recovered?.consecutiveFailures).toBe(1);
    expect(recovered?.recentRuns?.find(run => run.runId === interrupted?.currentRunId)?.outcome).toBe('unreported');
  });

  it('does not overwrite a user pause with run failure handling', async () => {
    const session = await manager.createMainSession('agent-main', 'Paused Goal', tmpDir);
    await manager.setGoal(session.id, 'Pause safely');
    const running = await manager.beginGoalRun(session.id);
    await manager.updateGoalStatus(session.id, 'paused', 'Paused by user');

    const afterFailure = await manager.failGoalRun(session.id, 'aborted', running!.currentRunId);
    expect(afterFailure?.status).toBe('paused');
    expect(afterFailure?.currentRunId).toBeUndefined();
    expect(afterFailure?.recentRuns?.find(run => run.runId === running!.currentRunId)?.outcome).toBe('paused');
    expect(manager.getGoal(session.id)?.status).toBe('paused');
  });

  it('closes an in-flight run when the execution contract is edited', async () => {
    const session = await manager.createMainSession('agent-main', 'Edited Goal', tmpDir);
    await manager.setGoal(session.id, { objective: 'Old outcome', acceptanceCriteria: 'Old evidence' });
    const running = await manager.beginGoalRun(session.id);

    const edited = await manager.setGoal(session.id, {
      objective: 'New outcome',
      acceptanceCriteria: 'New evidence',
      permissionMode: 'Ask',
    });

    expect(edited.currentRunId).toBeUndefined();
    expect(edited.permissionMode).toBe('AutoEdit');
    expect(edited.recentRuns?.find(run => run.runId === running?.currentRunId)?.outcome).toBe('paused');
  });

  it('keeps the active run intact when a duplicate resume arrives', async () => {
    const session = await manager.createMainSession('agent-main', 'Duplicate Resume Goal', tmpDir);
    await manager.setGoal(session.id, { objective: 'Keep the current run', acceptanceCriteria: 'run survives' });
    const running = await manager.beginGoalRun(session.id);

    const unchanged = await manager.updateGoalStatus(session.id, 'active');

    expect(unchanged?.currentRunId).toBe(running?.currentRunId);
    expect(unchanged?.runCount).toBe(1);
  });

  it('rolls back the in-memory Goal when metadata persistence fails', async () => {
    const session = await manager.createMainSession('agent-main', 'Atomic Goal', tmpDir);
    const writeSpy = vi.spyOn(SessionStore.getInstance(), 'writeSessionMeta')
      .mockRejectedValueOnce(new Error('disk unavailable'));

    await expect(manager.setGoal(session.id, { objective: 'Must be durable' })).rejects.toThrow('disk unavailable');
    expect(manager.getGoal(session.id)).toBeNull();
    writeSpy.mockRestore();
  });

  it('rejects unsafe lifecycle transitions', () => {
    expect(isGoalTransitionAllowed('active', 'waiting_review')).toBe(true);
    expect(isGoalTransitionAllowed('waiting_review', 'completed')).toBe(true);
    expect(isGoalTransitionAllowed('active', 'completed')).toBe(false);
    expect(isGoalTransitionAllowed('completed', 'waiting_review')).toBe(false);
    expect(isGoalTransitionAllowed('deleted', 'active')).toBe(false);
  });
});
