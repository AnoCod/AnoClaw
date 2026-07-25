import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  booleanParam,
  requireActiveAgent,
  rootSessionIdFor,
  stringArrayParam,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { SettingsManager } from '../../../infra/storage/SettingsManager.js';

export class TeamCreateTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Creates the single active collaboration team for the current root session.';
  name(): string { return 'TeamCreate'; }
  description(): string {
    return 'Create a dynamic team from existing active employees without changing the organization tree.';
  }
  prompt(): string {
    return [
      'Use TeamCreate when at least two independent tasks benefit from parallel execution.',
      'Invite existing active employee IDs. The creator becomes the team leader.',
      'A root session can have only one active team; reuse it instead of creating another.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Medium; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        purpose: { type: 'string', minLength: 1, maxLength: 4000 },
        memberAgentIds: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          maxItems: 8,
        },
        autoDisband: { type: 'boolean' },
        autoCreated: { type: 'boolean' },
      },
      required: ['name', 'purpose', 'memberAgentIds'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      requireActiveAgent(ctx.agentId);
      const members = stringArrayParam(params.memberAgentIds, 'memberAgentIds', { maxItems: 8, maxLength: 200 });
      const maxMembers = SettingsManager.getInstance().get<number>('coordination.maxTeamMembers', 8);
      if (new Set([ctx.agentId, ...members]).size > maxMembers) {
        return this.makeError(`Team exceeds configured member limit (${maxMembers})`);
      }
      for (const agentId of members) requireActiveAgent(agentId);
      const team = await CoordinationService.getInstance().createTeam({
        rootSessionId: rootSessionIdFor(ctx),
        name: stringParam(params.name, 'name', 120)!,
        purpose: stringParam(params.purpose, 'purpose', 4_000)!,
        leaderAgentId: ctx.agentId,
        memberAgentIds: members,
        createdByAgentId: ctx.agentId,
        autoCreated: booleanParam(params.autoCreated, false),
        autoDisband: booleanParam(params.autoDisband, true),
      });
      return this.makeResult(`Team "${team.name}" created with ${team.memberAgentIds.length} member(s).`, {
        structured: { team },
      });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
