import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMessageTool } from '../builtin/AgentMessageTool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { AgentChannel } from '../../agent/AgentChannel.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { SessionManager } from '../../session/index.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'parent-session',
  agentId: 'parent-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

function session(id: string, agentId: string, parentSessionId: string | null = null) {
  return {
    id,
    agentId,
    parentSessionId,
    isArchived: () => false,
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

describe('AgentMessageTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AgentRuntime.resetInstance();
    BackgroundTaskManager.resetInstance();
  });

  it('rejects invalid message parameters before touching registries', async () => {
    vi.spyOn(AgentRegistry, 'getInstance').mockImplementation(() => {
      throw new Error('AgentRegistry should not be touched for invalid AgentMessage params');
    });

    const result = await new AgentMessageTool().execute({
      targetAgentId: 'member-1',
      content: '   ',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('content must not be empty');
  });

  it('returns a tracked background task id for idle recipients', async () => {
    const childSession = session('child-session', 'child-agent', ctx.sessionId);
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async function* () {
      throw new Error('recipient model failed');
    });

    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      agent: vi.fn(() => ({
        id: ctx.agentId,
        name: 'Parent',
        parentAgentId: null,
        isActive: true,
      })),
      findAgent: vi.fn(() => ({
        id: 'child-agent',
        name: 'Child',
        parentAgentId: ctx.agentId,
        isActive: true,
      })),
    } as unknown as AgentRegistry);

    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      session: vi.fn(() => session(ctx.sessionId, ctx.agentId)),
      subsessionsOf: vi.fn(() => []),
      createSubSession: vi.fn().mockResolvedValue(childSession),
      appendMessage,
      rebuildMessageCache: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager);

    vi.spyOn(AgentRuntime, 'getInstance').mockReturnValue({
      isSessionActive: vi.fn(() => false),
      processMessage,
    } as unknown as AgentRuntime);

    vi.spyOn(AgentChannel, 'getInstance').mockReturnValue({
      send: vi.fn(),
    } as unknown as AgentChannel);

    const manager = BackgroundTaskManager.getInstance();
    const result = await new AgentMessageTool().execute({
      targetAgentId: ' child-agent ',
      content: '  Please report status.  ',
      summary: 'Status ping',
    }, ctx);

    expect(result.success).toBe(true);
    const taskId = (result.structured as { taskId?: string }).taskId;
    expect(taskId).toMatch(/^bt-/);
    expect(result.content).toContain(`Task ID: ${taskId}`);
    const recent = await waitForRecentTask(manager, taskId!);
    expect(appendMessage).toHaveBeenCalledWith(childSession.id, expect.objectContaining({
      content: '[Message from Parent (reply-to: parent-agent)]: Please report status.',
    }));
    expect(processMessage).toHaveBeenCalledWith(childSession.id, 'child-agent', expect.any(Object));
    expect(recent).toMatchObject({
      id: taskId,
      status: 'failed',
      error: 'recipient model failed',
    });
    expect(manager.getTask(taskId!)).toBeUndefined();
  });
});
