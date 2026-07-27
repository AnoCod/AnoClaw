import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { rootSessionIdFor, stringParam, toolFailure } from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import { InterruptController, InterruptReason } from '../../agent/supervision/InterruptController.js';

export class TaskStopTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Cancels one durable task and cascades stop to its AgentLoop.';
  name(): string { return 'TaskStop'; }
  description(): string { return 'Cancel a coordination task; running work keeps its lease until the AgentLoop stops.'; }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.High; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        reason: { type: 'string', maxLength: 1000 },
      },
      required: ['taskId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const taskId = stringParam(params.taskId, 'taskId', 200)!;
      const reason = stringParam(params.reason, 'reason', 1_000, true) || `Cancelled by ${ctx.agentId}`;
      const service = CoordinationService.getInstance();
      const task = service.getTask(rootSessionId, taskId);
      if (!task) throw new CoordinationError('not_found', `Task not found: ${taskId}`);
      const team = task.teamId ? service.getTeam(rootSessionId, task.teamId) : undefined;
      const authorized = task.creatorAgentId === ctx.agentId
        || task.assigneeAgentId === ctx.agentId
        || team?.leaderAgentId === ctx.agentId;
      if (!authorized) throw new CoordinationError('forbidden', 'Only the creator, assignee, or team leader may stop this task');
      if (isTerminal(task.status)) return this.makeResult(`Task ${task.id} is already ${task.status}.`, { structured: { task } });
      const updated = await service.requestTaskCancellation(rootSessionId, task.id, ctx.agentId, reason);
      if (task.sessionId) {
        InterruptController.getInstance().requestInterruptWhenAvailable(task.sessionId, InterruptReason.ParentStop);
      }
      const message = updated.status === 'running'
        ? `Cancellation requested for running task ${task.id}.`
        : `Task ${task.id} cancelled.`;
      return this.makeResult(message, { structured: { task: updated } });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
