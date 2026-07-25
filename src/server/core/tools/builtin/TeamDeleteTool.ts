import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  booleanParam,
  isRootMainAgent,
  rootSessionIdFor,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import { InterruptController, InterruptReason } from '../../agent/supervision/InterruptController.js';

export class TeamDeleteTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Gracefully or forcibly disbands a collaboration team.';
  name(): string { return 'TeamDelete'; }
  description(): string { return 'Disband a team after work completes, or cancel active work with force=true.'; }
  minRole(): string { return 'Member'; }
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
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const teamId = stringParam(params.teamId, 'teamId', 200)!;
      const force = booleanParam(params.force, false);
      const service = CoordinationService.getInstance();
      const team = service.getTeam(rootSessionId, teamId);
      if (!team) throw new CoordinationError('not_found', `Team not found: ${teamId}`);
      if (team.leaderAgentId !== ctx.agentId && !isRootMainAgent(ctx)) {
        throw new CoordinationError('forbidden', 'Only the team leader or root MainAgent may disband the team');
      }
      const active = service.listTasks(rootSessionId).filter(
        (task) => task.teamId === teamId && !['completed', 'failed', 'cancelled'].includes(task.status),
      );
      if (active.length > 0 && !force) {
        throw new CoordinationError('conflict', `Team has ${active.length} non-terminal task(s)`);
      }
      for (const task of active) {
        if (task.sessionId) InterruptController.getInstance().requestInterrupt(task.sessionId, InterruptReason.ParentStop);
        await service.updateTask(rootSessionId, task.id, {
          status: 'cancelled',
          error: 'Cancelled by forced team disband.',
        }, ctx.agentId);
      }
      const disbanded = await service.disbandTeam(rootSessionId, teamId, ctx.agentId);
      return this.makeResult(`Team "${disbanded.name}" disbanded.`, { structured: { team: disbanded } });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
