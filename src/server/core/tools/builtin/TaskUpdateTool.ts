import type { TaskPriority, TaskStatus } from '../../../../shared/types/v3/index.js';
import { TaskRunTransitionValidator } from '../../v3/orchestration/TaskRunTransitionValidator.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  appendCommand,
  assertCanCoordinate,
  assertTaskInTeam,
  assertTaskVersion,
  booleanValue,
  optionalText,
  requiredText,
  requireScopedState,
  responsibleTaskTeamId,
  stringList,
  v3WorkToolDependencies,
  V3WorkToolError,
  withWorkRevisionRetry,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

const PRIORITIES = new Set<TaskPriority>(['low', 'normal', 'high', 'critical']);
const MODEL_EDITABLE_STATUSES = new Set<TaskStatus>(['ready', 'blocked']);
const validator = new TaskRunTransitionValidator();

export class TaskUpdateTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Updates a persistent v3 Task using optimistic Task versioning.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskUpdate'; }
  description(): string {
    return 'Update non-running Task details or move a Task between ready and blocked. Run completion and cancellation are server-owned.';
  }
  prompt(): string {
    return 'Use TaskStop for cancellation. A running AgentLoop, TaskReport, and verification gate own submitted/completed/failed states.';
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        expectedVersion: { type: 'integer', minimum: 1 },
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 20_000 },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 2_000 },
          minItems: 1,
          maxItems: 50,
        },
        status: { type: 'string', enum: ['ready', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
        dependsOn: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          maxItems: 50,
        },
        readOnly: { type: 'boolean' },
        writeScope: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 500 },
          maxItems: 50,
        },
        dueAt: { type: 'string', minLength: 1, maxLength: 100 },
      },
      required: ['taskId', 'expectedVersion'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const taskId = requiredText(params.taskId, 'taskId', 200);
      const expectedVersionRaw = params.expectedVersion;
      if (!Number.isSafeInteger(expectedVersionRaw) || (expectedVersionRaw as number) < 1) {
        throw new V3WorkToolError(
          'validation_failed',
          'expectedVersion must be a positive integer.',
        );
      }
      const expectedVersion = expectedVersionRaw as number;
      const status = optionalText(params.status, 'status', 30) as TaskStatus | undefined;
      if (status && !MODEL_EDITABLE_STATUSES.has(status)) {
        throw new V3WorkToolError(
          'server_owned_status',
          `Task status ${status} is owned by the scheduler, runner, or verification gate.`,
        );
      }
      const priority = optionalText(params.priority, 'priority', 20);
      if (priority && !PRIORITIES.has(priority as TaskPriority)) {
        throw new V3WorkToolError('validation_failed', `Invalid Task priority: ${priority}`);
      }
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
          if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
            throw new V3WorkToolError(
              'task_terminal',
              `Task ${taskId} is terminal and cannot be updated.`,
            );
          }
          const callerOwnsTask = current.assignedAgentId === state.context.agentId;
          if (!callerOwnsTask) {
            assertCanCoordinate(
              state.company,
              responsibleTaskTeamId(current, state.context.teamId),
              state.context.agentId,
            );
          }
          const hasLiveRun = Object.values(projection.runs).some((run) => (
            run.taskId === taskId && (run.status === 'queued' || run.status === 'running')
          ));
          if (hasLiveRun) {
            throw new V3WorkToolError(
              'task_execution_active',
              'A Task with an active Run can only be changed through runner lifecycle events.',
            );
          }
          if (status && status !== current.status) {
            const decision = validator.validateTaskTransition(current, status);
            if (!decision.ok) {
              throw new V3WorkToolError(decision.code, decision.message);
            }
          }
          const requestedDependencies = params.dependsOn !== undefined
            ? stringList(params.dependsOn, 'dependsOn', {
              maxItems: 50,
              maxLength: 200,
            }) ?? []
            : undefined;
          if (requestedDependencies) {
            assertNoDependencyCycle(projection.tasks, taskId, requestedDependencies);
          }
          const requestedReadOnly = params.readOnly === undefined
            ? current.readOnly
            : booleanValue(params.readOnly, current.readOnly);
          const requestedScope = stringList(params.writeScope, 'writeScope', {
            maxItems: 50,
            maxLength: 500,
          });
          const nextScope = requestedScope
            ?? (requestedReadOnly ? [] : current.writeScope.length ? current.writeScope : ['.']);
          if (requestedReadOnly && nextScope.length > 0) {
            throw new V3WorkToolError(
              'invalid_write_scope',
              'A read-only Task cannot declare writeScope.',
            );
          }
          return dependencies.workRepository.updateTask(
            state.context.workId,
            taskId,
            {
              ...(params.subject !== undefined
                ? { title: requiredText(params.subject, 'subject', 200) }
                : {}),
              ...(params.description !== undefined
                ? { description: requiredText(params.description, 'description', 20_000) }
                : {}),
              ...(params.acceptanceCriteria !== undefined
                ? {
                  acceptanceCriteria: stringList(
                    params.acceptanceCriteria,
                    'acceptanceCriteria',
                    { required: true, maxItems: 50, maxLength: 2_000 },
                  ),
                }
                : {}),
              ...(status && status !== current.status ? { status } : {}),
              ...(priority ? { priority: priority as TaskPriority } : {}),
              ...(params.dependsOn !== undefined
                ? { dependsOnTaskIds: requestedDependencies }
                : {}),
              ...(params.readOnly !== undefined ? { readOnly: requestedReadOnly } : {}),
              ...(params.writeScope !== undefined || params.readOnly !== undefined
                ? { writeScope: nextScope }
                : {}),
              ...(params.dueAt !== undefined
                ? { dueAt: requiredText(params.dueAt, 'dueAt', 100) }
                : {}),
            },
            appendCommand(projection, state.context.agentId),
          );
        },
      );
      return this.makeResult(`Task ${task.id} updated to ${task.status} (v${task.version}).`, {
        structured: { task },
      });
    } catch (error) {
      return workToolFailure(error);
    }
  }
}

function assertNoDependencyCycle(
  tasks: Record<string, { dependsOnTaskIds: string[] }>,
  taskId: string,
  requestedDependencies: string[],
): void {
  const visit = (candidateId: string, seen: Set<string>): boolean => {
    if (candidateId === taskId) return true;
    if (seen.has(candidateId)) return false;
    seen.add(candidateId);
    const dependencies = candidateId === taskId
      ? requestedDependencies
      : tasks[candidateId]?.dependsOnTaskIds ?? [];
    return dependencies.some((dependencyId) => visit(dependencyId, seen));
  };
  if (requestedDependencies.some((dependencyId) => visit(dependencyId, new Set()))) {
    throw new V3WorkToolError(
      'dependency_cycle',
      `Updating Task ${taskId} would create a dependency cycle.`,
    );
  }
}
