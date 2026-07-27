import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type { CoordinationTaskStatus } from '../../../../shared/types/coordination.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  integerParam,
  rootSessionIdFor,
  stringArrayParam,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';

const STATUSES = new Set<CoordinationTaskStatus>([
  'pending', 'claimed', 'running', 'blocked', 'completed', 'failed', 'cancelled',
]);

export class TaskUpdateTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Updates owned task progress, blockers, summaries, and evidence with optional optimistic versioning.';
  name(): string { return 'TaskUpdate'; }
  description(): string { return 'Report non-terminal progress, a blocker, a result summary, or evidence for a durable task.'; }
  prompt(): string {
    return [
      'For a running AgentLoop task, report progress or blockers only when useful.',
      'To finish running work, return the final answer normally; the runtime records completion or failure after the AgentLoop exits.',
      'Task action="stop" only cancels unfinished work. Never use stop to submit an answer or mark work complete.',
      'expectedVersion is optional. Supply the version shown by Task list/output only when stale-write detection is required.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        expectedVersion: {
          type: 'integer',
          minimum: 1,
          description: 'Optional task version from Task list/output for optimistic stale-write detection.',
        },
        status: { type: 'string', enum: ['pending', 'claimed', 'running', 'blocked', 'completed', 'failed', 'cancelled'] },
        progress: { type: 'integer', minimum: 0, maximum: 100 },
        blocker: { type: 'string', maxLength: 2000 },
        resultSummary: { type: 'string', maxLength: 4000 },
        evidence: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2000 }, maxItems: 50 },
        error: { type: 'string', maxLength: 2000 },
      },
      required: ['taskId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const taskId = stringParam(params.taskId, 'taskId', 200)!;
      const service = CoordinationService.getInstance();
      const current = service.getTask(rootSessionId, taskId);
      if (!current) throw new CoordinationError('not_found', `Task not found: ${taskId}`);
      if (current.assigneeAgentId && current.assigneeAgentId !== ctx.agentId && current.creatorAgentId !== ctx.agentId) {
        throw new CoordinationError('forbidden', 'Only the assignee or creator may update this task');
      }
      const rawStatus = stringParam(params.status, 'status', 20, true);
      if (rawStatus && !STATUSES.has(rawStatus as CoordinationTaskStatus)) {
        throw new CoordinationError('validation', `Invalid status: ${rawStatus}`);
      }
      if (
        current.status === 'running'
        && rawStatus
        && ['completed', 'failed', 'cancelled'].includes(rawStatus)
      ) {
        throw new CoordinationError(
          'conflict',
          'Do not call Task update or stop to finish running work. Return your final answer normally; the runtime finalizes the task after the AgentLoop exits. Task action="stop" only cancels unfinished work and never submits completion.',
        );
      }
      const task = await service.updateTask(rootSessionId, taskId, {
        status: rawStatus as CoordinationTaskStatus | undefined,
        progress: integerParam(params.progress, 'progress', { optional: true, min: 0, max: 100 }),
        blocker: stringParam(params.blocker, 'blocker', 2_000, true),
        resultSummary: stringParam(params.resultSummary, 'resultSummary', 4_000, true),
        evidence: stringArrayParam(params.evidence, 'evidence', { optional: true, maxItems: 50, maxLength: 2_000 }),
        error: stringParam(params.error, 'error', 2_000, true),
      }, ctx.agentId, integerParam(params.expectedVersion, 'expectedVersion', { optional: true, min: 1 }));
      return this.makeResult(`Task ${task.id} updated to ${task.status} (v${task.version}).`, {
        structured: { task },
      });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
