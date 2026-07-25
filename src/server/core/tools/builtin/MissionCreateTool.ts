import type { Mission, WorkPriority } from '../../../../shared/types/v3/index.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  appendCommand,
  assertCanCoordinate,
  booleanValue,
  isCompanyMainAgent,
  optionalInteger,
  optionalText,
  requiredText,
  requireScopedState,
  stringList,
  v3WorkToolDependencies,
  withWorkRevisionRetry,
  workToolFailure,
  type V3WorkToolDependencies,
  V3WorkToolError,
} from '../v3/V3WorkToolSupport.js';

const PRIORITIES = new Set<WorkPriority>(['low', 'normal', 'high', 'critical']);

export class MissionCreateTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Creates a persistent v3 Mission for a Team inside the current Work.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'MissionCreate'; }
  description(): string {
    return 'Create the persistent Mission that groups related Team tasks in the current Work.';
  }
  prompt(): string {
    return 'Create a Mission before TaskCreate. MainAgent should select the responsible Team with teamId; other Agents remain scoped to their executing Team.';
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        objective: { type: 'string', minLength: 1, maxLength: 20_000 },
        acceptanceCriteria: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 2_000 },
          minItems: 1,
          maxItems: 50,
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
        verificationMode: {
          type: 'string',
          enum: ['automatic', 'independent_agent', 'user'],
        },
        reviewerAgentId: { type: 'string', minLength: 1, maxLength: 200 },
        requireDifferentAgent: { type: 'boolean' },
        maxRevisionAttempts: { type: 'integer', minimum: 0, maximum: 10 },
        requiredEvidence: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 500 },
          maxItems: 50,
        },
        teamId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Responsible Team. MainAgent may select any active Team.',
        },
      },
      required: ['title', 'objective', 'acceptanceCriteria'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const requestedTeamId = optionalText(params.teamId, 'teamId', 200);
      const teamId = requestedTeamId ?? state.context.teamId;
      const team = state.company.teams[teamId];
      if (!team || team.archivedAt) {
        throw new V3WorkToolError('team_not_found', `Active Team not found: ${teamId}`);
      }
      if (
        teamId !== state.context.teamId
        && !isCompanyMainAgent(state.company, state.context.agentId)
      ) {
        throw new V3WorkToolError(
          'forbidden',
          'Only MainAgent may create a Mission for another Team.',
        );
      }
      assertCanCoordinate(state.company, teamId, state.context.agentId);
      const priority = optionalText(params.priority, 'priority', 20) ?? 'normal';
      if (!PRIORITIES.has(priority as WorkPriority)) {
        throw new V3WorkToolError('validation_failed', `Invalid Mission priority: ${priority}`);
      }
      const mode = optionalText(params.verificationMode, 'verificationMode', 30) ?? 'automatic';
      if (!['automatic', 'independent_agent', 'user'].includes(mode)) {
        throw new V3WorkToolError('validation_failed', `Invalid verificationMode: ${mode}`);
      }
      const reviewerAgentId = optionalText(params.reviewerAgentId, 'reviewerAgentId', 200);
      if (mode === 'independent_agent' && !reviewerAgentId) {
        throw new V3WorkToolError(
          'validation_failed',
          'reviewerAgentId is required for independent_agent verification.',
        );
      }
      if (reviewerAgentId) {
        const reviewer = state.company.agents[reviewerAgentId];
        if (
          !reviewer
          || reviewer.status !== 'active'
          || !Object.values(state.company.memberships).some((membership) => (
            membership.teamId === teamId
            && membership.agentId === reviewerAgentId
            && !membership.removedAt
          ))
        ) {
          throw new V3WorkToolError(
            'reviewer_not_in_team',
            `Reviewer ${reviewerAgentId} is not an active member of the executing Team.`,
          );
        }
      }

      const mission = await withWorkRevisionRetry(
        dependencies,
        state.context.workId,
        state.context.agentId,
        (projection) => dependencies.workRepository.createMission(
          state.context.workId,
          {
            title: requiredText(params.title, 'title', 200),
            objective: requiredText(params.objective, 'objective', 20_000),
            acceptanceCriteria: stringList(params.acceptanceCriteria, 'acceptanceCriteria', {
              required: true,
              maxItems: 50,
              maxLength: 2_000,
            }),
            priority: priority as WorkPriority,
            verificationPolicy: {
              mode: mode as Mission['verificationPolicy']['mode'],
              ...(reviewerAgentId ? { reviewerAgentId } : {}),
              requireDifferentAgent: booleanValue(
                params.requireDifferentAgent,
                mode === 'independent_agent',
              ),
              maxRevisionAttempts: optionalInteger(
                params.maxRevisionAttempts,
                'maxRevisionAttempts',
                0,
                10,
              ) ?? 2,
              requiredEvidence: stringList(params.requiredEvidence, 'requiredEvidence', {
                maxItems: 50,
                maxLength: 500,
              }) ?? [],
            },
            status: 'active',
            teamId,
            ownerAgentId: state.context.agentId,
          },
          appendCommand(projection, state.context.agentId),
        ),
      );
      return this.makeResult(`Mission created: ${mission.id} [${mission.status}] ${mission.title}`, {
        structured: { mission },
      });
    } catch (error) {
      return workToolFailure(error);
    }
  }
}
