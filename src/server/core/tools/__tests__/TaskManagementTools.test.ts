import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { WorkspaceLeaseService } from '../../coordination/WorkspaceLeaseService.js';
import { SessionManager } from '../../session/SessionManager.js';
import { JobListTool } from '../builtin/JobListTool.js';
import { TaskListTool } from '../builtin/TaskListTool.js';
import { TaskOutputTool } from '../builtin/TaskOutputTool.js';
import { TaskStopTool } from '../builtin/TaskStopTool.js';
import { TaskUpdateTool } from '../builtin/TaskUpdateTool.js';

const ctx: ExecutionContext = {
  sessionId: 'root-1',
  agentId: 'manager-1',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('durable Task tools and process Job separation', () => {
  let dir = '';
  let service: CoordinationService;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-task-tools-'));
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    BackgroundTaskManager.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      getRootSession: vi.fn(() => ({ id: 'root-1', agentId: ctx.agentId })),
      getHistory: vi.fn().mockResolvedValue([]),
    } as unknown as SessionManager);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    BackgroundTaskManager.resetInstance();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('TaskList reads only persistent coordination tasks', async () => {
    const task = await createRunningTask();
    BackgroundTaskManager.getInstance().register({
      type: 'bash',
      parentSessionId: ctx.sessionId,
      parentAgentId: ctx.agentId,
      summary: 'Process job',
    });

    const result = await new TaskListTool().execute({}, ctx);
    const structured = result.structured as { tasks: Array<{ id: string }> };
    expect(result.success).toBe(true);
    expect(structured.tasks.map((item) => item.id)).toEqual([task.id]);
    expect(result.content).not.toContain('Process job');
  });

  it('JobList reads only non-Agent background processes', async () => {
    const jobId = BackgroundTaskManager.getInstance().register({
      type: 'bash',
      parentSessionId: ctx.sessionId,
      parentAgentId: ctx.agentId,
      summary: 'Process job',
      command: 'npm test',
    });
    await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Agent task',
      description: 'Do work',
      acceptanceCriteria: ['Done'],
      creatorAgentId: ctx.agentId,
      readOnly: true,
    });

    const result = await new JobListTool().execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain(jobId);
    expect(result.content).not.toContain('Agent task');
  });

  it('TaskOutput remains available after durable completion', async () => {
    const running = await createRunningTask();
    await service.updateTask('root-1', running.id, {
      status: 'completed',
      resultSummary: 'Verified result',
      evidence: ['test passed'],
    }, 'member-1');

    const result = await new TaskOutputTool().execute({ taskId: running.id }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('completed');
    expect(result.content).toContain('Verified result');
  });

  it('TaskStop persists cancellation', async () => {
    const running = await createRunningTask();
    const result = await new TaskStopTool().execute({
      taskId: running.id,
      reason: 'No longer needed',
    }, ctx);
    expect(result.success).toBe(true);
    expect(service.getTask('root-1', running.id)).toMatchObject({
      status: 'cancelled',
      error: 'No longer needed',
    });
  });

  it('keeps a running task lease until the interrupted AgentLoop exits', async () => {
    let task = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Workspace task',
      description: 'Do work',
      acceptanceCriteria: ['Done'],
      creatorAgentId: ctx.agentId,
      assigneeAgentId: 'member-1',
      readOnly: false,
      writeScope: ['src'],
    });
    const lease = await service.acquireTaskLease('root-1', task.id, process.cwd(), 30_000);
    expect(lease).not.toBeNull();
    task = await service.claimTask('root-1', task.id, 'member-1', task.version);
    task = await service.updateTask('root-1', task.id, {
      status: 'running',
      sessionId: 'worker-session',
    }, 'member-1', task.version);

    const result = await new TaskStopTool().execute({
      taskId: task.id,
      reason: 'Stop after current operation',
    }, ctx);

    expect(result.success).toBe(true);
    expect(service.getTask('root-1', task.id)).toMatchObject({
      status: 'running',
      blocker: 'cancellation_requested',
      error: 'Stop after current operation',
    });
    expect(WorkspaceLeaseService.getInstance().getForTask(task.id)).toHaveLength(1);

    await service.updateTask('root-1', task.id, { progress: 50 }, 'member-1');
    expect(WorkspaceLeaseService.getInstance().getForTask(task.id)).toHaveLength(1);

    await service.updateTask('root-1', task.id, {
      status: 'cancelled',
      blocker: undefined,
    }, 'member-1');
    expect(WorkspaceLeaseService.getInstance().getForTask(task.id)).toHaveLength(0);
  });

  it('does not let a task creator finalize an assignee AgentLoop that is still running', async () => {
    const running = await createRunningTask();
    const result = await new TaskUpdateTool().execute({
      taskId: running.id,
      expectedVersion: running.version,
      status: 'completed',
      resultSummary: 'Creator forced completion',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('finalized by its runtime');
    expect(service.getTask('root-1', running.id)?.status).toBe('running');
  });

  it('does not lose a cancellation request racing with heartbeat progress', async () => {
    let task = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Concurrent stop',
      description: 'Keep the cancellation request atomic with heartbeat updates',
      acceptanceCriteria: ['Cancellation is recorded'],
      creatorAgentId: ctx.agentId,
      assigneeAgentId: 'member-1',
      readOnly: true,
    });
    task = await service.claimTask('root-1', task.id, 'member-1', task.version);
    task = await service.updateTask('root-1', task.id, {
      status: 'running',
      sessionId: 'worker-session',
    }, 'member-1', task.version);

    await expect(Promise.all([
      service.updateTask('root-1', task.id, {
        heartbeatAt: new Date().toISOString(),
        progress: 25,
      }, 'member-1'),
      service.requestTaskCancellation('root-1', task.id, ctx.agentId, 'Stop now'),
    ])).resolves.toHaveLength(2);

    expect(service.getTask('root-1', task.id)).toMatchObject({
      status: 'running',
      blocker: 'cancellation_requested',
      error: 'Stop now',
    });
  });

  async function createRunningTask() {
    let task = await service.createTask({
      rootSessionId: 'root-1',
      mode: 'hierarchy',
      subject: 'Agent task',
      description: 'Do work',
      acceptanceCriteria: ['Done'],
      creatorAgentId: ctx.agentId,
      assigneeAgentId: 'member-1',
      readOnly: true,
    });
    task = await service.claimTask('root-1', task.id, 'member-1', task.version);
    return service.updateTask('root-1', task.id, { status: 'running' }, 'member-1', task.version);
  }
});
