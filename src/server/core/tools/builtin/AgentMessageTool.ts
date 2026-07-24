// AgentMessageTool - send a message to another agent along the org tree
// Posts a message to the target agent's session via SessionManager.
// Communication follows the org tree: up to managers, down to subordinates.
// Now with delivery status feedback: reports whether target is actively processing,
// processing in background, or message is queued for later.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext, Message } from '../../../../shared/types/session.js';
import { MessageRole } from '../../../../shared/types/session.js';
import { SessionManager } from '../../session/index.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { createLogger } from '../../logger.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';
import { AgentChannel } from '../../agent/AgentChannel.js';
import { InterruptController } from '../../agent/supervision/InterruptController.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { bubbleEventToParent } from '../../agent/AgentDelegation.js';
import { WsServer } from '../../../infra/network/WsServer.js';
import type { SessionTurnRecorder } from '../../../infra/SessionTurnRecorder.js';

const MAX_TARGET_AGENT_ID_CHARS = 200;
const MAX_MESSAGE_CONTENT_CHARS = 20000;
const MAX_MESSAGE_SUMMARY_CHARS = 120;

export class AgentMessageTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Sends a coordination update to a direct parent or child agent without creating a new task.';
  name(): string {
    return 'AgentMessage';
  }

  description(): string {
    return 'Send a coordination message to a directly related agent in the org tree. Use it to clarify, amend, interrupt, or review existing work; it does not create a tracked task.';
  }

  prompt(): string {
    return [
      '## AgentMessage Usage',
      'Use AgentMessage for coordination inside an existing parent-child relationship.',
      '',
      'AgentMessage vs TaskAssign:',
      '- TaskAssign starts a distinct tracked task with acceptance criteria.',
      '- AgentMessage updates, clarifies, interrupts, or reviews active work without creating a new task.',
      '',
      'Use AgentMessage for:',
      '- New constraints or requirements for a running task.',
      '- Feedback after reviewing child output.',
      '- A focused status request when a task appears stuck.',
      '- Cancellation guidance before using TaskStop.',
      '',
      'Do not expect a synchronous chat reply. The recipient processes the message in its own session and reports through that session or task output.',
    ].join('\n');
  }
  
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_TARGET_AGENT_ID_CHARS,
          pattern: '\\S',
          description: 'ID of the target agent to send the message to',
        },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MESSAGE_CONTENT_CHARS,
          pattern: '\\S',
          description: 'Message content to send',
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MESSAGE_SUMMARY_CHARS,
          pattern: '\\S',
          description: 'Optional short label for the background task list and UI activity cards.',
        },
      },
      required: ['targetAgentId', 'content'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Low;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const targetResult = normalizeString(params.targetAgentId, 'targetAgentId', MAX_TARGET_AGENT_ID_CHARS);
    if (targetResult.error) return this.makeError(targetResult.error);
    const targetAgentId = targetResult.value!;

    const contentResult = normalizeString(params.content, 'content', MAX_MESSAGE_CONTENT_CHARS);
    if (contentResult.error) return this.makeError(contentResult.error);
    const content = contentResult.value!;

    const summaryResult = normalizeOptionalString(params.summary, 'summary', MAX_MESSAGE_SUMMARY_CHARS);
    if (summaryResult.error) return this.makeError(summaryResult.error);
    const summary = summaryResult.value;
    const activitySummary = summary ?? `Msg to ${targetAgentId}: ${content.slice(0, 60)}`;

    const registry = AgentRegistry.getInstance();
    const sessionManager = SessionManager.getInstance();
    const runtime = AgentRuntime.getInstance();
    const logger = createLogger('anochat.tools');

    // ── Validate org-tree adjacency ──
    const caller = registry.agent(ctx.agentId);
    const target = registry.findAgent(targetAgentId);
    if (!caller || !target) {
      return this.makeError(
        `Cannot send message: caller '${ctx.agentId}' or target '${targetAgentId}' not found in registry.`,
      );
    }

    if (!target.isActive) {
      return this.makeError(
        `Cannot send message: target agent '${targetAgentId}' is destroyed or inactive.`,
      );
    }

    const isDirectSuperior = caller.parentAgentId === target.id;
    const isDirectSubordinate = target.parentAgentId === caller.id;
    if (!isDirectSuperior && !isDirectSubordinate) {
      return this.makeError(
        `Cannot send message to '${targetAgentId}': ` +
        'AgentMessage only supports communication with direct superiors or direct subordinates along the org tree.',
      );
    }

    // ── Find or create target session ──
    const currentSession = sessionManager.session(ctx.sessionId);
    if (!currentSession) {
      return this.makeError(`Cannot send message: current session '${ctx.sessionId}' was not found.`);
    }

    let targetSession;
    if (isDirectSubordinate) {
      targetSession = sessionManager.subsessionsOf(ctx.sessionId).find(
        (s) => s.agentId === target.id && !s.isArchived(),
      );
    } else {
      const parentSessionId = currentSession.parentSessionId;
      if (!parentSessionId) {
        return this.makeError(`Cannot send message to '${targetAgentId}': current session has no parent session.`);
      }

      targetSession = sessionManager.session(parentSessionId);
      if (!targetSession || targetSession.isArchived() || targetSession.agentId !== target.id) {
        return this.makeError(
          `Cannot send message to '${targetAgentId}': parent session '${parentSessionId}' does not belong to that agent.`,
        );
      }
      InterruptController.getInstance().linkChild(targetSession.id, ctx.sessionId);
    }

    if (!targetSession) {
      if (!isDirectSubordinate) {
        return this.makeError(`Cannot send message to '${targetAgentId}': target session was not found in this session tree.`);
      }

      try {
        targetSession = await sessionManager.createSubSession(ctx.sessionId, target.id);
        // Link for interrupt propagation - stop propagates from caller to target
        InterruptController.getInstance().linkChild(ctx.sessionId, targetSession.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.makeError(`Failed to create session for '${targetAgentId}': ${msg}`);
      }
    }

    // ── Build and deliver the message ──
    const message: Message = {
      id: `agent-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: targetSession.id,
      role: MessageRole.System,
      content: `[Message from ${caller.name || ctx.agentId} (reply-to: ${ctx.agentId})]: ${content}`,
      tokenCount: Math.ceil(content.length / 4),
      compressed: false,
      timestamp: new Date().toISOString(),
      agentId: ctx.agentId,
      agentName: caller.name,
    };

    try {
      await sessionManager.appendMessage(targetSession.id, message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Failed to deliver message: ${msg}`);
    }

    // Fast path: AgentChannel delivers in real-time to active AgentLoop (milliseconds).
    // The session injection above is the durability path; this is the speed path.
    try {
      AgentChannel.getInstance().send(
        targetAgentId, targetSession.id,
        ctx.agentId, ctx.sessionId,
        `[${caller.name} says]: ${content}`,
        'system',
      );
    } catch { /* best-effort - session injection already succeeded */ }

    // ── Notify target's browser session via TypedEventBus ──
    try {
      TypedEventBus.emit('delegation:subsession_created', {
        sessionId: targetSession.id,
        parentSessionId: targetSession.parentSessionId || ctx.sessionId,
        agentId: targetAgentId,
        title: summary ?? `Msg: ${content.slice(0, 40)}`,
      });
    } catch { /* non-critical - UI notification is best-effort */ }

    // ── Determine delivery status ──
    const targetActive = runtime.isSessionActive(targetSession.id);

    if (targetActive) {
      // Target is already in an AgentLoop - message will be seen on next turn
      return this.makeResult(
        `Message delivered to '${targetAgentId}' (session: ${targetSession.id}). ` +
        `Agent is currently active - the message will be seen on their next turn.`,
        { structured: { targetAgentId, targetSessionId: targetSession.id, active: true } },
      );
    }

    // Target is idle - start a background AgentLoop that persists events.
    // Uses SessionTurnRecorder for JSONL durability + bubbleEventToParent for
    // the parent session's delegation activity card.
    // Registered with BackgroundTaskManager so UI panel can track it.
    logger.debug('AgentMessage starting background processing', { from: ctx.agentId, to: targetAgentId, sid: targetSession.id });
    const parentSessionId = ctx.sessionId;
    const bgManager = BackgroundTaskManager.getInstance();
    const bgTaskId = bgManager.register({
      type: 'subagent',
      parentSessionId: ctx.sessionId,
      parentAgentId: ctx.agentId,
      summary: activitySummary,
    });
    const bgStartMs = Date.now();
    const targetSessionId = targetSession.id;
    (async () => {
      let recorder: SessionTurnRecorder | null = null;
      try {
        const { SessionTurnRecorder: SessionTurnRecorderCtor } = await import('../../../infra/SessionTurnRecorder.js');
        recorder = new SessionTurnRecorderCtor(targetSessionId, targetAgentId,
          `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        );
        const activeRecorder = recorder;

        for await (const event of runtime.processMessage(targetSessionId, targetAgentId, message)) {
          // ── Persist to JSONL ──
          await activeRecorder.record(event, 'agent_message');
          // ── Bubble to parent for live delegation card ──
          bubbleEventToParent(null as any, parentSessionId, targetSessionId, targetAgentId, event);
          WsServer.getInstance().send(targetSessionId, event as unknown as Record<string, unknown>);
        }
        await activeRecorder.finalize();
        SessionManager.getInstance().rebuildMessageCache(targetSessionId).catch(() => {});
        bgManager.complete(bgTaskId, { content: 'Message processed', durationMs: Date.now() - bgStartMs }).catch(() => {});
        logger.debug('AgentMessage processed by recipient', { from: ctx.agentId, to: targetAgentId, sid: targetSessionId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('AgentMessage background processing error', { from: ctx.agentId, to: targetAgentId, error: msg });
        try {
          await recorder?.recordError(msg, 'agent_message');
          await recorder?.finalize();
        } catch { /* best-effort before failure notification */ }
        bgManager.fail(bgTaskId, msg, Date.now() - bgStartMs).catch(() => {});
      }
    })();

    return this.makeResult(
      `Message delivered to '${targetAgentId}' (session: ${targetSession.id}). ` +
      `Agent was idle - processing started in background.\n` +
      `Task ID: ${bgTaskId}`,
      { structured: { taskId: bgTaskId, targetAgentId, targetSessionId: targetSession.id, background: true } },
    );
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (typeof input?.summary === 'string' && input.summary.trim()) {
      return input.summary.trim();
    }
    if (typeof input?.content === 'string' && input.content.trim()) {
      return this.truncate(input.content.trim(), 50);
    }
    return null;
  }

  getActivityDescription(input?: Record<string, unknown>): string | null {
    const target = typeof input?.targetAgentId === 'string' && input.targetAgentId.trim()
      ? input.targetAgentId.trim()
      : 'agent';
    return `Sending message to ${target}`;
  }
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  if (trimmed.length > maxLength) {
    return { error: `${field} must be ${maxLength} characters or less` };
  }
  return { value: trimmed };
}

function normalizeOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): { value?: string; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: undefined };
  return normalizeString(value, field, maxLength);
}
