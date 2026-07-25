import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { integerParam, rootSessionIdFor, stringParam, toolFailure } from '../../coordination/CoordinationToolHelpers.js';

export class TaskClaimTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Atomically claims one ready unowned team task for the current agent.';
  name(): string { return 'TaskClaim'; }
  description(): string { return 'Atomically claim a pending task after its dependencies complete.'; }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        expectedVersion: { type: 'integer', minimum: 1 },
      },
      required: ['taskId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const task = await CoordinationService.getInstance().claimTask(
        rootSessionIdFor(ctx),
        stringParam(params.taskId, 'taskId', 200)!,
        ctx.agentId,
        integerParam(params.expectedVersion, 'expectedVersion', { optional: true, min: 1 }),
      );
      return this.makeResult(`Task ${task.id} claimed by ${ctx.agentId}.`, { structured: { task } });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
