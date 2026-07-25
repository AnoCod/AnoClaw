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
} from '../v3/V3OrganizationToolSupport.js';

export class TeamCreateTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Creates a persistent v3 Team.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'TeamCreate'; }

  description(): string {
    return 'Create a persistent Team, optionally nested under another Team.';
  }

  prompt(): string {
    return [
      'Use TeamCreate to create durable organizational capacity.',
      'A Team has a name, optional description, and optional parentTeamId for the Company structure.',
      'Add persistent Agents separately with TeamMemberAdd. Do not model parent Agents or fixed employee levels.',
    ].join('\n');
  }

  riskLevel(): RiskLevel { return RiskLevel.Medium; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', minLength: 1, maxLength: 4000 },
        parentTeamId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['name'],
      additionalProperties: false,
    };
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    try {
      const name = requiredString(params.name, 'name', 120);
      const description = optionalString(params.description, 'description', 4_000);
      const parentTeamId = optionalString(params.parentTeamId, 'parentTeamId', 200);
      const result = await this.api.createTeam({
        name,
        ...(description ? { description } : {}),
        ...(parentTeamId ? { parentTeamId } : {}),
      });
      return this.makeResult(`Persistent Team "${result.data.name}" created.`, {
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
