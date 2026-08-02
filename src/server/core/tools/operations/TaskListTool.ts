import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type { CoordinationTaskStatus } from '../../../../shared/types/coordination.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { rootSessionIdFor, stringParam, toolFailure } from '../../coordination/CoordinationToolHelpers.js';

export class TaskListTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Lists durable multi-agent tasks without mixing in process jobs.';
  name(): string { return 'TaskList'; }
  description(): string { return 'List coordination tasks by team, status, or assignee. Completion notifications are automatic.'; }
  prompt(): string {
    return 'Use Task action="list" at coordination milestones or when investigating blocked work; do not poll.';
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        status: { type: 'string', enum: ['pending', 'claimed', 'running', 'blocked', 'completed', 'failed', 'cancelled'] },
        assigneeAgentId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: [],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const teamId = stringParam(params.teamId, 'teamId', 200, true);
      const status = stringParam(params.status, 'status', 20, true) as CoordinationTaskStatus | undefined;
      const assignee = stringParam(params.assigneeAgentId, 'assigneeAgentId', 200, true);
      const tasks = CoordinationService.getInstance().listTasks(rootSessionId)
        .filter((task) => !teamId || task.teamId === teamId)
        .filter((task) => !status || task.status === status)
        .filter((task) => !assignee || task.assigneeAgentId === assignee)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const lines = tasks.length
        ? tasks.map((task) => {
          const deps = task.dependsOn.length ? ` deps=${task.dependsOn.join(',')}` : '';
          const owner = task.assigneeAgentId ? ` owner=${task.assigneeAgentId}` : '';
          const progress = task.progress !== undefined ? ` progress=${task.progress}%` : '';
          return `${task.id} [${task.status}/${task.priority}/v${task.version}] ${task.subject}${owner}${deps}${progress}${task.blocker ? ` blocker=${task.blocker}` : ''}`;
        })
        : ['No coordination tasks matched.'];
      return this.makeResult(lines.join('\n'), {
        structured: { rootSessionId, tasks },
      });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
