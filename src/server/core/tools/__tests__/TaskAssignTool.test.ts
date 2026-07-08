import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskAssignTool } from '../builtin/TaskAssignTool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import type { ToolResult } from '../../../../shared/types/tool.js';

const ctx: ExecutionContext = {
  sessionId: 'parent-session',
  agentId: 'manager-1',
  workspace: process.cwd(),
  userConfirmed: true,
};

function toolResult(content: string, structured?: Record<string, unknown>): ToolResult {
  return {
    toolCallId: 'delegate-member-1',
    success: true,
    content,
    structured,
    tokensUsed: 0,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    durationMs: 0,
    wasTruncated: false,
  };
}

describe('TaskAssignTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AgentRuntime.resetInstance();
    AgentRegistry.resetInstance();
  });

  it('rejects invalid structured params before touching registries', async () => {
    vi.spyOn(AgentRegistry, 'getInstance').mockImplementation(() => {
      throw new Error('AgentRegistry should not be touched for invalid TaskAssign params');
    });
    vi.spyOn(AgentRuntime, 'getInstance').mockImplementation(() => {
      throw new Error('AgentRuntime should not be touched for invalid TaskAssign params');
    });

    const badTask = await new TaskAssignTool().execute({
      targetAgentId: 'member-1',
      task: '   ',
    }, ctx);
    expect(badTask.success).toBe(false);
    expect(badTask.errorMessage).toContain('task must not be empty');

    const badPriority = await new TaskAssignTool().execute({
      targetAgentId: 'member-1',
      task: 'Inspect the current native tool changes.',
      priority: 'later',
    }, ctx);
    expect(badPriority.success).toBe(false);
    expect(badPriority.errorMessage).toContain('priority must be one of');
  });

  it('rejects non-direct subordinates before dispatching to runtime', async () => {
    const delegateTask = vi.fn();
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      findAgent: vi.fn(() => ({
        id: 'member-1',
        name: 'Member',
        parentAgentId: 'other-manager',
      })),
    } as unknown as AgentRegistry);
    vi.spyOn(AgentRuntime, 'getInstance').mockReturnValue({
      delegateTask,
    } as unknown as AgentRuntime);

    const result = await new TaskAssignTool().execute({
      targetAgentId: 'member-1',
      task: 'Inspect the current native tool changes.',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('direct subordinates');
    expect(delegateTask).not.toHaveBeenCalled();
  });

  it('normalizes params and returns delegated task metadata', async () => {
    const delegateTask = vi.fn().mockResolvedValue(toolResult(
      'Task dispatched to member-1.\nTask ID: bt-task-1',
      {
        taskId: 'bt-task-1',
        status: 'running',
        subSessionId: 'parent-session-member-1',
        targetAgentId: 'member-1',
        background: true,
      },
    ));
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      findAgent: vi.fn(() => ({
        id: 'member-1',
        name: 'Member',
        parentAgentId: ctx.agentId,
      })),
    } as unknown as AgentRegistry);
    vi.spyOn(AgentRuntime, 'getInstance').mockReturnValue({
      delegateTask,
    } as unknown as AgentRuntime);

    const result = await new TaskAssignTool().execute({
      targetAgentId: ' member-1 ',
      task: '  Inspect the current native tool changes.  ',
      priority: ' high ',
    }, ctx);

    expect(result.success).toBe(true);
    expect(delegateTask).toHaveBeenCalledWith(
      'member-1',
      'Inspect the current native tool changes.',
      ctx.sessionId,
      ctx.agentId,
      'high',
    );
    expect(result.content).toContain('Task ID: bt-task-1');
    expect(result.structured).toMatchObject({
      taskId: 'bt-task-1',
      status: 'running',
      subSessionId: 'parent-session-member-1',
      targetAgentId: 'member-1',
      parentSessionId: ctx.sessionId,
      parentAgentId: ctx.agentId,
      priority: 'high',
      taskPreview: 'Inspect the current native tool changes.',
    });
  });
});
