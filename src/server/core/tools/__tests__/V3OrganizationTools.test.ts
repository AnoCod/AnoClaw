import { describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Team,
  TeamMembership,
} from '../../../../shared/types/v3/index.js';
import type { ExecutionContext } from '../Tool.js';
import { AgentListTool } from '../builtin/AgentListTool.js';
import { TeamCreateTool } from '../builtin/TeamCreateTool.js';
import { TeamDeleteTool } from '../builtin/TeamDeleteTool.js';
import { TeamMemberAddTool } from '../builtin/TeamMemberAddTool.js';
import { TeamMemberRemoveTool } from '../builtin/TeamMemberRemoveTool.js';
import { TeamMemberUpdateTool } from '../builtin/TeamMemberUpdateTool.js';
import { TeamStatusTool } from '../builtin/TeamStatusTool.js';
import { TeamUpdateTool } from '../builtin/TeamUpdateTool.js';
import {
  V3OrganizationApiError,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';

const ctx = {} as ExecutionContext;
const team: Team = {
  id: 'team-1',
  companyId: 'company-1',
  name: 'Runtime',
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
};
const agent: Agent = {
  id: 'agent-1',
  companyId: 'company-1',
  name: 'Runtime Agent',
  status: 'active',
  capabilities: ['runtime'],
  enabledSkills: [],
  allowedTools: ['Read'],
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
};
const membership: TeamMembership = {
  id: 'membership-1',
  companyId: 'company-1',
  teamId: team.id,
  agentId: agent.id,
  role: 'member',
  isPrimary: true,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
};

describe('v3 persistent organization tools', () => {
  it('routes Team create, update, status, and archive through the injected v3 API', async () => {
    const api = fakeApi();
    expect((await new TeamCreateTool(api).execute(
      { name: 'Runtime', description: 'Own runtime quality' },
      ctx,
    )).success).toBe(true);
    expect(api.createTeam).toHaveBeenCalledWith({
      name: 'Runtime',
      description: 'Own runtime quality',
    });

    expect((await new TeamUpdateTool(api).execute(
      { teamId: team.id, name: 'Platform' },
      ctx,
    )).success).toBe(true);
    expect(api.updateTeam).toHaveBeenCalledWith(team.id, { name: 'Platform' });

    const status = await new TeamStatusTool(api).execute({ teamId: team.id }, ctx);
    expect(status.success).toBe(true);
    expect(status.structured).toMatchObject({
      teams: [team],
      memberships: [membership],
    });

    const archived = await new TeamDeleteTool(api).execute({ teamId: team.id }, ctx);
    expect(archived.success).toBe(true);
    expect(archived.structured).toMatchObject({ operation: 'archive' });
    expect(api.archiveTeam).toHaveBeenCalledWith(team.id, false);
  });

  it('adds existing Agents and creates new Agents only with primary membership', async () => {
    const api = fakeApi();
    const tool = new TeamMemberAddTool(api);

    const existing = await tool.execute({
      teamId: team.id,
      agentId: agent.id,
      membershipRole: 'member',
      isPrimary: false,
    }, ctx);
    expect(existing.success).toBe(true);
    expect(api.addTeamMember).toHaveBeenCalledWith(team.id, {
      agentId: agent.id,
      role: 'member',
      isPrimary: false,
    });

    const created = await tool.execute({
      teamId: team.id,
      newAgent: {
        name: 'New Agent',
        capabilities: ['testing'],
        allowedTools: ['Read', 'TeamStatus'],
      },
      membershipRole: 'leader',
    }, ctx);
    expect(created.success).toBe(true);
    expect(api.createAgentWithPrimaryMembership).toHaveBeenCalledWith(
      team.id,
      {
        name: 'New Agent',
        capabilities: ['testing'],
        allowedTools: ['Read', 'TeamStatus'],
      },
      'leader',
    );
  });

  it('rejects retired tools on new Agents before touching the persistent API', async () => {
    const api = fakeApi();
    const result = await new TeamMemberAddTool(api).execute({
      teamId: team.id,
      newAgent: {
        name: 'Legacy Agent',
        allowedTools: ['Read', 'HireEmployee', 'SubAgentSpawn'],
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.structured).toMatchObject({
      error: {
        code: 'validation_failed',
        details: {
          retiredTools: ['HireEmployee', 'SubAgentSpawn'],
        },
      },
    });
    expect(api.createAgentWithPrimaryMembership).not.toHaveBeenCalled();
  });

  it('updates and removes membership by stable identifier', async () => {
    const api = fakeApi();
    const updated = await new TeamMemberUpdateTool(api).execute({
      teamId: team.id,
      membershipId: membership.id,
      membershipRole: 'leader',
      isPrimary: true,
    }, ctx);
    expect(updated.success).toBe(true);
    expect(api.updateTeamMember).toHaveBeenCalledWith(team.id, {
      membershipId: membership.id,
      role: 'leader',
      isPrimary: true,
    });

    const removed = await new TeamMemberRemoveTool(api).execute({
      teamId: team.id,
      agentId: agent.id,
    }, ctx);
    expect(removed.success).toBe(true);
    expect(api.removeTeamMember).toHaveBeenCalledWith(team.id, {
      agentId: agent.id,
      force: false,
    });
  });

  it('lists persistent Agents without parent or organization-role fields', async () => {
    const api = fakeApi();
    const result = await new AgentListTool(api).execute({
      teamId: team.id,
      status: 'active',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      agents: [agent],
      memberships: [membership],
    });
    expect(result.content).toContain('agent-1 [active] Runtime Agent');
    expect(result.content).not.toContain('parentAgentId');
  });

  it('returns structured API errors', async () => {
    const api = fakeApi({
      createAgentWithPrimaryMembership: vi.fn(async () => {
        throw new V3OrganizationApiError(
          'agent_membership_failed',
          'membership failed',
          422,
          { rollback: { status: 'archived' } },
        );
      }),
    });
    const result = await new TeamMemberAddTool(api).execute({
      teamId: team.id,
      newAgent: { name: 'Broken Agent' },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.structured).toMatchObject({
      status: 'error',
      error: {
        code: 'agent_membership_failed',
        statusCode: 422,
        details: { rollback: { status: 'archived' } },
      },
    });
  });
});

function fakeApi(overrides: Partial<V3OrganizationApi> = {}): V3OrganizationApi {
  return {
    listTeams: vi.fn(async () => ({ data: [team], revision: 5 })),
    getTeam: vi.fn(async () => ({ data: team, revision: 5 })),
    createTeam: vi.fn(async () => ({ data: team, revision: 5 })),
    updateTeam: vi.fn(async () => ({ data: team, revision: 5 })),
    archiveTeam: vi.fn(async () => ({
      data: { ...team, archivedAt: '2026-07-25T00:00:01.000Z' },
      revision: 5,
    })),
    listTeamMembers: vi.fn(async () => ({ data: [membership], revision: 5 })),
    addTeamMember: vi.fn(async () => ({ data: membership, revision: 5 })),
    updateTeamMember: vi.fn(async () => ({ data: membership, revision: 5 })),
    removeTeamMember: vi.fn(async () => ({
      data: { ...membership, removedAt: '2026-07-25T00:00:01.000Z' },
      revision: 5,
    })),
    listAgents: vi.fn(async () => ({ data: [agent], revision: 5 })),
    getAgent: vi.fn(async () => ({ data: agent, revision: 5 })),
    createAgentWithPrimaryMembership: vi.fn(async () => ({
      agent,
      membership,
      revision: 5,
    })),
    ...overrides,
  };
}
