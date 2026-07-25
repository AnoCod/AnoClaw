import type { TaskPriority } from '../../../../shared/types/v3/index.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  appendCommand,
  booleanValue,
  isCompanyMainAgent,
  optionalText,
  requiredText,
  requireScopedState,
  stringList,
  v3WorkToolDependencies,
  V3WorkToolError,
  withWorkRevisionRetry,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

const PRIORITIES = new Set<TaskPriority>(['low', 'normal', 'high', 'critical']);

export class TaskCreateTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Creates a persistent v3 Team task in the current Work and Mission.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskCreate'; }
  description(): string {
    return 'Create one persistent Team task in the current Work. Use MissionCreate first when no Mission exists.';
  }
  prompt(): string {
    return [
      'Create one Task per independently verifiable unit of work.',
      'Declare dependencies and write scope before assignment.',
      'Mutating Tasks default to writeScope ["."]; read-only Tasks cannot declare writeScope.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        missionId: { type: 'string', minLength: 1, maxLength: 200 },
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 20_000 },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 2_000 },
          minItems: 1,
          maxItems: 50,
        },
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
      },
      required: ['subject', 'description', 'acceptanceCriteria'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const requestedMissionId = optionalText(params.missionId, 'missionId', 200);
      const missionId = requestedMissionId
        || state.context.missionId
        || state.work.work?.focusMissionId;
      if (!missionId) {
        throw new V3WorkToolError(
          'mission_required',
          'TaskCreate requires a Mission. Call MissionCreate first or pass missionId.',
        );
      }
      const mission = state.work.missions[missionId];
      const missionTeamId = mission?.teamId ?? state.context.teamId;
      if (
        !mission
        || (
          missionTeamId !== state.context.teamId
          && !isCompanyMainAgent(state.company, state.context.agentId)
        )
      ) {
        throw new V3WorkToolError(
          'mission_outside_team',
          `Mission ${missionId} does not belong to the executing Team.`,
        );
      }
      if (mission.status !== 'active' && mission.status !== 'planned') {
        throw new V3WorkToolError(
          'mission_not_active',
          `Mission ${missionId} cannot accept tasks while ${mission.status}.`,
        );
      }
      const priority = optionalText(params.priority, 'priority', 20) ?? 'normal';
      if (!PRIORITIES.has(priority as TaskPriority)) {
        throw new V3WorkToolError('validation_failed', `Invalid Task priority: ${priority}`);
      }
      const readOnly = booleanValue(params.readOnly, false);
      const declaredScope = stringList(params.writeScope, 'writeScope', {
        maxItems: 50,
        maxLength: 500,
      });
      if (readOnly && (declaredScope?.length ?? 0) > 0) {
        throw new V3WorkToolError(
          'invalid_write_scope',
          'A read-only Task cannot declare writeScope.',
        );
      }
      const writeScope = readOnly ? [] : declaredScope?.length ? declaredScope : ['.'];
      const task = await withWorkRevisionRetry(
        dependencies,
        state.context.workId,
        state.context.agentId,
        async (projection) => {
          const currentMission = projection.missions[missionId];
          const currentMissionTeamId = currentMission?.teamId ?? state.context.teamId;
          if (
            !currentMission
            || (
              currentMissionTeamId !== state.context.teamId
              && !isCompanyMainAgent(state.company, state.context.agentId)
            )
          ) {
            throw new V3WorkToolError(
              'mission_outside_team',
              `Mission ${missionId} is no longer available to the executing Team.`,
            );
          }
          return dependencies.workRepository.createTask(
            state.context.workId,
            {
              missionId,
              title: requiredText(params.subject, 'subject', 200),
              description: requiredText(params.description, 'description', 20_000),
              acceptanceCriteria: stringList(params.acceptanceCriteria, 'acceptanceCriteria', {
                required: true,
                maxItems: 50,
                maxLength: 2_000,
              }),
              priority: priority as TaskPriority,
              teamId: currentMissionTeamId,
              dependsOnTaskIds: stringList(params.dependsOn, 'dependsOn', {
                maxItems: 50,
                maxLength: 200,
              }),
              readOnly,
              writeScope,
            },
            appendCommand(projection, state.context.agentId),
          );
        },
      );
      return this.makeResult(`Task created: ${task.id} [${task.status}] ${task.title}`, {
        structured: { task },
      });
    } catch (error) {
      return workToolFailure(error);
    }
  }
}
