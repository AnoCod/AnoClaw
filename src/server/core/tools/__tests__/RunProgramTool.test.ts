import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { BackgroundTaskManager, type BackgroundTaskResultSnapshot } from '../../agent/supervision/BackgroundTaskManager.js';
import { RunProgramTool } from '../builtin/RunProgramTool.js';
import { TaskStopTool } from '../builtin/TaskStopTool.js';

let tempDirs: string[] = [];

function ctx(workspace: string, signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'program-session',
    agentId: 'program-agent',
    workspace,
    userConfirmed: true,
    signal,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-program-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  RunProgramTool.cleanupSession('program-session');
  await new Promise(resolve => setTimeout(resolve, 50));
  BackgroundTaskManager.resetInstance();
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('RunProgramTool', () => {
  it('passes arguments directly without shell interpretation in wait mode', async () => {
    const workspace = await makeWorkspace();
    const marker = path.join(workspace, 'must-not-exist.txt');
    const specialArgument = `value & echo injected > ${marker}`;

    const result = await new RunProgramTool().execute(
      {
        program: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', specialArgument],
        description: 'Verify direct argument passing',
        mode: 'wait',
        visible: false,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toBe(specialArgument);
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.structured).toMatchObject({
      program: path.resolve(process.execPath),
      args: ['-e', 'process.stdout.write(process.argv[1])', specialArgument],
      mode: 'wait',
      exitCode: 0,
    });
  });

  it('returns a failure when the requested executable cannot be started', async () => {
    const workspace = await makeWorkspace();

    const result = await new RunProgramTool().execute(
      {
        program: `definitely-missing-anoclaw-program-${Date.now()}`,
        description: 'Start missing program',
        mode: 'wait',
        visible: false,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Failed to run program');
  });

  it('cleans up task state when a background executable cannot be started', async () => {
    const workspace = await makeWorkspace();

    const result = await new RunProgramTool().execute(
      {
        program: `definitely-missing-anoclaw-background-${Date.now()}`,
        description: 'Start missing background program',
        visible: false,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Failed to start program');
    expect(BackgroundTaskManager.getInstance().getActive()).toEqual([]);
    expect(BackgroundTaskManager.getInstance().getRecentTaskResultsForParent('program-session')).toEqual([
      expect.objectContaining({ type: 'program', status: 'failed' }),
    ]);
  });

  it('enforces wait-mode timeouts and terminates the process tree', async () => {
    const workspace = await makeWorkspace();

    const result = await new RunProgramTool().execute(
      {
        program: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        description: 'Run program until timeout',
        mode: 'wait',
        timeout: 100,
        visible: false,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    expect(result.structured).toMatchObject({ timedOut: true, killed: true });
  });

  it('tracks and stops a long-running background program', async () => {
    const workspace = await makeWorkspace();
    const tool = new RunProgramTool();

    const launch = await tool.execute(
      {
        program: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        description: 'Run stoppable program',
        mode: 'background',
        visible: false,
      },
      ctx(workspace),
    );

    expect(launch.success).toBe(true);
    const taskId = (launch.structured as { taskId: string }).taskId;
    expect(BackgroundTaskManager.getInstance().getTask(taskId)).toMatchObject({
      type: 'program',
      status: 'running',
      awaitCompletion: false,
    });

    const stopped = await new TaskStopTool().execute({ taskId }, ctx(workspace));
    expect(stopped.success).toBe(true);
    expect(stopped.structured).toMatchObject({
      taskId,
      type: 'program',
      killedProcess: true,
    });

    const recent = await waitForRecentTaskResult(taskId);
    expect(recent.status).toBe('killed');
    expect(recent.error).toContain('Program stopped by user request');
  });

  it('does not retry launches and rejects malformed argument arrays', async () => {
    const workspace = await makeWorkspace();
    const tool = new RunProgramTool();
    expect(tool.maxRetries()).toBe(0);

    const result = await tool.execute(
      {
        program: process.execPath,
        args: ['ok', 123],
        description: 'Reject invalid arguments',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('args must contain');
  });
});

async function waitForRecentTaskResult(taskId: string): Promise<BackgroundTaskResultSnapshot> {
  const manager = BackgroundTaskManager.getInstance();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const recent = manager.getRecentTaskResult(taskId);
    if (recent) return recent;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for background task result: ${taskId}`);
}
