import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../SessionManager.js';
import { SessionStore } from '../SessionStore.js';

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
    expect(firstRun?.lastPermissionMode).toBe('Plan');
    expect(firstRun?.lastEffort).toBe('NORMAL');
    expect(firstRun?.lastUserMode).toBe('coding');

    await manager.setWorkspace(session.id, workspaceB);
    const secondRun = await manager.touchGoalRun(session.id, {
      permissionMode: 'AutoEdit',
      effort: 'HIGH',
      userMode: 'office',
    });

    expect(secondRun?.runCount).toBe(2);
    expect(secondRun?.lastWorkspace).toBe(workspaceB);
    expect(secondRun?.lastPermissionMode).toBe('AutoEdit');
    expect(secondRun?.lastEffort).toBe('HIGH');
    expect(secondRun?.lastUserMode).toBe('office');

    const meta = JSON.parse(
      await fsp.readFile(path.join(tmpDir, 'sessions', session.id, 'meta.json'), 'utf-8'),
    ) as { metadata: { goal: Record<string, unknown> } };
    expect(meta.metadata.goal.runCount).toBe(2);
    expect(meta.metadata.goal.lastWorkspace).toBe(workspaceB);
    expect(meta.metadata.goal.lastPermissionMode).toBe('AutoEdit');
  });
});
