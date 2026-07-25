import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  InternalV3OrganizationApiAdapter,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';
import {
  optionalString,
  organizationToolFailure,
  requiredString,
  V3OrganizationToolInputError,
} from '../v3/V3OrganizationToolSupport.js';

export class TeamUpdateTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Updates a persistent v3 Team or its parent Team.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'TeamUpdate'; }

  description(): string {
    return 'Update a persistent Team name, description, or parent Team.';
  }

  riskLevel(): RiskLevel { return RiskLevel.Medium; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', minLength: 1, maxLength: 4000 },
        parentTeamId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['teamId'],
      anyOf: [
        { required: ['name'] },
        { required: ['description'] },
        { required: ['parentTeamId'] },
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
      const name = optionalString(params.name, 'name', 120);
      const description = optionalString(params.description, 'description', 4_000);
      const parentTeamId = optionalString(params.parentTeamId, 'parentTeamId', 200);
      if (!name && !description && !parentTeamId) {
        throw new V3OrganizationToolInputError(
          'TeamUpdate requires name, description, or parentTeamId',
          { fields: ['name', 'description', 'parentTeamId'] },
        );
      }
      const result = await this.api.updateTeam(teamId, {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(parentTeamId ? { parentTeamId } : {}),
      });
      return this.makeResult(`Persistent Team "${result.data.name}" updated.`, {
        structured: {
          team: result.data,
          revision: result.revision,
        },
      });
    } catch (error) {
      return organizationToolFailure(error);
    }
  }
}
