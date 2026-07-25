import { describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Team,
  TeamMembership,
} from '../../../../../shared/types/v3/index.js';
import {
  InternalV3OrganizationApiAdapter,
  V3OrganizationApiError,
  type V3InternalApiClient,
} from '../V3OrganizationApiAdapter.js';

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
  capabilities: [],
  enabledSkills: [],
  allowedTools: [],
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

describe('InternalV3OrganizationApiAdapter', () => {
  it('reads the current revision before a persistent Team mutation', async () => {
    const client = queuedClient([
      { statusCode: 200, body: { data: { id: 'company-1' }, revision: 7 } },
      { statusCode: 201, body: { data: team, revision: 8 } },
    ]);
    const api = new InternalV3OrganizationApiAdapter(client);

    await expect(api.createTeam({ name: 'Runtime' })).resolves.toEqual({
      data: team,
      revision: 8,
    });
    expect(client.callInternal).toHaveBeenNthCalledWith(1, 'GET', '/api/v3/company', undefined);
    expect(client.callInternal).toHaveBeenNthCalledWith(2, 'POST', '/api/v3/teams', {
      name: 'Runtime',
      expectedRevision: 7,
    });
  });

  it('creates one Agent followed by its primary Team membership', async () => {
    const client = queuedClient([
      { statusCode: 200, body: { data: team, revision: 3 } },
      { statusCode: 201, body: { data: agent, revision: 4 } },
      { statusCode: 201, body: { data: membership, revision: 5 } },
    ]);
    const api = new InternalV3OrganizationApiAdapter(client);

    await expect(api.createAgentWithPrimaryMembership(
      team.id,
      { name: agent.name },
      'member',
    )).resolves.toEqual({ agent, membership, revision: 5 });
    expect(client.callInternal).toHaveBeenNthCalledWith(2, 'POST', '/api/v3/agents', {
      name: agent.name,
      expectedRevision: 3,
    });
    expect(client.callInternal).toHaveBeenNthCalledWith(
      3,
      'POST',
      `/api/v3/teams/${team.id}/members`,
      {
        agentId: agent.id,
        role: 'member',
        isPrimary: true,
        expectedRevision: 4,
      },
    );
  });

  it('archives a newly created Agent and returns structured failure when membership fails', async () => {
    const archived = {
      ...agent,
      status: 'archived' as const,
      archivedAt: '2026-07-25T00:00:01.000Z',
    };
    const client = queuedClient([
      { statusCode: 200, body: { data: team, revision: 3 } },
      { statusCode: 201, body: { data: agent, revision: 4 } },
      {
        statusCode: 422,
        body: { error: { code: 'invalid_state', message: 'membership rejected' } },
      },
      { statusCode: 200, body: { data: agent, revision: 4 } },
      { statusCode: 200, body: { data: archived, revision: 5 } },
    ]);
    const api = new InternalV3OrganizationApiAdapter(client);

    const error = await api.createAgentWithPrimaryMembership(
      team.id,
      { name: agent.name },
      'member',
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(V3OrganizationApiError);
    expect((error as V3OrganizationApiError).toStructured()).toMatchObject({
      code: 'agent_membership_failed',
      details: {
        agentId: agent.id,
        rollback: {
          status: 'archived',
          revision: 5,
        },
      },
    });
    expect(client.callInternal).toHaveBeenNthCalledWith(
      5,
      'POST',
      `/api/v3/agents/${agent.id}/archive`,
      {
        reason: 'Primary Team membership creation failed',
        expectedRevision: 4,
      },
    );
  });
});

function queuedClient(
  responses: Array<{ statusCode: number; body: Record<string, unknown> }>,
): V3InternalApiClient & { callInternal: ReturnType<typeof vi.fn> } {
  return {
    callInternal: vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error('No queued API response');
      return response;
    }),
  };
}
