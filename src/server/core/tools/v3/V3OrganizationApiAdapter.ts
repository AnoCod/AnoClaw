import type {
  Agent,
  Team,
  TeamMembership,
  TeamMembershipRole,
} from '../../../../shared/types/v3/index.js';
import type { Revisioned } from '../../../api/v3/HttpContract.js';
import { ApiServer } from '../../../gateway/ApiServer.js';

type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface V3InternalApiClient {
  callInternal(
    method: ApiMethod,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }>;
}

export interface NewPersistentAgent {
  name: string;
  description?: string;
  instructions?: string;
  provider?: string;
  model?: string;
  credentialRef?: string;
  capabilities?: string[];
  enabledSkills?: string[];
  allowedTools?: string[];
}

export interface V3OrganizationApi {
  listTeams(): Promise<Revisioned<Team[]>>;
  getTeam(teamId: string): Promise<Revisioned<Team>>;
  createTeam(input: {
    name: string;
    description?: string;
    parentTeamId?: string;
  }): Promise<Revisioned<Team>>;
  updateTeam(
    teamId: string,
    input: { name?: string; description?: string; parentTeamId?: string },
  ): Promise<Revisioned<Team>>;
  archiveTeam(teamId: string, force?: boolean): Promise<Revisioned<Team>>;
  listTeamMembers(teamId: string): Promise<Revisioned<TeamMembership[]>>;
  addTeamMember(
    teamId: string,
    input: { agentId: string; role: TeamMembershipRole; isPrimary: boolean },
  ): Promise<Revisioned<TeamMembership>>;
  updateTeamMember(
    teamId: string,
    input: {
      membershipId?: string;
      agentId?: string;
      role?: TeamMembershipRole;
      isPrimary?: boolean;
    },
  ): Promise<Revisioned<TeamMembership>>;
  removeTeamMember(
    teamId: string,
    input: { membershipId?: string; agentId?: string; force?: boolean },
  ): Promise<Revisioned<TeamMembership>>;
  listAgents(): Promise<Revisioned<Agent[]>>;
  getAgent(agentId: string): Promise<Revisioned<Agent>>;
  createAgentWithPrimaryMembership(
    teamId: string,
    input: NewPersistentAgent,
    role: TeamMembershipRole,
  ): Promise<{
    agent: Agent;
    membership: TeamMembership;
    revision: number;
  }>;
}

