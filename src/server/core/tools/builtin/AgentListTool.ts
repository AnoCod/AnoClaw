import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type { AgentStatus } from '../../../../shared/types/v3/index.js';
import {
  InternalV3OrganizationApiAdapter,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';
import {
  optionalString,
  organizationToolFailure,
  V3OrganizationToolInputError,
} from '../v3/V3OrganizationToolSupport.js';

export class AgentListTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Lists persistent v3 Agents, optionally scoped to a Team.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'AgentList'; }

  description(): string {
    return 'List persistent Agents and their Team memberships without organization hierarchy metadata.';
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  isConcurrencySafe(): boolean { return true; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        status: { type: 'string', enum: ['active', 'paused', 'archived'] },
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
      const status = parseStatus(params.status);
      const agentsResult = await this.api.listAgents();
      const membershipResult = teamId
        ? await this.api.listTeamMembers(teamId)
        : undefined;
      const teamAgentIds = membershipResult
        ? new Set(membershipResult.data.map((membership) => membership.agentId))
        : undefined;
      const agents = agentsResult.data.filter(
        (agent) => (!teamAgentIds || teamAgentIds.has(agent.id))
          && (!status || agent.status === status),
      );
      const memberships = membershipResult?.data ?? [];
      const lines = agents.length === 0
        ? ['No persistent Agents matched.']
        : agents.map((agent) => {
          const teamRoles = memberships
            .filter((membership) => membership.agentId === agent.id)
            .map((membership) => `${membership.teamId}:${membership.role}`)
            .join(', ');
          return `${agent.id} [${agent.status}] ${agent.name}${teamRoles ? ` — ${teamRoles}` : ''}`;
        });
      return this.makeResult(lines.join('\n'), {
        structured: {
          agents,
          ...(teamId ? { teamId, memberships } : {}),
          revision: Math.max(
            agentsResult.revision,
            membershipResult?.revision ?? 0,
          ),
        },
      });
    } catch (error) {
      return organizationToolFailure(error);
    }
  }
}

function parseStatus(value: unknown): AgentStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const status = optionalString(value, 'status', 20);
  if (status === 'active' || status === 'paused' || status === 'archived') return status;
  throw new V3OrganizationToolInputError(
    'status must be active, paused, or archived',
    { field: 'status' },
  );
}
