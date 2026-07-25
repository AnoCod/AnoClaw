import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { rootSessionIdFor, stringParam, toolFailure } from '../../coordination/CoordinationToolHelpers.js';

export class TaskGetTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Reads one durable coordination task.';
  name(): string { return 'TaskGet'; }
  description(): string { return 'Get one task including dependencies, owner, progress, result, and evidence.'; }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['taskId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const taskId = stringParam(params.taskId, 'taskId', 200)!;
      const task = CoordinationService.getInstance().getTask(rootSessionIdFor(ctx), taskId);
      if (!task) return this.makeError(`Task not found: ${taskId}`);
      return this.makeResult(`${task.id} [${task.status}] ${task.subject}`, { structured: { task } });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
