import { InterruptController, InterruptReason } from '../../agent/supervision/InterruptController.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  appendCommand,
  assertCanCoordinate,
  assertTaskInTeam,
  optionalText,
  requiredText,
  requireScopedState,
  responsibleTaskTeamId,
  v3WorkToolDependencies,
  V3WorkToolError,
  withWorkRevisionRetry,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

export class TaskStopTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Stops a persistent v3 Task and cascades to its Run, Session, and leases.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskStop'; }
  description(): string {
    return 'Cancel a Team task, stop its active AgentLoop, close its Run Session, and release persistent Workspace leases.';
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.High; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        reason: { type: 'string', maxLength: 1_000 },
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
      const currentTask = state.work.tasks[taskId];
      if (!currentTask) throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
          assertTaskInTeam(
            currentTask,
            state.context.teamId,
            state.company,
            state.context.agentId,
          );
      if (currentTask.assignedAgentId !== state.context.agentId) {
        assertCanCoordinate(
          state.company,
          responsibleTaskTeamId(currentTask, state.context.teamId),
          state.context.agentId,
        );
      }
      if (isTerminal(currentTask.status)) {
        return this.makeResult(`Task ${taskId} is already ${currentTask.status}.`, {
          structured: { task: currentTask },
        });
      }
      const reason = optionalText(params.reason, 'reason', 1_000)
        ?? `Stopped by Agent ${state.context.agentId}`;

      if (dependencies.stopTask) {
        await dependencies.stopTask(state.context.workId, taskId, reason);
        const afterProductionStop = await dependencies.workRepository.getProjection(
          state.context.workId,
        );
        if (!isTerminal(afterProductionStop.tasks[taskId]?.status ?? '')) {
          await fallbackStop(
            dependencies,
            state.context.workId,
            taskId,
            state.context.agentId,
            reason,
          );
        }
      } else {
        await fallbackStop(dependencies, state.context.workId, taskId, state.context.agentId, reason);
      }
      const projection = await dependencies.workRepository.getProjection(state.context.workId);
      const task = projection.tasks[taskId];
      if (!task) throw new V3WorkToolError('task_not_found', `Task not found after stop: ${taskId}`);
      return this.makeResult(`Task ${task.id} cancelled.`, {
        structured: {
          task,
          runs: Object.values(projection.runs).filter((run) => run.taskId === taskId),
          releasedLeases: Object.values(projection.workspaceLeases).filter(
            (lease) => lease.ownerTaskId === taskId && lease.status !== 'active',
          ),
        },
      });
    } catch (error) {
      return workToolFailure(error);
    }
  }
}

async function fallbackStop(
  dependencies: V3WorkToolDependencies,
  workId: string,
  taskId: string,
  agentId: string,
  reason: string,
): Promise<void> {
  await withWorkRevisionRetry(dependencies, workId, agentId, async (projection) => {
    const task = projection.tasks[taskId];
    if (!task) throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
    if (isTerminal(task.status)) return task;
    const activeRun = Object.values(projection.runs)
      .filter((run) => (
        run.taskId === taskId
        && (run.status === 'queued'
          || run.status === 'running'
          || run.status === 'recovery_required')
      ))
      .sort((left, right) => right.attempt - left.attempt)[0];
    if (!activeRun) {
      return dependencies.workRepository.updateTask(
        workId,
        taskId,
        { status: 'cancelled', completedAt: new Date().toISOString() },
        appendCommand(projection, agentId),
      );
    }
    InterruptController.getInstance().requestInterrupt(
      activeRun.sessionId,
      InterruptReason.ParentStop,
    );
    return dependencies.workRepository.finishTaskExecution(
      workId,
      {
        runId: activeRun.id,
        taskStatus: 'cancelled',
        runStatus: activeRun.status === 'recovery_required'
          ? 'recovery_required'
          : 'cancelled',
        terminationReason: 'cancelled',
        error: reason,
        decision: {
          kind: 'recovery',
          decision: 'stop_cascade',
          reason,
          candidateAgentIds: [activeRun.agentId],
          selectedAgentId: activeRun.agentId,
        },
      },
      appendCommand(projection, agentId),
    );
  });
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