export class V3OrganizationApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'V3OrganizationApiError';
  }

  toStructured(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

class ApiServerInternalClient implements V3InternalApiClient {
  callInternal(
    method: ApiMethod,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    return ApiServer.getInstance().callInternal(method, path, body);
  }
}

/**
 * Typed organization adapter over AnoClaw's real /api/v3 routes.
 *
 * Every mutation obtains a current company-stream revision from the resource
 * read immediately preceding it. A single revision-conflict retry refreshes
 * the company cursor before retrying the same idempotent internal request.
 */
export class InternalV3OrganizationApiAdapter implements V3OrganizationApi {
  constructor(private readonly client: V3InternalApiClient = new ApiServerInternalClient()) {}

  listTeams(): Promise<Revisioned<Team[]>> {
    return this.read<Team[]>('/api/v3/teams');
  }

  getTeam(teamId: string): Promise<Revisioned<Team>> {
    return this.read<Team>(`/api/v3/teams/${encodeURIComponent(teamId)}`);
  }

  async createTeam(input: {
    name: string;
    description?: string;
    parentTeamId?: string;
  }): Promise<Revisioned<Team>> {
    const revision = await this.currentRevision();
    return this.mutate<Team>('POST', '/api/v3/teams', input, revision);
  }

  async updateTeam(
    teamId: string,
    input: { name?: string; description?: string; parentTeamId?: string },
  ): Promise<Revisioned<Team>> {
    const current = await this.getTeam(teamId);
    return this.mutate<Team>(
      'PATCH',
      `/api/v3/teams/${encodeURIComponent(teamId)}`,
      input,
      current.revision,
    );
  }

  async archiveTeam(teamId: string, force = false): Promise<Revisioned<Team>> {
    const current = await this.getTeam(teamId);
    return this.mutate<Team>(
      'POST',
      `/api/v3/teams/${encodeURIComponent(teamId)}/archive`,
      { force },
      current.revision,
    );
  }

  listTeamMembers(teamId: string): Promise<Revisioned<TeamMembership[]>> {
    return this.read<TeamMembership[]>(
      `/api/v3/teams/${encodeURIComponent(teamId)}/members`,
    );
  }

  async addTeamMember(
    teamId: string,
    input: { agentId: string; role: TeamMembershipRole; isPrimary: boolean },
  ): Promise<Revisioned<TeamMembership>> {
    const current = await this.getTeam(teamId);
    return this.mutate<TeamMembership>(
      'POST',
      `/api/v3/teams/${encodeURIComponent(teamId)}/members`,
      input,
      current.revision,
    );
  }

  async updateTeamMember(
    teamId: string,
    input: {
      membershipId?: string;
      agentId?: string;
      role?: TeamMembershipRole;
      isPrimary?: boolean;
    },
  ): Promise<Revisioned<TeamMembership>> {
    const current = await this.listTeamMembers(teamId);
    return this.mutate<TeamMembership>(
      'PATCH',
      `/api/v3/teams/${encodeURIComponent(teamId)}/members`,
      input,
      current.revision,
    );
  }

  async removeTeamMember(
    teamId: string,
    input: { membershipId?: string; agentId?: string; force?: boolean },
  ): Promise<Revisioned<TeamMembership>> {
    const current = await this.listTeamMembers(teamId);
    return this.mutate<TeamMembership>(
      'DELETE',
      `/api/v3/teams/${encodeURIComponent(teamId)}/members`,
      input,
      current.revision,
    );
  }

  listAgents(): Promise<Revisioned<Agent[]>> {
    return this.read<Agent[]>('/api/v3/agents');
  }

  getAgent(agentId: string): Promise<Revisioned<Agent>> {
    return this.read<Agent>(`/api/v3/agents/${encodeURIComponent(agentId)}`);
  }

  async createAgentWithPrimaryMembership(
    teamId: string,
    input: NewPersistentAgent,
    role: TeamMembershipRole,
  ): Promise<{ agent: Agent; membership: TeamMembership; revision: number }> {
    const team = await this.getTeam(teamId);
    if (team.data.archivedAt) {
      throw new V3OrganizationApiError(
        'team_archived',
        `Cannot add an Agent to archived Team ${teamId}.`,
        422,
        { teamId },
      );
    }

    const created = await this.mutate<Agent>(
      'POST',
      '/api/v3/agents',
      { ...input },
      team.revision,
    );
    try {
      const membership = await this.mutate<TeamMembership>(
        'POST',
        `/api/v3/teams/${encodeURIComponent(teamId)}/members`,
        {
          agentId: created.data.id,
          role,
          isPrimary: true,
        },
        created.revision,
      );
      return {
        agent: created.data,
        membership: membership.data,
        revision: membership.revision,
      };
    } catch (membershipError) {
      let rollback: Record<string, unknown>;
      try {
        const current = await this.getAgent(created.data.id);
        const archived = await this.mutate<Agent>(
          'POST',
          `/api/v3/agents/${encodeURIComponent(created.data.id)}/archive`,
          { reason: 'Primary Team membership creation failed' },
          current.revision,
        );
        rollback = {
          status: 'archived',
          agentId: archived.data.id,
          revision: archived.revision,
        };
      } catch (rollbackError) {
        rollback = {
          status: 'failed',
          error: structuredError(rollbackError),
        };
      }
      throw new V3OrganizationApiError(
        'agent_membership_failed',
        `Agent ${created.data.id} could not be joined to Team ${teamId}.`,
        errorStatus(membershipError),
        {
          teamId,
          agentId: created.data.id,
          membershipError: structuredError(membershipError),
          rollback,
        },
      );
    }
  }

  private async currentRevision(): Promise<number> {
    const company = await this.read<unknown>('/api/v3/company');
    if (company.data == null) {
      throw new V3OrganizationApiError(
        'company_not_initialized',
        'The persistent v3 Company has not been initialized.',
        409,
      );
    }
    return company.revision;
  }

  private async read<T>(path: string): Promise<Revisioned<T>> {
    return this.request<T>('GET', path);
  }

  private async mutate<T>(
    method: Exclude<ApiMethod, 'GET'>,
    path: string,
    input: Record<string, unknown>,
    expectedRevision: number,
  ): Promise<Revisioned<T>> {
    try {
      return await this.request<T>(method, path, { ...input, expectedRevision });
    } catch (error) {
      if (!(error instanceof V3OrganizationApiError) || error.code !== 'revision_conflict') {
        throw error;
      }
      const refreshedRevision = await this.currentRevision();
      return this.request<T>(method, path, {
        ...input,
        expectedRevision: refreshedRevision,
      });
    }
  }

  private async request<T>(
    method: ApiMethod,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Revisioned<T>> {
    const response = await this.client.callInternal(method, path, body);
    if (response.statusCode >= 400) {
      throw apiError(response.statusCode, response.body);
    }
    const revision = response.body.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0 || !('data' in response.body)) {
      throw new V3OrganizationApiError(
        'invalid_api_response',
        `Invalid response from ${method} ${path}.`,
        500,
        { response: response.body },
      );
    }
    return {
      data: response.body.data as T,
      revision: revision as number,
    };
  }
}

function apiError(statusCode: number, body: Record<string, unknown>): V3OrganizationApiError {
  const envelope = isRecord(body.error) ? body.error : {};
  const code = typeof envelope.code === 'string' ? envelope.code : 'api_error';
  const message = typeof envelope.message === 'string'
    ? envelope.message
    : `Persistent organization API returned ${statusCode}.`;
  return new V3OrganizationApiError(code, message, statusCode, envelope.details);
}

function structuredError(error: unknown): Record<string, unknown> {
  if (error instanceof V3OrganizationApiError) return error.toStructured();
  return {
    code: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorStatus(error: unknown): number {
  return error instanceof V3OrganizationApiError ? error.statusCode : 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
