import type { CoordinationMessageKind } from '../../../../shared/types/v3/index.js';
import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  activeTeamMembers,
  appendCommand,
  assertTaskInTeam,
  nextId,
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

const MESSAGE_KINDS = new Set<CoordinationMessageKind>(['note', 'steer']);

export class AgentMessageTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Queues durable FIFO messages between members of one persistent v3 Team.';

  constructor(private readonly dependencies?: V3WorkToolDependencies) {
    super();
  }

  name(): string { return 'AgentMessage'; }
  description(): string {
    return 'Send a persistent note, live steer, or one-record-per-recipient Team broadcast.';
  }
  prompt(): string {
    return [
      'Use note for durable information a teammate may consume during a later Task.',
      'Use steer only when the target Agent has a running Run Session in this Work.',
      'Use to="*" for a broadcast to every other active member of the executing Team.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        to: {
          type: ['string', 'array'],
          items: { type: 'string', minLength: 1, maxLength: 200 },
          description: 'Agent ID, Agent ID list, or "*" for the executing Team.',
        },
        kind: { type: 'string', enum: ['note', 'steer'] },
        content: { type: 'string', minLength: 1, maxLength: 20_000 },
        summary: { type: 'string', maxLength: 120 },
        taskId: { type: 'string', maxLength: 200 },
      },
      required: ['to', 'kind', 'content'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const dependencies = v3WorkToolDependencies(this.dependencies);
    try {
      const state = await requireScopedState(dependencies, ctx);
      const kind = requiredText(params.kind, 'kind', 20) as CoordinationMessageKind;
      if (!MESSAGE_KINDS.has(kind)) {
        throw new V3WorkToolError('validation_failed', `Invalid message kind: ${kind}`);
      }
      const content = requiredText(params.content, 'content', 20_000);
      const summary = optionalText(params.summary, 'summary', 120);
      const taskId = optionalText(params.taskId, 'taskId', 200);
      let messageTeamId = state.context.teamId;
      if (taskId) {
        const task = state.work.tasks[taskId];
        if (!task) throw new V3WorkToolError('task_not_found', `Task not found: ${taskId}`);
        assertTaskInTeam(
          task,
          state.context.teamId,
          state.company,
          state.context.agentId,
        );
        messageTeamId = responsibleTaskTeamId(task, state.context.teamId);
      }
      const teamMemberIds = new Set(
        activeTeamMembers(state.company, messageTeamId)
          .map((membership) => membership.agentId)
          .filter((agentId) => state.company.agents[agentId]?.status === 'active'),
      );
      const recipients = resolveRecipients(
        params.to,
        teamMemberIds,
        state.context.agentId,
      );
      const baseIdempotencyKey = `agent-message:${nextId(dependencies)}`;
      const messages = [];
      for (const recipientAgentId of recipients) {
        const recipientSessionId = kind === 'steer'
          ? activeRunSessionId(state.work, messageTeamId, recipientAgentId)
          : undefined;
        if (kind === 'steer' && !recipientSessionId) {
          throw new V3WorkToolError(
            'recipient_not_running',
            `Cannot steer idle Agent ${recipientAgentId}; send a note instead.`,
            { recipientAgentId },
          );
        }
        const message = await withWorkRevisionRetry(
          dependencies,
          state.context.workId,
          state.context.agentId,
          (projection) => dependencies.workRepository.enqueueCoordinationMessage(
            state.context.workId,
            {
              teamId: messageTeamId,
              ...(taskId ? { taskId } : {}),
              senderAgentId: state.context.agentId,
              recipientAgentId,
              ...(recipientSessionId ? { recipientSessionId } : {}),
              kind,
              content,
              ...(summary ? { summary } : {}),
              idempotencyKey: `${baseIdempotencyKey}:${recipientAgentId}`,
            },
            appendCommand(projection, state.context.agentId, baseIdempotencyKey),
          ),
        );
        messages.push(message);
        if (kind === 'steer' && recipientSessionId) {
          dependencies.wakeSafeTurnBoundary?.(recipientSessionId);
        }
      }
      return this.makeResult(
        `Queued ${messages.length} persistent Team message${messages.length === 1 ? '' : 's'}.`,
        {
          structured: {
            workId: state.context.workId,
            teamId: messageTeamId,
            messages,
          },
        },
      );
    } catch (error) {
      return workToolFailure(error);
    }
  }
}

function resolveRecipients(
  value: unknown,
  activeMemberIds: Set<string>,
  senderAgentId: string,
): string[] {
  if (value === '*') {
    const recipients = [...activeMemberIds].filter((agentId) => agentId !== senderAgentId);
    if (recipients.length === 0) {
      throw new V3WorkToolError(
        'no_recipients',
        'The executing Team has no other active members.',
      );
    }
    return recipients;
  }
  const raw = Array.isArray(value) ? value : [value];
  const recipients = [...new Set(raw.map((entry, index) =>
    requiredText(entry, `to[${index}]`, 200),
  ))].filter((agentId) => agentId !== senderAgentId);
  if (recipients.length === 0) {
    throw new V3WorkToolError('no_recipients', 'No other Team recipients were selected.');
  }
  const outsider = recipients.find((agentId) => !activeMemberIds.has(agentId));
  if (outsider) {
    throw new V3WorkToolError(
      'recipient_not_in_team',
      `Agent ${outsider} is not an active member of the executing Team.`,
      { recipientAgentId: outsider },
    );
  }
  return recipients;
}

function activeRunSessionId(
  projection: Awaited<ReturnType<V3WorkToolDependencies['workRepository']['getProjection']>>,
  teamId: string,
  recipientAgentId: string,
): string | undefined {
  return Object.values(projection.runs)
    .filter((run) => (
      run.agentId === recipientAgentId
      && run.status === 'running'
      && projection.tasks[run.taskId]?.teamId === teamId
    ))
    .sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''))
    .find((run) => projection.sessions[run.sessionId]?.status === 'active')
    ?.sessionId;
}
