import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../../../../core/session/SessionManager.js';
import { SessionStore } from '../../../../core/session/SessionStore.js';
import type { Transport } from '../../Transport.js';
import { setGoalHandler } from '../SetGoalHandler.js';
import { stopHandler } from '../StopHandler.js';

describe('Goal lifecycle handlers', () => {
  let tmpDir = '';
  let manager: SessionManager;
  let sends: Array<{ sessionId: string; event: Record<string, unknown> }>;
  let ws: Transport;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-goal-handler-'));
    (SessionManager as unknown as { _instance?: SessionManager })._instance = undefined;
    (SessionStore as unknown as { _instance?: SessionStore })._instance = undefined;
    manager = SessionManager.getInstance();
    await manager.initialize(path.join(tmpDir, 'sessions'));
    sends = [];
    ws = {
      send: (sessionId: string, event: Record<string, unknown>) => {
        sends.push({ sessionId, event });
        return true;
      },
      broadcast: () => {},
      isConnected: () => true,
      activeSessions: () => [],
      shutdown: async () => {},
      on: () => {},
    };
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('starts an execution contract without changing the session permission mode', async () => {
    const session = await manager.createMainSession('agent-main', 'Goal', tmpDir);
    await manager.setSessionPermissionMode(session.id, 'Ask');

    await setGoalHandler({
      sessionId: session.id,
      type: 'set_goal',
      data: {
        type: 'set_goal',
        messageId: 'request-1',
        action: 'start',
        objective: 'Deliver a verified report',
        acceptanceCriteria: 'report.md exists and checks pass',
        workspace: path.join(tmpDir, 'unbound-workspace'),
        permissionMode: 'Auto',
        maxRuns: 9,
        maxConsecutiveFailures: 2,
        wakeIntervalMs: 60000,
      },
      ws,
    });

    expect(manager.getSessionPermissionMode(session.id)).toBe('Ask');
    expect(manager.getGoal(session.id)).toMatchObject({
      objective: 'Deliver a verified report',
      acceptanceCriteria: 'report.md exists and checks pass',
      permissionMode: 'AutoEdit',
      maxRuns: 9,
      status: 'active',
      workspace: tmpDir,
    });
    expect(sends.at(-1)?.event).toMatchObject({
      type: 'goal_changed',
      messageId: 'request-1',
      action: 'start',
    });
  });

  it('rejects a new Goal without completion criteria', async () => {
    const session = await manager.createMainSession('agent-main', 'Goal', tmpDir);
    await setGoalHandler({
      sessionId: session.id,
      type: 'set_goal',
      data: { type: 'set_goal', action: 'start', objective: 'An ambiguous Goal' },
      ws,
    });

    expect(manager.getGoal(session.id)).toBeNull();
    expect(sends.at(-1)?.event).toMatchObject({ code: 'GOAL_ACCEPTANCE_REQUIRED' });
  });

  it('pauses an active Goal when generation is stopped', async () => {
    const session = await manager.createMainSession('agent-main', 'Goal', tmpDir);
    await manager.setGoal(session.id, 'Keep working');

    await stopHandler({ sessionId: session.id, type: 'stop', data: { type: 'stop' }, ws });

    expect(manager.getGoal(session.id)?.status).toBe('paused');
    expect(sends.some(({ event }) => event.type === 'goal_changed' && event.action === 'pause')).toBe(true);
  });

  it('only completes a Goal after a review outcome', async () => {
    const session = await manager.createMainSession('agent-main', 'Goal', tmpDir);
    await manager.setGoal(session.id, 'Deliver a report');
    const running = await manager.beginGoalRun(session.id);
    await manager.reportGoalRun(session.id, {
      runId: running!.currentRunId!,
      outcome: 'waiting_review',
      summary: 'Ready to review',
    });

    await setGoalHandler({
      sessionId: session.id,
      type: 'set_goal',
      data: { type: 'set_goal', action: 'complete' },
      ws,
    });

    expect(manager.getGoal(session.id)?.status).toBe('completed');
    expect(manager.getGoal(session.id)?.completedAt).toBeTruthy();
  });

  it('rejects completion before the Goal is ready for review', async () => {
    const session = await manager.createMainSession('agent-main', 'Goal', tmpDir);
    await manager.setGoal(session.id, { objective: 'Deliver a report', acceptanceCriteria: 'reviewed report' });

    await setGoalHandler({
      sessionId: session.id,
      type: 'set_goal',
      data: { type: 'set_goal', messageId: 'request-complete', action: 'complete' },
      ws,
    });

    expect(manager.getGoal(session.id)?.status).toBe('active');
    expect(sends.at(-1)?.event).toMatchObject({
      type: 'error',
      messageId: 'request-complete',
      code: 'GOAL_REVIEW_REQUIRED',
    });
  });

  it('reactivates a budget-limited Goal after the run limit is increased', async () => {
    const session = await manager.createMainSession('agent-main', 'Goal', tmpDir);
    await manager.setGoal(session.id, {
      objective: 'Finish within a larger budget',
      acceptanceCriteria: 'verified result',
      maxRuns: 1,
    });
    const running = await manager.beginGoalRun(session.id);
    await manager.reportGoalRun(session.id, {
      runId: running!.currentRunId!,
      outcome: 'progress',
      summary: 'One step complete',
    });
    await manager.beginGoalRun(session.id);
    expect(manager.getGoal(session.id)?.status).toBe('budget_exhausted');

    await setGoalHandler({
      sessionId: session.id,
      type: 'set_goal',
      data: {
        type: 'set_goal',
        action: 'edit',
        objective: 'Finish within a larger budget',
        acceptanceCriteria: 'verified result',
        maxRuns: 3,
      },
      ws,
    });

    expect(manager.getGoal(session.id)?.status).toBe('active');
    expect(manager.getGoal(session.id)?.maxRuns).toBe(3);
  });
});
