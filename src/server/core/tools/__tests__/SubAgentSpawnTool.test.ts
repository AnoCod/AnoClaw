import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { WorkspaceLeaseService } from '../../coordination/WorkspaceLeaseService.js';
import { SessionManager } from '../../session/SessionManager.js';
import { SubAgentSpawnTool } from '../operations/SubAgentSpawnTool.js';

const ctx: ExecutionContext = {
  sessionId: 'root-1',
  agentId: 'parent-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('SubAgentSpawnTool ephemeral durable semantics', () => {
  let dir = '';
  let service: CoordinationService;
  let spawnSubAgent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-subagent-tool-'));
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      getRootSession: vi.fn(() => ({ id: 'root-1', agentId: ctx.agentId })),
    } as unknown as SessionManager);
    spawnSubAgent = vi.fn().mockResolvedValue(okResult('complete'));
    vi.spyOn(AgentRuntime, 'getInstance').mockReturnValue({ spawnSubAgent } as unknown as AgentRuntime);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('creates a durable subagent task and defaults to summary context', async () => {
    const result = await new SubAgentSpawnTool().execute({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      type: 'Plan',
    }, ctx);

    expect(result.success).toBe(true);
    expect(spawnSubAgent).toHaveBeenCalledWith(expect.objectContaining({
      contextMode: 'summary',
      readOnly: true,
      coordinationTaskId: expect.stringMatching(/^task-/),
    }), ctx.agentId, ctx.sessionId);
    expect(service.listTasks('root-1')).toEqual([
      expect.objectContaining({ mode: 'subagent', subject: 'Inspect area' }),
    ]);
  });

  it('background mode returns a durable task id rather than a process bt id', async () => {
    const result = await new SubAgentSpawnTool().execute({
      description: 'Inspect area',
      prompt: 'Read files and summarize.',
      type: 'Explore',
      background: true,
      contextMode: 'isolated',
    }, ctx);

    expect(result.success).toBe(true);
    const taskId = (result.structured as { taskId: string }).taskId;
    expect(taskId).toMatch(/^task-/);
    expect(taskId).not.toMatch(/^bt-/);
  });

  it('rejects removed persist controls through the public schema', () => {
    const validation = new SubAgentSpawnTool().parametersSchema() as {
      properties: Record<string, unknown>;
    };
    expect(validation.properties.persist).toBeUndefined();
    expect(validation.properties.ttl).toBeUndefined();
    expect(validation.properties.subagent_type).toBeUndefined();
    expect(validation.properties.run_in_background).toBeUndefined();
  });
});

function okResult(content: string): ToolResult {
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
