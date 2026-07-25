import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { WorkspaceLeaseService } from '../../coordination/WorkspaceLeaseService.js';
import { SessionManager } from '../../session/SessionManager.js';
import { AgentMessageTool } from '../builtin/AgentMessageTool.js';

const ctx: ExecutionContext = {
  sessionId: 'root-1',
  agentId: 'manager-1',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('AgentMessageTool durable mailbox', () => {
  let dir = '';
  let service: CoordinationService;
  const appendMessage = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-agent-message-'));
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    appendMessage.mockClear();
    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      getRootSession: vi.fn(() => ({ id: 'root-1', agentId: ctx.agentId })),
      session: vi.fn(() => ({ id: 'root-1', agentId: ctx.agentId, parentSessionId: null })),
      createSubSession: vi.fn().mockResolvedValue({ id: 'child-session', agentId: 'member-1' }),
      appendMessage,
    } as unknown as SessionManager);
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      findAgent: vi.fn((id: string) => id === ctx.agentId
        ? { id, name: 'Manager', parentAgentId: null, isActive: true }
        : { id, name: 'Member', parentAgentId: ctx.agentId, isActive: true }),
    } as unknown as AgentRegistry);
    vi.spyOn(AgentRuntime, 'getInstance').mockReturnValue({
      isSessionActive: vi.fn(() => false),
    } as unknown as AgentRuntime);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('persists an ordered note without starting another AgentLoop', async () => {
    const result = await new AgentMessageTool().execute({
      to: 'member-1',
      kind: 'note',
      content: 'Please review the evidence.',
      summary: 'Review request',
    }, ctx);

    expect(result.success).toBe(true);
    expect(service.listMessages('root-1', 'member-1')).toEqual([
      expect.objectContaining({
        kind: 'note',
        content: 'Please review the evidence.',
        status: 'delivered',
        sequence: 1,
      }),
    ]);
    expect(appendMessage).toHaveBeenCalledWith('child-session', expect.objectContaining({
      role: 'user',
      content: expect.stringContaining('<coordination-message'),
    }));
  });

  it('rejects steer for an idle recipient', async () => {
    const result = await new AgentMessageTool().execute({
      to: 'member-1',
      kind: 'steer',
      content: 'Change direction.',
    }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Cannot steer idle agent');
  });

  it('persists one independently acknowledged record per broadcast recipient', async () => {
    const team = await service.createTeam({
      rootSessionId: 'root-1',
      name: 'Review team',
      purpose: 'Broadcast coordination updates',
      leaderAgentId: ctx.agentId,
      memberAgentIds: ['member-1', 'member-2'],
      createdByAgentId: ctx.agentId,
    });
    const result = await new AgentMessageTool().execute({
      to: '*',
      kind: 'note',
      content: 'Shared update',
    }, ctx);

    expect(result.success).toBe(true);
    const messages = service.listMessages('root-1');
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.toAgentId).sort()).toEqual(['member-1', 'member-2']);
    expect(messages.every((message) => message.teamId === team.id && message.status === 'delivered')).toBe(true);
  });
});
