import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRole } from '../../../../shared/types/agent.js';
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
  const setRuntimeStatus = vi.fn().mockResolvedValue(undefined);
  const createSubSession = vi.fn().mockResolvedValue({ id: 'child-session', agentId: 'member-1' });

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-agent-message-'));
    CoordinationService.resetInstance();
    WorkspaceLeaseService.resetInstance();
    service = CoordinationService.getInstance();
    await service.initialize(dir);
    appendMessage.mockReset().mockResolvedValue(undefined);
    setRuntimeStatus.mockReset().mockResolvedValue(undefined);
    createSubSession.mockReset().mockResolvedValue({ id: 'child-session', agentId: 'member-1' });
    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      getRootSession: vi.fn(() => ({ id: 'root-1', agentId: ctx.agentId })),
      session: vi.fn(() => ({ id: 'root-1', agentId: ctx.agentId, parentSessionId: null })),
      createSubSession,
      appendMessage,
      setRuntimeStatus,
    } as unknown as SessionManager);
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      findAgent: vi.fn((id: string) => id === ctx.agentId
        ? { id, name: 'Manager', role: AgentRole.Manager, parentAgentId: null, isActive: true }
        : { id, name: 'Member', role: AgentRole.Member, parentAgentId: ctx.agentId, isActive: true }),
      activeAgents: vi.fn(() => []),
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
    expect(setRuntimeStatus).toHaveBeenCalledWith('child-session', 'Idle');
    expect(result.content).toContain('mailbox-only');
    expect(result.content).toContain('readOnly=true');
    expect(result.structured).toMatchObject({
      deliveries: [
        expect.objectContaining({
          active: false,
          deliveryMode: 'mailbox_only',
        }),
      ],
    });
  });

  it('rejects steer for an idle recipient', async () => {
    const result = await new AgentMessageTool().execute({
      to: 'member-1',
      kind: 'steer',
      content: 'Change direction.',
    }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Cannot steer idle agent');
    expect(result.errorMessage).toContain('read-only Task');
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

  it('lets MainAgent message any employee and broadcast to the durable roster', async () => {
    const mainCtx = { ...ctx, agentId: 'main-agent' };
    const employees = [
      { id: 'main-agent', name: 'MainAgent', role: AgentRole.MainAgent, parentAgentId: null, isActive: true },
      { id: 'manager-1', name: 'Manager', role: AgentRole.Manager, parentAgentId: 'main-agent', isActive: true },
      { id: 'member-1', name: 'Member', role: AgentRole.Member, parentAgentId: 'manager-1', isActive: true },
      { id: 'subagent-1', name: 'Temporary', role: AgentRole.SubAgent, parentAgentId: 'member-1', isActive: true },
    ];
    vi.mocked(SessionManager.getInstance).mockReturnValue({
      getRootSession: vi.fn(() => ({ id: 'root-1', agentId: 'main-agent' })),
      session: vi.fn(() => ({ id: 'root-1', agentId: 'main-agent', parentSessionId: null })),
      createSubSession,
      appendMessage,
      setRuntimeStatus,
    } as unknown as SessionManager);
    vi.mocked(AgentRegistry.getInstance).mockReturnValue({
      findAgent: vi.fn((id: string) => employees.find((agent) => agent.id === id)),
      activeAgents: vi.fn(() => employees),
    } as unknown as AgentRegistry);

    const direct = await new AgentMessageTool().execute({
      to: 'member-1',
      kind: 'note',
      content: 'Direct message across reporting levels.',
    }, mainCtx);
    expect(direct.success).toBe(true);
    expect(createSubSession).toHaveBeenCalledWith(
      'root-1',
      'member-1',
      'Organization message: member-1',
      expect.objectContaining({ scopeId: 'organization' }),
    );

    const broadcast = await new AgentMessageTool().execute({
      to: '@organization',
      kind: 'note',
      content: 'Organization-wide update.',
    }, mainCtx);
    expect(broadcast.success).toBe(true);
    expect(service.listMessages('root-1').filter(
      (message) => message.content === 'Organization-wide update.',
    ).map((message) => message.toAgentId).sort()).toEqual(['manager-1', 'member-1']);
  });

  it('rejects organization-wide broadcast from non-MainAgent callers', async () => {
    const result = await new AgentMessageTool().execute({
      to: '@organization',
      kind: 'note',
      content: 'Unauthorized broadcast.',
    }, ctx);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Only the active MainAgent');
  });
});
