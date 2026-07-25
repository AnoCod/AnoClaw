import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  activeMembership,
  appendCommand,
  assertCanCoordinate,
  assertTaskInTeam,
  assertTaskVersion,
  nextId,
  optionalInteger,
  requiredText,
  requireScopedState,
  responsibleTaskTeamId,
  v3WorkToolDependencies,
  V3WorkToolError,
  withWorkRevisionRetry,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

export class TaskAssignTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Assigns a persistent v3 Task to an active member of its Team.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskAssign'; }
  description(): string {
    return 'Assign an existing Task to an active member of the responsible persistent Team.';
  }
  prompt(): string {
    return [
      'TaskAssign never creates an Agent or changes the Company structure.',
      'The server-owned scheduler starts the Task when dependencies and capacity permit.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  isAsync(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        targetAgentId: { type: 'string', minLength: 1, maxLength: 200 },
        expectedVersion: { type: 'integer', minimum: 1 },
      },
      required: ['taskId', 'targetAgentId'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const taskId = requiredText(params.taskId, 'taskId', 200);
      const targetAgentId = requiredText(params.targetAgentId, 'targetAgentId', 200);
      const expectedVersion = optionalInteger(params.expectedVersion, 'expectedVersion', 1);
      const target = state.company.agents[targetAgentId];
      if (!target || target.status !== 'active') {
        throw new V3WorkToolError(
          'target_not_active',
          `Active target Agent not found: ${targetAgentId}`,
        );
      }
      const initialTask = state.work.tasks[taskId];
      if (!initialTask) {
        throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
      }
      assertTaskInTeam(
        initialTask,
        state.context.teamId,
        state.company,
        state.context.agentId,
      );
      const taskTeamId = responsibleTaskTeamId(initialTask, state.context.teamId);
      if (!activeMembership(state.company, taskTeamId, targetAgentId)) {
        throw new V3WorkToolError(
          'target_not_in_team',
          `Agent ${targetAgentId} is not an active member of Team ${taskTeamId}.`,
        );
      }
      assertCanCoordinate(state.company, taskTeamId, state.context.agentId);

      const assigned = await withWorkRevisionRetry(
        dependencies,
        state.context.workId,
        state.context.agentId,
        async (projection) => {
          const task = projection.tasks[taskId];
          if (!task) throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
          assertTaskInTeam(
            task,
            state.context.teamId,
            state.company,
            state.context.agentId,
          );
          assertTaskVersion(task, expectedVersion);
          if (['completed', 'failed', 'cancelled'].includes(task.status)) {
            throw new V3WorkToolError(
              'task_terminal',
              `Task ${taskId} is already ${task.status}.`,
            );
          }
          if (task.status === 'running' || task.status === 'submitted' || task.status === 'verifying') {
            throw new V3WorkToolError(
              'task_already_started',
              `Task ${taskId} cannot be reassigned while ${task.status}.`,
            );
          }
          return dependencies.workRepository.updateTask(
            state.context.workId,
            taskId,
            { assignedAgentId: targetAgentId },
            appendCommand(projection, state.context.agentId),
          );
        },
      );
      const queued = await withWorkRevisionRetry(
        dependencies,
        state.context.workId,
        state.context.agentId,
        (projection) => dependencies.workRepository.enqueueCoordinationMessage(
          state.context.workId,
          {
            teamId: taskTeamId,
            taskId: assigned.id,
            senderAgentId: state.context.agentId,
            recipientAgentId: targetAgentId,
            kind: 'task_assignment',
            content: assigned.description ?? assigned.title,
            summary: assigned.title,
            idempotencyKey: `assignment:${assigned.id}:${assigned.version}:${targetAgentId}`,
          },
          appendCommand(projection, state.context.agentId, nextId(dependencies)),
        ),
      );
      return this.makeResult(
        `Task ${assigned.id} assigned to ${targetAgentId}; the scheduler will start it when ready.`,
        { structured: { task: assigned, message: queued } },
      );
    } catch (error) {
      return workToolFailure(error);
    }
  }
}
