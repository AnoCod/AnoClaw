import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { rootSessionIdFor, stringParam, toolFailure } from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';

export class TaskStopTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Cancels unfinished task work and interrupts its AgentLoop; it never submits completion.';
  name(): string { return 'TaskStop'; }
  description(): string { return 'Cancel unfinished coordination work; never use this action to submit or complete a task.'; }
  prompt(): string {
    return [
      'Task action="stop" is cancellation only. It never marks a task completed and never submits the worker answer.',
      'A worker finishes normally by returning its final answer and letting the runtime finalize the task.',
    ].join('\n');
  }
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
      if (isTerminal(task.status)) {
        return this.makeResult(`Task ${task.id} is already ${task.status} (v${task.version}); no cancellation was applied.`, {
          structured: { task },
        });
      }
      const updated = await service.requestTaskCancellation(rootSessionId, task.id, ctx.agentId, reason);
      const message = updated.status === 'running'
        ? `Cancellation requested for running task ${task.id} (v${updated.version}); this does not submit or complete the task.`
        : `Task ${task.id} cancelled (v${updated.version}); this does not submit or complete the task.`;
      return this.makeResult(message, { structured: { task: updated } });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
