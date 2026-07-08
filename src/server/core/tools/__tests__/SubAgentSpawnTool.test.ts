import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubAgentSpawnTool } from '../builtin/SubAgentSpawnTool.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import type { ToolResult } from '../../../../shared/types/tool.js';

const ctx: ExecutionContext = {
  sessionId: 'subagent-parent-session',
  agentId: 'parent-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

function okResult(content = 'done'): ToolResult {
  const now = Date.now();
  return {
    toolCallId: 'subagent-ok',
    success: true,
    content,
    tokensUsed: 0,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    wasTruncated: false,
  };
}

function errorResult(errorMessage = 'spawn failed'): ToolResult {
  const now = Date.now();
  return {
    toolCallId: 'subagent-error',
    success: false,
    content: '',
    errorMessage,
    tokensUsed: 0,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    wasTruncated: false,
  };
}

async function waitForRecentTask(
  manager: BackgroundTaskManager,
  taskId: string,
): Promise<ReturnType<BackgroundTaskManager['getRecentTaskResult']>> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const result = manager.getRecentTaskResult(taskId);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return manager.getRecentTaskResult(taskId);
}

describe('SubAgentSpawnTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AgentRuntime.resetInstance();
    BackgroundTaskManager.resetInstance();
  });

  it('rejects ambiguous typed controls before touching AgentRuntime', async () => {
    const tool = new SubAgentSpawnTool();
    vi.spyOn(AgentRuntime, 'getInstance').mockImplementation(() => {
      throw new Error('AgentRuntime should not be touched for invalid SubAgentSpawn params');
    });

    const badBackground = await tool.execute({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      subagent_type: 'Explore',
      run_in_background: 'false',
    }, ctx);
    expect(badBackground.success).toBe(false);
    expect(badBackground.errorMessage).toContain('run_in_background must be a boolean');

    const badPersist = await tool.execute({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      subagent_type: 'Explore',
      persist: 'false',
    }, ctx);
    expect(badPersist.success).toBe(false);
    expect(badPersist.errorMessage).toContain('persist must be a boolean');

    const badModel = await tool.execute({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      subagent_type: 'Explore',
      model: 'opus',
    }, ctx);
    expect(badModel.success).toBe(false);
    expect(badModel.errorMessage).toContain('model must be one of');

    const badType = await tool.execute({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      subagent_type: 'Worker',
    }, ctx);
    expect(badType.success).toBe(false);
    expect(badType.errorMessage).toContain('subagent_type must be one of');
  });

  it('normalizes valid synchronous params before spawning', async () => {
    const spawnSubAgent = vi.fn().mockResolvedValue(okResult('complete'));
    vi.spyOn(AgentRuntime, 'getInstance').mockReturnValue({
      spawnSubAgent,
    } as unknown as AgentRuntime);

    const result = await new SubAgentSpawnTool().execute({
      description: '  Inspect area  ',
      prompt: '  Read files and summarize.  ',
      subagent_type: 'Plan',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toBe('complete');
    expect(spawnSubAgent).toHaveBeenCalledWith({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      subagent_type: 'Plan',
      model: 'sonnet',
      persist: false,
      run_in_background: false,
    }, 'parent-agent', 'subagent-parent-session');
  });

  it('records background SubAgent failures as task failures', async () => {
    const spawnSubAgent = vi.fn().mockResolvedValue(errorResult('model refused the task'));
    vi.spyOn(AgentRuntime, 'getInstance').mockReturnValue({
      spawnSubAgent,
    } as unknown as AgentRuntime);

    const manager = BackgroundTaskManager.getInstance();
    const result = await new SubAgentSpawnTool().execute({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      subagent_type: 'Explore',
      run_in_background: true,
    }, ctx);

    expect(result.success).toBe(true);
    const taskId = (result.structured as { taskId?: string }).taskId;
    expect(taskId).toMatch(/^bt-/);
    expect(result.content).toContain(`Task ID: ${taskId}`);

    const recent = await waitForRecentTask(manager, taskId!);
    expect(recent).toMatchObject({
      id: taskId,
      status: 'failed',
      error: 'model refused the task',
    });
    expect(manager.getTask(taskId!)).toBeUndefined();
  });
});
