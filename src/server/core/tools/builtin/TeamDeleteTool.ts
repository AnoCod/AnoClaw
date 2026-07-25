import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  InternalV3OrganizationApiAdapter,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';
import {
  optionalBoolean,
  organizationToolFailure,
  requiredString,
} from '../v3/V3OrganizationToolSupport.js';

export class TeamDeleteTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Archives a persistent v3 Team.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'TeamDelete'; }

  description(): string {
    return 'Archive a persistent Team. Remove active memberships first.';
  }

  prompt(): string {
    return 'TeamDelete is an archive operation. It never deletes the Team event history.';
  }

  riskLevel(): RiskLevel { return RiskLevel.High; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        force: { type: 'boolean' },
      },
      required: ['teamId'],
      additionalProperties: false,
    };
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    try {
      const teamId = requiredString(params.teamId, 'teamId', 200);
      const result = await this.api.archiveTeam(
        teamId,
        optionalBoolean(params.force, 'force') ?? false,
      );
      return this.makeResult(`Persistent Team "${result.data.name}" archived.`, {
        structured: {
          team: result.data,
          revision: result.revision,
          operation: 'archive',
        },
      });
    } catch (error) {
      return organizationToolFailure(error);
    }
  }
}
