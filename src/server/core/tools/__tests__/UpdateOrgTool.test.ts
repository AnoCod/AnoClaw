import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateOrgTool } from '../builtin/UpdateOrgTool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { Agent } from '../../agent/Agent.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'update-org-session',
  agentId: 'manager-a',
  workspace: process.cwd(),
  userConfirmed: true,
};

function makeAgent(
  id: string,
  name: string,
  role: AgentRole,
  parentAgentId: string | null,
  level: number,
): Agent {
  return new Agent({
    id,
    name,
    role,
    parentAgentId,
    level,
    teamName: 'Engineering',
    provider: 'test',
    apiUrl: 'https://api.example.test',
    apiKey: 'sk-test',
    model: 'test-model',
    contextWindow: 128000,
    maxTurns: 25,
    temperature: 0.7,
    agentPrompt: '',
    preferredLanguage: 'en',
    conversationLanguage: 'en',
    allowedTools: [],
    enabledSkills: [],
    mcpServers: [],
    state: AgentState.Active,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

function setupRegistry() {
  const registry = AgentRegistry.getInstance();
  const ceo = makeAgent('ceo', 'CEO', AgentRole.MainAgent, null, 0);
  const managerA = makeAgent('manager-a', 'Manager A', AgentRole.Manager, 'ceo', 1);
  const managerB = makeAgent('manager-b', 'Manager B', AgentRole.Manager, 'ceo', 1);
  const managerC = makeAgent('manager-c', 'Manager C', AgentRole.Manager, 'manager-a', 2);
  const member = makeAgent('member-1', 'Member 1', AgentRole.Member, 'manager-a', 2);
  for (const agent of [ceo, managerA, managerB, managerC, member]) {
    registry.registerAgent(agent);
  }
  return { registry, ceo, managerA, managerB, managerC, member };
}

describe('UpdateOrgTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    AgentRegistry.resetInstance();
  });

  it('rejects invalid params before touching AgentRegistry', async () => {
    vi.spyOn(AgentRegistry, 'getInstance').mockImplementation(() => {
      throw new Error('AgentRegistry should not be touched for invalid UpdateOrg params');
    });

    const result = await new UpdateOrgTool().execute({
      agentId: '   ',
      newParentId: 'manager-b',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('agentId must not be empty');
  });

  it('rejects non-manager parents and circular org moves', async () => {
    const { member } = setupRegistry();

    const nonManager = await new UpdateOrgTool().execute({
      agentId: 'manager-b',
      newParentId: member.id,
    }, ctx);
    expect(nonManager.success).toBe(false);
    expect(nonManager.errorMessage).toContain('cannot have subordinates');
    expect(nonManager.structured).toMatchObject({
      agentId: 'manager-b',
      newParentId: 'member-1',
      status: 'parent_not_manager',
    });

    const circular = await new UpdateOrgTool().execute({
      agentId: 'manager-a',
      newParentId: 'manager-c',
    }, ctx);
    expect(circular.success).toBe(false);
    expect(circular.errorMessage).toContain('circular reference');
    expect(circular.structured).toMatchObject({
      agentId: 'manager-a',
      newParentId: 'manager-c',
      status: 'circular_reference',
    });
  });

  it('normalizes identifiers and returns structured metadata for successful moves', async () => {
    const { registry, member } = setupRegistry();
    const saveAgent = vi.spyOn(registry, 'saveAgent').mockResolvedValue(undefined);

    const result = await new UpdateOrgTool().execute({
      agentId: '  member-1  ',
      newParentId: '  manager-b  ',
    }, ctx);

    expect(result.success).toBe(true);
    expect(member.parentAgentId).toBe('manager-b');
    expect(member.level).toBe(2);
    expect(saveAgent).toHaveBeenCalledWith('member-1');
    expect(result.structured).toMatchObject({
      agentId: 'member-1',
      agentName: 'Member 1',
      oldParentId: 'manager-a',
      oldParentName: 'Manager A',
      oldLevel: 2,
      newParentId: 'manager-b',
      newParentName: 'Manager B',
      newLevel: 2,
      status: 'updated',
    });
  });

  it('rolls back parent reassignment when persistence fails', async () => {
    const { registry, member } = setupRegistry();
    vi.spyOn(registry, 'saveAgent').mockRejectedValue(new Error('disk full'));

    const result = await new UpdateOrgTool().execute({
      agentId: 'member-1',
      newParentId: 'manager-b',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Failed to persist org change: disk full');
    expect(member.parentAgentId).toBe('manager-a');
    expect(member.level).toBe(2);
    expect(result.structured).toMatchObject({
      agentId: 'member-1',
      oldParentId: 'manager-a',
      newParentId: 'manager-b',
      status: 'persist_failed',
      rolledBack: true,
    });
  });
});
