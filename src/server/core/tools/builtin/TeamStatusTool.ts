import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type { Team } from '../../../../shared/types/v3/index.js';
import {
  InternalV3OrganizationApiAdapter,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';
import {
  optionalBoolean,
  optionalString,
  organizationToolFailure,
} from '../v3/V3OrganizationToolSupport.js';

export class TeamStatusTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Lists persistent v3 Teams and memberships.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'TeamStatus'; }

  description(): string {
    return 'Inspect persistent Team records and their active memberships.';
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  isConcurrencySafe(): boolean { return true; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        includeArchived: { type: 'boolean' },
      },
      additionalProperties: false,
    };
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    try {
      const teamId = optionalString(params.teamId, 'teamId', 200);
      const includeArchived = optionalBoolean(params.includeArchived, 'includeArchived') ?? false;
      const teamsResult = teamId
        ? await this.api.getTeam(teamId)
        : await this.api.listTeams();
      const rawTeams = Array.isArray(teamsResult.data)
        ? teamsResult.data
        : [teamsResult.data];
      const teams = includeArchived
        ? rawTeams
        : rawTeams.filter((team) => !team.archivedAt);
      const membershipResults = await Promise.all(
        teams.map((team) => this.api.listTeamMembers(team.id)),
      );
      const memberships = membershipResults.flatMap((result) => result.data);
      const membershipsByTeam = new Map<string, typeof memberships>();
      for (const membership of memberships) {
        const existing = membershipsByTeam.get(membership.teamId) ?? [];
        existing.push(membership);
        membershipsByTeam.set(membership.teamId, existing);
      }
      const lines = teams.length === 0
        ? ['No persistent Teams found.']
        : teams.map((team) => formatTeam(team, membershipsByTeam.get(team.id) ?? []));
      return this.makeResult(lines.join('\n'), {
        structured: {
          teams,
          memberships,
          revision: Math.max(
            teamsResult.revision,
            ...membershipResults.map((result) => result.revision),
          ),
        },
      });
    } catch (error) {
      return organizationToolFailure(error);
    }
  }
}

function formatTeam(
  team: Team,
  memberships: Array<{ role: string; agentId: string }>,
): string {
  const state = team.archivedAt ? `archived ${team.archivedAt}` : 'active';
  const members = memberships.length === 0
    ? 'no members'
    : memberships.map((membership) => `${membership.agentId} (${membership.role})`).join(', ');
  return `${team.id} [${state}] ${team.name} — ${members}`;
}
