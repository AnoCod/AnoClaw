import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  InternalV3OrganizationApiAdapter,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';
import {
  optionalBoolean,
  optionalString,
  organizationToolFailure,
  requiredString,
  V3OrganizationToolInputError,
} from '../v3/V3OrganizationToolSupport.js';

export class TeamMemberRemoveTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Removes a persistent Team membership.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'TeamMemberRemove'; }

  description(): string {
    return 'Remove an Agent membership from a persistent Team without deleting the Agent.';
  }

  riskLevel(): RiskLevel { return RiskLevel.High; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        membershipId: { type: 'string', minLength: 1, maxLength: 200 },
        agentId: { type: 'string', minLength: 1, maxLength: 200 },
        force: { type: 'boolean' },
      },
      required: ['teamId'],
      oneOf: [
        { required: ['membershipId'], not: { required: ['agentId'] } },
        { required: ['agentId'], not: { required: ['membershipId'] } },
      ],
      additionalProperties: false,
    };
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    try {
      const teamId = requiredString(params.teamId, 'teamId', 200);
      const membershipId = optionalString(params.membershipId, 'membershipId', 200);
      const agentId = optionalString(params.agentId, 'agentId', 200);
      const force = optionalBoolean(params.force, 'force') ?? false;
      if ((!membershipId && !agentId) || (membershipId && agentId)) {
        throw new V3OrganizationToolInputError(
          'Provide exactly one of membershipId or agentId',
          { fields: ['membershipId', 'agentId'] },
        );
      }
      const result = await this.api.removeTeamMember(teamId, {
        ...(membershipId ? { membershipId } : {}),
        ...(agentId ? { agentId } : {}),
        force,
      });
      return this.makeResult(`Persistent Team membership ${result.data.id} removed.`, {
        structured: {
          membership: result.data,
          revision: result.revision,
        },
      });
    } catch (error) {
      return organizationToolFailure(error);
    }
  }
}
