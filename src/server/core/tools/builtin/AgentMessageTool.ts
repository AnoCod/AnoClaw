import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type {
  CoordinationMessageKind,
  TeamRecord,
} from '../../../../shared/types/coordination.js';
import type { Message } from '../../../../shared/types/session.js';
import { MessageRole } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  rootSessionIdFor,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';
import { SessionManager } from '../../session/SessionManager.js';
import { InterruptController } from '../../agent/supervision/InterruptController.js';
import { TokenCounter } from '../../context/TokenCounter.js';

const KINDS = new Set<CoordinationMessageKind>(['note', 'steer']);

export class AgentMessageTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Queues durable peer, hierarchy, or team broadcast coordination messages.';
  name(): string { return 'AgentMessage'; }
  description(): string {
    return 'Send a durable note, live steer, or team broadcast without creating another task.';
  }
  prompt(): string {
    return [
      'Use note for information the recipient may read on its next task.',
      'Use steer only for a currently running recipient session.',
      'Use a note when a response or review is expected. Use to="*" only inside an active team.',
      'Task work itself belongs in TaskCreate/TaskAssign.',
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
          description: 'Agent ID, list of agent IDs, or "*" to broadcast to the active team.',
        },
        kind: { type: 'string', enum: ['note', 'steer'] },
        content: { type: 'string', minLength: 1, maxLength: 20000 },
        summary: { type: 'string', maxLength: 120 },
        taskId: { type: 'string', maxLength: 200 },
      },
      required: ['to', 'kind', 'content'],
      additionalProperties: false,
    };
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const service = CoordinationService.getInstance();
      const team = service.getActiveTeam(rootSessionId);
      const kindRaw = stringParam(params.kind, 'kind', 20)! as CoordinationMessageKind;
      if (!KINDS.has(kindRaw)) throw new CoordinationError('validation', `Invalid message kind: ${kindRaw}`);
      const content = stringParam(params.content, 'content', 20_000)!;
      const summary = stringParam(params.summary, 'summary', 120, true);
      const taskId = stringParam(params.taskId, 'taskId', 200, true);
      if (taskId && !service.getTask(rootSessionId, taskId)) {
        throw new CoordinationError('not_found', `Task not found: ${taskId}`);
      }
      const recipients = resolveRecipients(params.to, team, ctx.agentId);
      if (recipients.length === 0) throw new CoordinationError('validation', 'No recipients selected');

      const delivered: Array<Record<string, unknown>> = [];
      for (const targetAgentId of recipients) {
        const target = AgentRegistry.getInstance().findAgent(targetAgentId);
        if (!target?.isActive) throw new CoordinationError('validation', `Active target agent not found: ${targetAgentId}`);
        const inSameTeam = !!team
          && team.memberAgentIds.includes(ctx.agentId)
          && team.memberAgentIds.includes(targetAgentId);
        if (!inSameTeam) assertHierarchyAdjacency(ctx.agentId, targetAgentId);

        const targetSession = await resolveTargetSession(ctx, targetAgentId, team, inSameTeam);
        const runtime = AgentRuntime.getInstance();
        if (kindRaw === 'steer' && !runtime.isSessionActive(targetSession.id)) {
          throw new CoordinationError('conflict', `Cannot steer idle agent ${targetAgentId}; send a note instead`);
        }

        const queued = await service.queueMessage({
          rootSessionId,
          teamId: inSameTeam ? team?.id : undefined,
          taskId,
          fromAgentId: ctx.agentId,
          toAgentId: targetAgentId,
          kind: kindRaw,
          content,
          summary,
        });
        const caller = AgentRegistry.getInstance().findAgent(ctx.agentId);
        const rendered = [
          [
            `<coordination-message id="${queued.id}"`,
            `root-session-id="${rootSessionId}"`,
            queued.teamId ? `team-id="${queued.teamId}"` : '',
            taskId ? `task-id="${taskId}"` : '',
            `from-agent="${ctx.agentId}"`,
            `to-agent="${targetAgentId}"`,
            `session-id="${targetSession.id}"`,
            `kind="${kindRaw}">`,
          ].filter(Boolean).join(' '),
          content,
          '</coordination-message>',
        ].join('\n');
        const message: Message = {
          id: queued.id,
          sessionId: targetSession.id,
          role: MessageRole.User,
          content: rendered,
          tokenCount: TokenCounter.estimate(rendered),
          compressed: false,
          timestamp: queued.createdAt,
          agentId: ctx.agentId,
          agentName: caller?.name || ctx.agentId,
        };
        await SessionManager.getInstance().appendMessage(targetSession.id, message);
        const deliveredMessage = await service.updateMessageStatus(
          rootSessionId,
          queued.id,
          'delivered',
          ctx.agentId,
        );
        if (runtime.isSessionActive(targetSession.id)) {
          InterruptController.getInstance().setPendingUserMessage(targetSession.id, rendered);
          InterruptController.getInstance().wakeOnly(targetSession.id);
        }
        delivered.push({
          message: deliveredMessage,
          targetSessionId: targetSession.id,
          active: runtime.isSessionActive(targetSession.id),
        });
      }
      return this.makeResult(`Delivered ${delivered.length} durable coordination message(s).`, {
        structured: { rootSessionId, deliveries: delivered },
      });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}

