import type {
  VerificationCriterionResult,
  VerificationOutcome,
} from '../../../../shared/types/v3/index.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  activeMembership,
  appendCommand,
  assertTaskInTeam,
  assertTaskVersion,
  nextId,
  requiredText,
  requireScopedState,
  responsibleTaskTeamId,
  v3WorkToolDependencies,
  V3WorkToolError,
  withWorkRevisionRetry,
  workToolFailure,
  type V3WorkToolDependencies,
} from '../v3/V3WorkToolSupport.js';

type AgentVerificationOutcome = Extract<
  VerificationOutcome,
  'approved' | 'revision_required'
>;

export class TaskVerifyTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Completes an independent-agent v3 Task verification.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'TaskVerify'; }
  description(): string {
    return 'Record an independent reviewer decision and atomically complete the Task or require a revision.';
  }
  prompt(): string {
    return [
      'Use only when the Mission verification mode is independent_agent and you are its designated reviewer.',
      'User verification is decided through the user-facing REST/UI flow, never by an Agent.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        expectedVersion: { type: 'integer', minimum: 1 },
        outcome: { type: 'string', enum: ['approved', 'revision_required'] },
        summary: { type: 'string', minLength: 1, maxLength: 4_000 },
        criteria: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string', minLength: 1, maxLength: 2_000 },
              passed: { type: 'boolean' },
              evidence: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 2_000 },
                maxItems: 50,
              },
              note: { type: 'string', maxLength: 2_000 },
            },
            required: ['criterion', 'passed', 'evidence'],
            additionalProperties: false,
          },
        },
      },
      required: ['taskId', 'expectedVersion', 'outcome', 'summary', 'criteria'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const taskId = requiredText(params.taskId, 'taskId', 200);
      const expectedVersion = requiredPositiveInteger(params.expectedVersion, 'expectedVersion');
      const outcome = requiredText(params.outcome, 'outcome', 30) as AgentVerificationOutcome;
      if (outcome !== 'approved' && outcome !== 'revision_required') {
        throw new V3WorkToolError(
          'validation_failed',
          `Invalid verification outcome: ${outcome}`,
        );
      }
      const summary = requiredText(params.summary, 'summary', 4_000);
      const criteria = verificationCriteria(params.criteria);
      const result = await withWorkRevisionRetry(
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
          const mission = projection.missions[task.missionId];
          if (!mission) {
            throw new V3WorkToolError(
              'mission_not_found',
              `Mission not found: ${task.missionId}`,
            );
          }
          const taskTeamId = responsibleTaskTeamId(task, state.context.teamId);
          if (mission.verificationPolicy.mode === 'user') {
            throw new V3WorkToolError(
              'user_verification_required',
              'User-mode verification can only be decided through the public REST/UI flow.',
            );
          }
          if (mission.verificationPolicy.mode === 'automatic') {
            throw new V3WorkToolError(
              'automatic_verification_owned',
              'Automatic verification is owned by the server Run executor.',
            );
          }
          const reviewerAgentId = mission.verificationPolicy.reviewerAgentId;
          if (!reviewerAgentId) {
            throw new V3WorkToolError(
              'reviewer_required',
              'The Mission does not have a designated independent reviewer.',
            );
          }
          if (reviewerAgentId !== state.context.agentId) {
            throw new V3WorkToolError(
              'reviewer_mismatch',
              `Task ${taskId} must be reviewed by Agent ${reviewerAgentId}.`,
            );
          }
          if (!activeMembership(state.company, taskTeamId, reviewerAgentId)) {
            throw new V3WorkToolError(
              'reviewer_not_in_team',
              `Reviewer ${reviewerAgentId} is not an active member of the responsible Team.`,
            );
          }
          const pendingVerification = Object.values(projection.verificationRecords)
            .filter((verification) => (
              verification.taskId === taskId
              && verification.mode === 'independent_agent'
              && verification.outcome === 'pending'
            ))
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
          if (!pendingVerification) {
            throw new V3WorkToolError(
              'verification_not_pending',
              `Task ${taskId} has no pending independent verification.`,
            );
          }
          if (
            pendingVerification.reviewerAgentId !== reviewerAgentId
            || pendingVerification.workerAgentId === reviewerAgentId
          ) {
            throw new V3WorkToolError(
              'reviewer_lineage_invalid',
              'The pending verification reviewer must match the Mission policy and differ from the worker.',
            );
          }
          return dependencies.workRepository.completeTaskVerification(
            state.context.workId,
            {
              verificationId: pendingVerification.id,
              outcome,
              summary,
              criteria,
            },
            appendCommand(projection, state.context.agentId),
          );
        },
      );
      const workerAgentId = result.verification.workerAgentId;
      const message = await withWorkRevisionRetry(
        dependencies,
        state.context.workId,
        state.context.agentId,
        (projection) => dependencies.workRepository.enqueueCoordinationMessage(
          state.context.workId,
          {
            teamId: responsibleTaskTeamId(result.task, state.context.teamId),
            taskId,
            senderAgentId: state.context.agentId,
            recipientAgentId: workerAgentId,
            kind: 'task_result',
            content: summary,
            summary: result.task.status === 'completed'
              ? 'Independent verification approved'
              : 'Independent verification requires revision',
            idempotencyKey: `verification:${result.verification.id}:${outcome}`,
          },
          appendCommand(projection, state.context.agentId, nextId(dependencies)),
        ),
      );
      return this.makeResult(
        `Task ${taskId} verification recorded as ${outcome}; Task is ${result.task.status}.`,
        {
          structured: {
            task: result.task,
            verification: result.verification,
            message,
          },
        },
      );
    } catch (error) {
      return workToolFailure(error);
    }
  }
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new V3WorkToolError(
      'validation_failed',
      `${field} must be a positive integer.`,
      { field },
    );
  }
  return value as number;
}

function verificationCriteria(value: unknown): VerificationCriterionResult[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new V3WorkToolError(
      'validation_failed',
      'criteria must contain between 1 and 50 results.',
    );
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new V3WorkToolError(
        'validation_failed',
        `criteria[${index}] must be an object.`,
      );
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.passed !== 'boolean') {
      throw new V3WorkToolError(
        'validation_failed',
        `criteria[${index}].passed must be a boolean.`,
      );
    }
    if (!Array.isArray(item.evidence) || item.evidence.length > 50) {
      throw new V3WorkToolError(
        'validation_failed',
        `criteria[${index}].evidence must be an array with at most 50 entries.`,
      );
    }
    return {
      criterion: requiredText(item.criterion, `criteria[${index}].criterion`, 2_000),
      passed: item.passed,
      evidence: item.evidence.map((entry, evidenceIndex) =>
        requiredText(entry, `criteria[${index}].evidence[${evidenceIndex}]`, 2_000),
      ),
      ...(item.note !== undefined
        ? { note: requiredText(item.note, `criteria[${index}].note`, 2_000) }
        : {}),
    };
  });
}
