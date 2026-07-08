import { afterEach, describe, expect, it } from 'vitest';
import { ListEmployeesTool } from '../builtin/ListEmployeesTool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { Agent } from '../../agent/Agent.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'list-employees-session',
  agentId: 'ceo',
  workspace: process.cwd(),
  userConfirmed: true,
};

function makeAgent(
  id: string,
  name: string,
  role: AgentRole,
  parentAgentId: string | null,
  level: number,
  state: AgentState = AgentState.Active,
): Agent {
  return new Agent({
    id,
    name,
    role,
    parentAgentId,
    level,
    teamName: role === AgentRole.MainAgent ? 'Executive' : 'Engineering',
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
    allowedTools: ['Read', 'Grep'],
    enabledSkills: ['code-review'],
    mcpServers: ['local-rag'],
    state,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

function register(...agents: Agent[]): void {
  const registry = AgentRegistry.getInstance();
  for (const agent of agents) registry.registerAgent(agent);
}

describe('ListEmployeesTool', () => {
  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  it('returns a structured org tree and orphaned agents', async () => {
    register(
      makeAgent('ceo', 'CEO', AgentRole.MainAgent, null, 0),
      makeAgent('manager-1', 'Engineering Manager', AgentRole.Manager, 'ceo', 1),
      makeAgent('member-1', 'QA Member', AgentRole.Member, 'manager-1', 2),
      makeAgent('orphan-1', 'Orphaned Member', AgentRole.Member, 'missing-parent', 2),
    );

    const result = await new ListEmployeesTool().execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Organization: 4 total agents');
    expect(result.content).toContain('1 orphaned/unreachable');
    expect(result.content).toContain('id=manager-1');
    expect(result.content).toContain('Orphaned or unreachable agents');
    expect(result.structured).toMatchObject({
      totalAgents: 4,
      activeAgents: 4,
      destroyedAgents: 0,
      hasMainAgent: true,
      rootAgentId: 'ceo',
      health: {
        orphanedCount: 1,
        cycleCount: 0,
        status: 'needs_attention',
      },
      root: {
        id: 'ceo',
        name: 'CEO',
        directReportCount: 1,
        children: [
          {
            id: 'manager-1',
            children: [
              {
                id: 'member-1',
                reportChain: ['ceo', 'manager-1'],
              },
            ],
          },
        ],
      },
      orphanedAgents: [
        {
          id: 'orphan-1',
          parentAgentId: 'missing-parent',
        },
      ],
    });
  });

  it('reports missing roots without throwing', async () => {
    register(makeAgent('member-1', 'Loose Member', AgentRole.Member, null, 0));

    const result = await new ListEmployeesTool().execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('no MainAgent root registered');
    expect(result.structured).toMatchObject({
      hasMainAgent: false,
      rootAgentId: null,
      root: null,
      health: {
        status: 'missing_root',
      },
      orphanedAgents: [
        { id: 'member-1' },
      ],
    });
  });

  it('safely reports circular references instead of recursing forever', async () => {
    register(
      makeAgent('ceo', 'CEO', AgentRole.MainAgent, 'manager-1', 0),
      makeAgent('manager-1', 'Engineering Manager', AgentRole.Manager, 'ceo', 1),
    );

    const result = await new ListEmployeesTool().execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('circular reference');
    expect(result.structured).toMatchObject({
      cycleAgentIds: ['ceo'],
      health: {
        cycleCount: 1,
        status: 'needs_attention',
      },
    });
  });

  it('rejects unexpected direct parameters', async () => {
    const result = await new ListEmployeesTool().execute({ verbose: true }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('does not accept parameters');
  });
});
