import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  booleanParam,
  isRootMainAgent,
  requireActiveAgent,
  rootSessionIdFor,
  stringArrayParam,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import { SettingsManager } from '../../../infra/storage/SettingsManager.js';
import { InterruptController, InterruptReason } from '../../agent/supervision/InterruptController.js';

export class TeamUpdateTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Invites, removes, or transfers leadership of existing team members.';
  name(): string { return 'TeamUpdate'; }
  description(): string { return 'Update the active team without changing persistent org relationships.'; }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Medium; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        addMemberAgentIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 8 },
        removeMemberAgentIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 8 },
        leaderAgentId: { type: 'string', minLength: 1, maxLength: 200 },
        force: { type: 'boolean' },
      },
      required: ['teamId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const teamId = stringParam(params.teamId, 'teamId', 200)!;
      const service = CoordinationService.getInstance();
      const team = service.getTeam(rootSessionId, teamId);
      if (!team) throw new CoordinationError('not_found', `Team not found: ${teamId}`);
      const add = stringArrayParam(params.addMemberAgentIds, 'addMemberAgentIds', { optional: true, maxItems: 8, maxLength: 200 });
      const remove = stringArrayParam(params.removeMemberAgentIds, 'removeMemberAgentIds', { optional: true, maxItems: 8, maxLength: 200 });
      const leaderAgentId = stringParam(params.leaderAgentId, 'leaderAgentId', 200, true);
      for (const agentId of [...add, ...(leaderAgentId ? [leaderAgentId] : [])]) requireActiveAgent(agentId);

      const destructiveChange = remove.length > 0 || !!leaderAgentId;
      const allowedDestructive = team.leaderAgentId === ctx.agentId || isRootMainAgent(ctx)
        || (remove.length === 1 && remove[0] === ctx.agentId && !leaderAgentId);
      if (destructiveChange && !allowedDestructive) {
        throw new CoordinationError('forbidden', 'Only the team leader, root MainAgent, or the leaving member may remove/transfer members');
      }

      const force = booleanParam(params.force, false);
      const activeForRemoved = service.listTasks(rootSessionId).filter(
        (task) => task.teamId === teamId
          && !!task.assigneeAgentId
          && remove.includes(task.assigneeAgentId)
          && !['completed', 'failed', 'cancelled'].includes(task.status),
      );
      if (activeForRemoved.length > 0 && !force) {
        throw new CoordinationError('conflict', `${activeForRemoved.length} active task(s) must finish or force=true must be used`);
      }
      for (const task of activeForRemoved) {
        if (task.sessionId) {
          InterruptController.getInstance().requestInterrupt(task.sessionId, InterruptReason.ParentStop);
        }
        await service.updateTask(rootSessionId, task.id, {
          status: 'cancelled',
          error: 'Cancelled because the assigned member was forcibly removed from the team.',
        }, ctx.agentId);
      }

      const maxMembers = SettingsManager.getInstance().get<number>('coordination.maxTeamMembers', 8);
      const projected = new Set([...team.memberAgentIds, ...add].filter((id) => !remove.includes(id)));
      if (projected.size > maxMembers) throw new CoordinationError('validation', `Team exceeds configured member limit (${maxMembers})`);
      const updated = await service.updateTeam(rootSessionId, teamId, {
        addMemberAgentIds: add,
        removeMemberAgentIds: remove,
        leaderAgentId,
      }, ctx.agentId);
      return this.makeResult(`Team "${updated.name}" updated.`, { structured: { team: updated } });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
