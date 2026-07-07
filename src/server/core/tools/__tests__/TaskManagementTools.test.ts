import { afterEach, describe, expect, it } from 'vitest';
import { TaskListTool } from '../builtin/TaskListTool.js';
import { TaskOutputTool } from '../builtin/TaskOutputTool.js';
import { TaskStopTool } from '../builtin/TaskStopTool.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'task-session',
  agentId: 'task-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

function registerBackgroundTask(): string {
  return BackgroundTaskManager.getInstance().register({
    type: 'bash',
    parentSessionId: ctx.sessionId,
    parentAgentId: ctx.agentId,
    summary: 'Long running build',
    command: 'npm test',
  });
}

afterEach(() => {
  BackgroundTaskManager.resetInstance();
});

describe('Task management tools', () => {
  it('TaskList reports background tasks even when no sub-sessions exist', async () => {
    const taskId = registerBackgroundTask();

    const result = await new TaskListTool().execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('background task(s)');
    expect(result.content).toContain('Long running build');
    expect(result.content).not.toContain('No delegated or background tasks found');
    const structured = result.structured as {
      backgroundTasks: Array<{ id: string; status: string; command: string }>;
    };
    expect(structured.backgroundTasks).toEqual([
      expect.objectContaining({ id: taskId, status: 'running', command: 'npm test' }),
    ]);
  });

  it('TaskList reports recent completed background task results', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerBackgroundTask();
    await bgm.complete(taskId, { content: 'build passed', durationMs: 1234 });

    const result = await new TaskListTool().execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('recent background task result');
    expect(result.content).toContain('[completed]');
    const structured = result.structured as {
      recentBackgroundTasks: Array<{ id: string; status: string; hasContent: boolean }>;
    };
    expect(structured.recentBackgroundTasks).toEqual([
      expect.objectContaining({ id: taskId, status: 'completed', hasContent: true }),
    ]);
  });

  it('TaskOutput returns recent completed bt task output', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerBackgroundTask();
    await bgm.complete(taskId, { content: 'final output', durationMs: 42 });

    const result = await new TaskOutputTool().execute({ taskId }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('completed');
    expect(result.content).toContain('final output');
    expect(result.structured).toMatchObject({
      taskId,
      status: 'completed',
      active: false,
      recent: true,
    });
  });

  it('TaskOutput returns failure for recent failed bt tasks', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerBackgroundTask();
    await bgm.fail(taskId, 'compile failed', 25);

    const result = await new TaskOutputTool().execute({ task_id: taskId }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('failed');
    expect(result.errorMessage).toContain('compile failed');
    expect(result.structured).toMatchObject({
      taskId,
      status: 'failed',
      active: false,
      recent: true,
    });
  });

  it('TaskStop stops active bt tasks and preserves a killed recent result', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerBackgroundTask();

    const stopResult = await new TaskStopTool().execute({ taskId }, ctx);

    expect(stopResult.success).toBe(true);
    expect(stopResult.content).toContain('has been stopped');
    expect(stopResult.structured).toMatchObject({
      taskId,
      status: 'killed',
      type: 'bash',
      killedProcess: false,
    });
    expect(bgm.getTask(taskId)).toBeUndefined();
    expect(bgm.getRecentTaskResult(taskId)).toMatchObject({ status: 'killed' });

    const outputResult = await new TaskOutputTool().execute({ taskId }, ctx);
    expect(outputResult.success).toBe(false);
    expect(outputResult.errorMessage).toContain('killed');
  });

  it('TaskStop explains when a bt task already completed', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerBackgroundTask();
    await bgm.complete(taskId, { content: 'done before stop', durationMs: 10 });

    const result = await new TaskStopTool().execute({ taskId }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('already completed');
    expect(result.structured).toMatchObject({
      taskId,
      status: 'completed',
      recent: true,
    });
  });
});
