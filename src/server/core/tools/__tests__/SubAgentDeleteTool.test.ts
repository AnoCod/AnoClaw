import { afterEach, describe, expect, it } from 'vitest';
import { SubAgentDeleteTool } from '../builtin/SubAgentDeleteTool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { Agent } from '../../agent/Agent.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'subagent-delete-session',
  agentId: 'manager-1',
  workspace: process.cwd(),
  userConfirmed: true,
};

function makeAgent(
  id: string,
  role: AgentRole,
  state: AgentState = AgentState.Active,
): Agent {
  return new Agent({
    id,
    name: `${role}-${id}`,
    role,
    parentAgentId: 'manager-1',
    level: role === AgentRole.SubAgent ? 3 : 2,
    teamName: 'Temporary',
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
    allowedTools: ['Read'],
    enabledSkills: [],
    mcpServers: [],
    state,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

function register(agent: Agent): void {
  AgentRegistry.getInstance().registerAgent(agent);
}

describe('SubAgentDeleteTool', () => {
  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  it('dry-runs an active SubAgent without mutating the registry', async () => {
    const subAgent = makeAgent('subagent-1', AgentRole.SubAgent);
    register(subAgent);

    const result = await new SubAgentDeleteTool().execute({
      agentId: '  subagent-1  ',
      dry_run: true,
      reason: 'cleanup preview',
    }, ctx);

    expect(result.success).toBe(true);
    expect(AgentRegistry.getInstance().agent('subagent-1')).toBe(subAgent);
    expect(result.structured).toMatchObject({
      agentId: 'subagent-1',
      status: 'dry_run',
      deleted: false,
      dryRun: true,
      reason: 'cleanup preview',
      sessionAction: 'preserved_transcripts',
    });
  });

  it('destroys and unregisters an active SubAgent with structured feedback', async () => {
    register(makeAgent('subagent-1', AgentRole.SubAgent));

    const result = await new SubAgentDeleteTool().execute({ agentId: 'subagent-1' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('destroyed and unregistered successfully');
    expect(AgentRegistry.getInstance().agent('subagent-1')).toBeUndefined();
    expect(result.structured).toMatchObject({
      agentId: 'subagent-1',
      status: 'deleted',
      deleted: true,
      unregistered: true,
      dryRun: false,
    });
  });

  it('rejects non-SubAgent roles without unregistering them', async () => {
    const member = makeAgent('member-1', AgentRole.Member);
    register(member);

    const result = await new SubAgentDeleteTool().execute({ agentId: 'member-1' }, ctx);

    expect(result.success).toBe(false);
    expect(AgentRegistry.getInstance().agent('member-1')).toBe(member);
    expect(result.structured).toMatchObject({
      agentId: 'member-1',
      role: AgentRole.Member,
      status: 'wrong_role',
      deleted: false,
    });
  });

  it('removes stale destroyed SubAgents from the registry idempotently', async () => {
    register(makeAgent('subagent-dead', AgentRole.SubAgent, AgentState.Destroyed));

    const result = await new SubAgentDeleteTool().execute({ agentId: 'subagent-dead' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('already destroyed');
    expect(AgentRegistry.getInstance().agent('subagent-dead')).toBeUndefined();
    expect(result.structured).toMatchObject({
      agentId: 'subagent-dead',
      status: 'already_destroyed',
      deleted: false,
      unregistered: true,
    });
  });

  it('returns structured not-found feedback', async () => {
    const result = await new SubAgentDeleteTool().execute({ agentId: 'missing-subagent' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('not found');
    expect(result.structured).toMatchObject({
      agentId: 'missing-subagent',
      status: 'not_found',
      deleted: false,
    });
  });

  it('rejects malformed direct parameters before registry access', async () => {
    const result = await new SubAgentDeleteTool().execute({
      agentId: 'subagent-1',
      dry_run: 'yes',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('dry_run must be a boolean');
  });
});
