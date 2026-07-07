import { describe, expect, it, afterEach } from 'vitest';
import { SleepTool } from '../builtin/SleepTool.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

function ctx(signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'sleep-session',
    agentId: 'sleep-agent',
    workspace: process.cwd(),
    userConfirmed: true,
    signal,
  };
}

function registerTask(): string {
  return BackgroundTaskManager.getInstance().register({
    type: 'bash',
    parentSessionId: 'sleep-session',
    parentAgentId: 'sleep-agent',
    summary: 'Test task',
    command: 'echo ok',
  });
}

afterEach(() => {
  BackgroundTaskManager.resetInstance();
});

describe('SleepTool', () => {
  it('reports structured metadata for timed sleeps', async () => {
    const result = await new SleepTool().execute(
      {
        delaySeconds: 0,
        reason: 'unit test',
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      sleepStatus: 'completed',
      requestedDelaySeconds: 0,
      cappedDelaySeconds: 0,
    });
  });

  it('returns a recent completed task result even when the task already left the active registry', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerTask();
    await bgm.complete(taskId, {
      content: 'build passed',
      durationMs: 42,
    });

    const result = await new SleepTool().execute(
      {
        wait_for_task_id: taskId,
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('already completed');
    expect(result.content).toContain('build passed');
    expect(result.structured).toMatchObject({
      taskId,
      taskStatus: 'completed',
      recent: true,
      durationMs: 42,
    });
  });

  it('wakes immediately when a running task completes', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerTask();

    const pending = new SleepTool().execute(
      {
        wait_for_task_id: taskId,
        delaySeconds: 1,
      },
      ctx(),
    );

    setTimeout(() => {
      bgm.complete(taskId, {
        content: 'done now',
        durationMs: 25,
      });
    }, 20);

    const result = await pending;

    expect(result.success).toBe(true);
    expect(result.content).toContain('done now');
    expect(result.structured).toMatchObject({
      taskId,
      taskStatus: 'completed',
    });
  });

  it('returns failure for recent failed tasks', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerTask();
    await bgm.fail(taskId, 'install failed', 30);

    const result = await new SleepTool().execute(
      {
        wait_for_task_id: taskId,
      },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('install failed');
    expect(result.structured).toMatchObject({
      taskId,
      taskStatus: 'failed',
      recent: true,
    });
  });

  it('returns failure for killed tasks and preserves a recent result', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerTask();

    expect(bgm.kill(taskId)).toBe(true);

    const result = await new SleepTool().execute(
      {
        wait_for_task_id: taskId,
      },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('killed');
    expect(result.structured).toMatchObject({
      taskId,
      taskStatus: 'killed',
      recent: true,
    });
  });

  it('returns failure for unknown task IDs', async () => {
    const result = await new SleepTool().execute(
      {
        wait_for_task_id: 'bt-missing',
      },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('not found');
    expect(result.structured).toMatchObject({
      taskId: 'bt-missing',
      taskStatus: 'not_found',
    });
  });

  it('returns timeout failure when a task remains running past the requested wait', async () => {
    const taskId = registerTask();

    const result = await new SleepTool().execute(
      {
        wait_for_task_id: taskId,
        delaySeconds: 0.02,
      },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    expect(result.structured).toMatchObject({
      taskId,
      taskStatus: 'timeout',
    });
  });
});
