import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskListTool } from '../builtin/TaskListTool.js';
import { TaskOutputTool } from '../builtin/TaskOutputTool.js';
import { TaskStopTool } from '../builtin/TaskStopTool.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { SessionManager } from '../../session/SessionManager.js';
import { SessionStore } from '../../session/SessionStore.js';
import { MessageRole } from '../../../../shared/types/session.js';
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

let tmpDir = '';
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-task-tools-'));
  (SessionManager as any)._instance = undefined;
  (SessionStore as any)._instance = undefined;
  BackgroundTaskManager.resetInstance();
  sessionManager = SessionManager.getInstance();
  await sessionManager.initialize(path.join(tmpDir, 'sessions'));
});

afterEach(async () => {
  BackgroundTaskManager.resetInstance();
  (SessionManager as any)._instance = undefined;
  (SessionStore as any)._instance = undefined;
  if (tmpDir && path.basename(tmpDir).startsWith('anoclaw-task-tools-')) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
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

  it('TaskOutput bounds long recent bt task output with structured truncation metadata', async () => {
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = registerBackgroundTask();
    await bgm.complete(taskId, {
      content: `start-${'x'.repeat(500)}-end`,
      durationMs: 42,
    });

    const result = await new TaskOutputTool().execute({ taskId, max_chars: 200 }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('chars truncated');
    expect(result.content).toContain('start-');
    expect(result.content).toContain('-end');
    expect(result.structured).toMatchObject({
      taskId,
      status: 'completed',
      maxChars: 200,
      wasTruncated: true,
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

  it('TaskOutput returns bounded archived session output with tail and tool-message controls', async () => {
    const parent = await sessionManager.createMainSession(ctx.agentId, 'Parent task session', tmpDir);
    const child = await sessionManager.createSubSession(parent.id, 'child-agent', 'Child task');
    await appendTestMessage(child.id, MessageRole.Assistant, `first-${'a'.repeat(260)}`);
    await appendToolCallMessage(child.id, `tool-${'b'.repeat(260)}`);
    await appendTestMessage(child.id, MessageRole.Assistant, `final-${'c'.repeat(260)}-done`);
    await sessionManager.archiveSession(child.id);

    const result = await new TaskOutputTool().execute({
      taskId: child.id,
      max_chars: 220,
      include_tool_messages: false,
      tail_messages: 1,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('completed');
    expect(result.content).toContain('final-');
    expect(result.content).toContain('-done');
    expect(result.content).not.toContain('tool-');
    expect(result.structured).toMatchObject({
      taskId: child.id,
      status: 'completed',
      agentId: 'child-agent',
      outputMessageCount: 2,
      returnedMessageCount: 1,
      omittedMessages: 1,
      includeToolMessages: false,
      maxChars: 220,
      wasTruncated: true,
    });
  });

  it('TaskOutput rejects conflicting taskId aliases before lookup', async () => {
    const result = await new TaskOutputTool().execute({
      taskId: 'task-a',
      task_id: 'task-b',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('taskId and task_id must refer to the same task');
  });

  it('TaskStop returns structured feedback when a delegated session is not running', async () => {
    const result = await new TaskStopTool().execute({ taskId: 'session-without-controller' }, ctx);

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      taskId: 'session-without-controller',
      status: 'not_running',
      type: 'session',
      interrupted: false,
    });
  });
});

async function appendTestMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
): Promise<void> {
  await sessionManager.appendMessage(sessionId, {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    role,
    content,
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
  }, { notify: false });
}

async function appendToolCallMessage(
  sessionId: string,
  resultContent: string,
): Promise<void> {
  const now = Date.now();
  await sessionManager.appendMessage(sessionId, {
    id: `tool-call-${now}`,
    sessionId,
    role: MessageRole.Assistant,
    content: '(tool calls)',
    toolCalls: [
      {
        id: `tc-${now}`,
        toolName: 'Read',
        params: { file_path: 'src/index.ts' },
      },
    ],
    toolResults: [
      {
        toolCallId: `tc-${now}`,
        success: true,
        content: resultContent,
        tokensUsed: 0,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        wasTruncated: false,
      },
    ],
    tokenCount: 0,
    compressed: false,
    timestamp: new Date(now).toISOString(),
  }, { notify: false });
}