function resolveRecipients(value: unknown, team: TeamRecord | undefined, callerAgentId: string): string[] {
  if (value === '*') {
    if (!team || !team.memberAgentIds.includes(callerAgentId)) {
      throw new CoordinationError('forbidden', 'Broadcast requires membership in the active team');
    }
    return team.memberAgentIds.filter((agentId) => agentId !== callerAgentId);
  }
  const raw = Array.isArray(value) ? value : [value];
  const recipients = raw.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new CoordinationError('validation', 'to must contain non-empty agent IDs');
    }
    return entry.trim();
  });
  return [...new Set(recipients)].filter((agentId) => agentId !== callerAgentId);
}

function assertHierarchyAdjacency(callerAgentId: string, targetAgentId: string): void {
  const registry = AgentRegistry.getInstance();
  const caller = registry.findAgent(callerAgentId);
  const target = registry.findAgent(targetAgentId);
  const adjacent = caller?.parentAgentId === target?.id || target?.parentAgentId === caller?.id;
  if (!adjacent) {
    throw new CoordinationError(
      'forbidden',
      'Agents outside an active shared team may message only a direct parent or child',
    );
  }
}

async function resolveTargetSession(
  ctx: ExecutionContext,
  targetAgentId: string,
  team: TeamRecord | undefined,
  inSameTeam: boolean,
) {
  const sessionManager = SessionManager.getInstance();
  if (inSameTeam && team) {
    return sessionManager.createSubSession(
      team.rootSessionId,
      targetAgentId,
      `Team ${team.name}: ${targetAgentId}`,
      {
        scopeId: `team-${team.id}`,
        metadata: {
          coordinationTeamId: team.id,
          coordinationRootSessionId: team.rootSessionId,
          coordinationMode: 'swarm',
        },
      },
    );
  }
  const caller = AgentRegistry.getInstance().findAgent(ctx.agentId)!;
  const target = AgentRegistry.getInstance().findAgent(targetAgentId)!;
  if (target.parentAgentId === caller.id) {
    return sessionManager.createSubSession(ctx.sessionId, targetAgentId);
  }
  const current = sessionManager.session(ctx.sessionId);
  if (!current?.parentSessionId) {
    throw new CoordinationError('not_found', 'Current session has no parent session for upward messaging');
  }
  const parent = sessionManager.session(current.parentSessionId);
  if (!parent || parent.agentId !== target.id) {
    throw new CoordinationError('not_found', 'Matching parent agent session was not found');
  }
  return parent;
}
