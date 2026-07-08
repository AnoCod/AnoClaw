import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BashTool } from '../builtin/BashTool.js';
import { TaskOutputTool } from '../builtin/TaskOutputTool.js';
import { TaskStopTool } from '../builtin/TaskStopTool.js';
import { BackgroundTaskManager, type BackgroundTaskResultSnapshot } from '../../agent/supervision/BackgroundTaskManager.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string, signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'bash-session',
    agentId: 'bash-agent',
    workspace,
    userConfirmed: true,
    signal,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-bash-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  BashTool.cleanupSession('bash-session');
  BackgroundTaskManager.resetInstance();
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('BashTool', () => {
  it('returns structured metadata for successful commands', async () => {
    const workspace = await makeWorkspace();

    const result = await new BashTool().execute(
      {
        command: nodeCommand("process.stdout.write('ok')"),
        description: 'Print ok',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toBe('ok');
    expect(result.structured).toMatchObject({
      exitCode: 0,
      timedOut: false,
      interrupted: false,
      cwd: path.resolve(workspace),
    });
  });

  it('returns failure for non-zero exit codes with stderr and exit metadata', async () => {
    const workspace = await makeWorkspace();

    const result = await new BashTool().execute(
      {
        command: nodeCommand("process.stderr.write('bad'); process.exit(7)"),
        description: 'Fail deliberately',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('exit code 7');
    expect(result.errorMessage).toContain('[stderr]');
    expect(result.errorMessage).toContain('bad');
    expect(result.structured).toMatchObject({
      exitCode: 7,
      stderrChars: 3,
      timedOut: false,
    });
  });

  it('enforces the timeout parameter and reports timeout metadata', async () => {
    const workspace = await makeWorkspace();

    const started = Date.now();
    const result = await new BashTool().execute(
      {
        command: nodeCommand('setTimeout(() => {}, 2000)'),
        description: 'Wait too long',
        timeout: 100,
      },
      ctx(workspace),
    );

    expect(Date.now() - started).toBeLessThan(1800);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    expect(result.structured).toMatchObject({
      timedOut: true,
      interrupted: false,
    });
  });

  it('runs commands in an explicit cwd', async () => {
    const workspace = await makeWorkspace();
    const subdir = path.join(workspace, 'packages', 'app');
    await mkdir(subdir, { recursive: true });

    const result = await new BashTool().execute(
      {
        command: nodeCommand('process.stdout.write(process.cwd())'),
        description: 'Print cwd',
        cwd: 'packages/app',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(path.resolve(result.content)).toBe(path.resolve(subdir));
    expect(result.structured).toMatchObject({
      cwd: path.resolve(subdir),
    });
  });

  it('rejects invalid cwd values before spawning a process', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'not-a-dir.txt');
    await writeFile(file, 'content');

    const result = await new BashTool().execute(
      {
        command: nodeCommand("process.stdout.write('should not run')"),
        description: 'Use invalid cwd',
        cwd: file,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('cwd is not a directory');
  });

  it('truncates oversized output using max_output_chars', async () => {
    const workspace = await makeWorkspace();

    const result = await new BashTool().execute(
      {
        command: nodeCommand("process.stdout.write('x'.repeat(2000))"),
        description: 'Print long output',
        max_output_chars: 200,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.wasTruncated).toBe(true);
    expect(result.content.length).toBeLessThan(500);
    expect(result.content).toContain('chars truncated');
    expect(result.structured).toMatchObject({
      stdoutChars: 2000,
      outputLimit: 200,
    });
  });

  it('captures background stdout for later task output retrieval', async () => {
    const workspace = await makeWorkspace();

    const result = await new BashTool().execute(
      {
        command: nodeCommand("process.stdout.write('background ok')"),
        description: 'Run background output',
        run_in_background: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    const taskId = (result.structured as { taskId: string }).taskId;
    const recent = await waitForRecentTaskResult(taskId);

    expect(recent.status).toBe('completed');
    expect(recent.content).toContain('Background process exited with code 0');
    expect(recent.content).toContain('background ok');
  });

  it('captures background stderr for later failure diagnostics', async () => {
    const workspace = await makeWorkspace();

    const result = await new BashTool().execute(
      {
        command: nodeCommand("process.stdout.write('before fail'); process.stderr.write('bad stderr'); process.exit(7)"),
        description: 'Run background failure',
        run_in_background: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    const taskId = (result.structured as { taskId: string }).taskId;
    const recent = await waitForRecentTaskResult(taskId);

    expect(recent.status).toBe('failed');
    expect(recent.error).toContain('Background process exited with code 7');
    expect(recent.error).toContain('before fail');
    expect(recent.error).toContain('[stderr]');
    expect(recent.error).toContain('bad stderr');
  });

  it('preserves partial background output when TaskStop kills a bash task', async () => {
    const workspace = await makeWorkspace();

    const result = await new BashTool().execute(
      {
        command: nodeCommand("process.stdout.write('partial stdout before stop\\n'); process.stderr.write('partial stderr before stop\\n'); setInterval(() => {}, 1000)"),
        description: 'Run stoppable background task',
        cwd: os.tmpdir(),
        run_in_background: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    const taskId = (result.structured as { taskId: string }).taskId;
    await new Promise(resolve => setTimeout(resolve, 150));

    const stopResult = await new TaskStopTool().execute({ taskId }, ctx(workspace));

    expect(stopResult.success).toBe(true);
    expect(stopResult.structured).toMatchObject({
      taskId,
      status: 'killed',
      killedProcess: true,
      finalized: true,
    });

    const outputResult = await new TaskOutputTool().execute({ taskId }, ctx(workspace));
    expect(outputResult.success).toBe(false);
    expect(outputResult.errorMessage).toContain('Background process was stopped by user request');
    expect(outputResult.errorMessage).toContain('partial stdout before stop');
    expect(outputResult.errorMessage).toContain('[stderr]');
    expect(outputResult.errorMessage).toContain('partial stderr before stop');
  });

  it('blocks expanded destructive command patterns without confirmation', async () => {
    const workspace = await makeWorkspace();

    const result = await new BashTool().execute(
      {
        command: 'git clean -fdx',
        description: 'Clean git files',
      },
      {
        ...ctx(workspace),
        userConfirmed: false,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Destructive command detected');
  });
});

function nodeCommand(script: string): string {
  const nodePath = process.execPath.replace(/\\/g, '/');
  return `"${nodePath}" -e ${JSON.stringify(script)}`;
}

async function waitForRecentTaskResult(taskId: string): Promise<BackgroundTaskResultSnapshot> {
  const manager = BackgroundTaskManager.getInstance();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const recent = manager.getRecentTaskResult(taskId);
    if (recent) return recent;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for background task result: ${taskId}`);
}
