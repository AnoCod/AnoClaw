import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { rootSessionIdFor, stringParam, toolFailure } from '../../coordination/CoordinationToolHelpers.js';

export class TeamStatusTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Returns the current collaboration team and its task/member state.';
  name(): string { return 'TeamStatus'; }
  description(): string { return 'Inspect team membership, lifecycle, tasks, messages, and workspace leases.'; }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { teamId: { type: 'string', minLength: 1, maxLength: 200 } },
      required: [],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const teamId = stringParam(params.teamId, 'teamId', 200, true);
      const snapshot = CoordinationService.getInstance().getSnapshot(rootSessionId);
      const teams = teamId ? snapshot.teams.filter((team) => team.id === teamId) : snapshot.teams;
      if (teamId && teams.length === 0) return this.makeError(`Team not found: ${teamId}`);
      const selectedIds = new Set(teams.map((team) => team.id));
      const tasks = snapshot.tasks.filter((task) => !task.teamId || selectedIds.has(task.teamId));
      const lines = teams.length === 0
        ? ['No team has been created for this root session.']
        : teams.map((team) => `${team.id} [${team.state}] ${team.name} — leader ${team.leaderAgentId}; members ${team.memberAgentIds.join(', ')}`);
      lines.push(`Tasks: ${tasks.length}; queued messages: ${snapshot.messages.filter((message) => message.status === 'queued').length}; leases: ${snapshot.leases.length}`);
      return this.makeResult(lines.join('\n'), {
        structured: { rootSessionId, revision: snapshot.revision, teams, tasks, messages: snapshot.messages, leases: snapshot.leases },
      });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
