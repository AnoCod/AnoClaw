import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  assertTaskInTeam,
  requiredText,
  requireScopedState,
  v3WorkToolDependencies,
  V3WorkToolError,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

export class TaskGetTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Reads one persistent v3 Task in the executing Work and Team.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskGet'; }
  description(): string {
    return 'Get one Team task including its dependencies, assignment, Runs, reports, and verification.';
  }
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
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const taskId = requiredText(params.taskId, 'taskId', 200);
      const task = state.work.tasks[taskId];
      if (!task) throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
      assertTaskInTeam(
        task,
        state.context.teamId,
        state.company,
        state.context.agentId,
      );
      const mission = state.work.missions[task.missionId];
      const runs = Object.values(state.work.runs)
        .filter((run) => run.taskId === task.id)
        .sort((left, right) => left.attempt - right.attempt);
      const reports = Object.values(state.work.taskReports)
        .filter((report) => report.taskId === task.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const verifications = Object.values(state.work.verificationRecords)
        .filter((record) => record.taskId === task.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return this.makeResult(`${task.id} [${task.status}] ${task.title}`, {
        structured: { task, mission, runs, reports, verifications },
      });
    } catch (error) {
      return workToolFailure(error);
    }
  }
}
