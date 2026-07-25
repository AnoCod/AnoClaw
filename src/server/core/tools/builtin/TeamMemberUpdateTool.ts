import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  InternalV3OrganizationApiAdapter,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';
import {
  membershipRole,
  optionalBoolean,
  optionalString,
  organizationToolFailure,
  requiredString,
  V3OrganizationToolInputError,
} from '../v3/V3OrganizationToolSupport.js';

export class TeamMemberUpdateTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Updates a persistent Team membership.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'TeamMemberUpdate'; }

  description(): string {
    return 'Update the Team-local leader/member designation or primary membership flag.';
  }

  riskLevel(): RiskLevel { return RiskLevel.Medium; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        membershipId: { type: 'string', minLength: 1, maxLength: 200 },
        agentId: { type: 'string', minLength: 1, maxLength: 200 },
        membershipRole: { type: 'string', enum: ['leader', 'member'] },
        isPrimary: { type: 'boolean' },
      },
      required: ['teamId'],
      oneOf: [
        { required: ['membershipId'], not: { required: ['agentId'] } },
        { required: ['agentId'], not: { required: ['membershipId'] } },
      ],
      anyOf: [
        { required: ['membershipRole'] },
        { required: ['isPrimary'] },
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
      if ((!membershipId && !agentId) || (membershipId && agentId)) {
        throw new V3OrganizationToolInputError(
          'Provide exactly one of membershipId or agentId',
          { fields: ['membershipId', 'agentId'] },
        );
      }
      const isPrimary = optionalBoolean(params.isPrimary, 'isPrimary');
      const role = params.membershipRole === undefined
        ? undefined
        : membershipRole(params.membershipRole);
      if (role === undefined && isPrimary === undefined) {
        throw new V3OrganizationToolInputError(
          'TeamMemberUpdate requires membershipRole or isPrimary',
          { fields: ['membershipRole', 'isPrimary'] },
        );
      }
      const result = await this.api.updateTeamMember(teamId, {
        ...(membershipId ? { membershipId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(role ? { role } : {}),
        ...(isPrimary === undefined ? {} : { isPrimary }),
      });
      return this.makeResult(`Persistent Team membership ${result.data.id} updated.`, {
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
