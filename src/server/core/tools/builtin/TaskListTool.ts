import type { TaskStatus } from '../../../../shared/types/v3/index.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  isCompanyMainAgent,
  optionalText,
  requireScopedState,
  v3WorkToolDependencies,
  V3WorkToolError,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

const STATUSES = new Set<TaskStatus>([
  'pending',
  'ready',
  'claimed',
  'running',
  'submitted',
  'verifying',
  'revision_required',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

export class TaskListTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Lists persistent v3 Team tasks without process jobs.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskList'; }
  description(): string {
    return 'List tasks in the executing Work by Team, Mission, status, or assigned Agent. MainAgent can see all Teams.';
  }
  prompt(): string {
    return 'Use TaskList at coordination milestones or when investigating blocked work; never poll it in a loop.';
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        missionId: { type: 'string', minLength: 1, maxLength: 200 },
        status: {
          type: 'string',
          enum: [
            'pending',
            'ready',
            'claimed',
            'running',
            'submitted',
            'verifying',
            'revision_required',
            'blocked',
            'completed',
            'failed',
            'cancelled',
          ],
        },
        assigneeAgentId: { type: 'string', minLength: 1, maxLength: 200 },
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: [],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const missionId = optionalText(params.missionId, 'missionId', 200);
      const status = optionalText(params.status, 'status', 30) as TaskStatus | undefined;
      const assigneeAgentId = optionalText(params.assigneeAgentId, 'assigneeAgentId', 200);
      const requestedTeamId = optionalText(params.teamId, 'teamId', 200);
      const mainAgent = isCompanyMainAgent(state.company, state.context.agentId);
      if (requestedTeamId && requestedTeamId !== state.context.teamId && !mainAgent) {
        throw new V3WorkToolError(
          'forbidden',
          'Only MainAgent may list Tasks belonging to another Team.',
        );
      }
      const teamId = requestedTeamId ?? (mainAgent ? undefined : state.context.teamId);
      if (status && !STATUSES.has(status)) {
        throw new V3WorkToolError('validation_failed', `Invalid Task status: ${status}`);
      }
      const tasks = Object.values(state.work.tasks)
        .filter((task) => !teamId || task.teamId === teamId)
        .filter((task) => !missionId || task.missionId === missionId)
        .filter((task) => !status || task.status === status)
        .filter((task) => !assigneeAgentId || task.assignedAgentId === assigneeAgentId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const lines = tasks.length
        ? tasks.map((task) => {
          const dependenciesText = task.dependsOnTaskIds.length
            ? ` deps=${task.dependsOnTaskIds.join(',')}`
            : '';
          const owner = task.assignedAgentId ? ` owner=${task.assignedAgentId}` : '';
          return `${task.id} [${task.status}/${task.priority}] ${task.title}${owner}${dependenciesText}`;
        })
        : ['No persistent Team tasks matched.'];
      return this.makeResult(lines.join('\n'), {
        structured: {
          workId: state.context.workId,
          ...(teamId ? { teamId } : {}),
          tasks,
        },
      });
    } catch (error) {
      return workToolFailure(error);
    }
  }
}
