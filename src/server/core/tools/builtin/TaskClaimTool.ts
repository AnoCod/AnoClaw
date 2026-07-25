import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  appendCommand,
  assertTaskInTeam,
  assertTaskVersion,
  optionalInteger,
  requiredText,
  requireScopedState,
  v3WorkToolDependencies,
  V3WorkToolError,
  withWorkRevisionRetry,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

export class TaskClaimTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Atomically reserves one ready persistent Team task for the current Agent.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskClaim'; }
  description(): string {
    return 'Atomically reserve a ready Team task for the current Agent; the scheduler owns Run creation and execution claiming.';
  }
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
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const taskId = requiredText(params.taskId, 'taskId', 200);
      const expectedVersion = optionalInteger(params.expectedVersion, 'expectedVersion', 1);
      const task = await withWorkRevisionRetry(
        dependencies,
        state.context.workId,
        state.context.agentId,
        async (projection) => {
          const current = projection.tasks[taskId];
          if (!current) throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
          assertTaskInTeam(
            current,
            state.context.teamId,
            state.company,
            state.context.agentId,
          );
          assertTaskVersion(current, expectedVersion);
          if (current.status !== 'ready') {
            throw new V3WorkToolError(
              'task_not_ready',
              `Task ${taskId} cannot be claimed while ${current.status}.`,
            );
          }
          const incompleteDependency = current.dependsOnTaskIds.find(
            (dependencyId) => projection.tasks[dependencyId]?.status !== 'completed',
          );
          if (incompleteDependency) {
            throw new V3WorkToolError(
              'dependency_incomplete',
              `Task ${taskId} is blocked by ${incompleteDependency}.`,
            );
          }
          if (
            current.assignedAgentId
            && current.assignedAgentId !== state.context.agentId
          ) {
            throw new V3WorkToolError(
              'claim_conflict',
              `Task ${taskId} is already reserved for Agent ${current.assignedAgentId}.`,
            );
          }
          if (current.assignedAgentId === state.context.agentId) return current;
          return dependencies.workRepository.updateTask(
            state.context.workId,
            taskId,
            { assignedAgentId: state.context.agentId },
            appendCommand(projection, state.context.agentId),
          );
        },
      );
      return this.makeResult(
        `Task ${task.id} reserved for ${state.context.agentId}; the scheduler will claim its Run.`,
        { structured: { task, reservation: 'scheduler_pending' } },
      );
    } catch (error) {
      return workToolFailure(error);
    }
  }
}
