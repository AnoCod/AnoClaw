// AgentMessageTool — send a message to another agent along the org tree
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
import { bubbleEventToParent } from '../../agent/AgentDelegation.js';
import { SessionStore } from '../../session/SessionStore.js';

export class AgentMessageTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Sends a message to another agent along the organization tree with delivery status feedback.';
  name(): string {
    return 'AgentMessage';
  }

  description(): string {
    return 'Send a message to another agent along the organization tree. DOWNWARD ONLY — messages can be sent to agents who report to you, never upward to your own superior. The recipient sees your agent ID and can reply.';
  }

  prompt(): string {
    return '## AgentMessage Usage\n' +
      'Send a real-time message to a subordinate. DOWNWARD ONLY. Never message your superior — report results through your session output instead.\n\n' +
      '**AgentMessage vs TaskAssign:**\n' +
      '- TaskAssign = formal task delegation with clear specs, creates a tracked task\n' +
      '- AgentMessage = quick coordination message, no new task created\n\n' +
      '**When to use AgentMessage:**\n' +
      '- Adding requirements or clarifications to an already-running task (do NOT create a second TaskAssign)\n' +
      '- Asking for a quick status update\n' +
      '- Giving feedback on delivered work\n' +
      '- Coordinating between parallel tasks\n\n' +
      '**IMPORTANT — One-way only:**\n' +
      'Your message is delivered to the target agent\'s SESSION. You will NOT see their response in your own session.\n' +
      'AgentMessage is NOT a real-time chat — the recipient processes it independently and reports via their session output or TaskList.\n' +
      'If you need a reply, ask them to report via session output or use TaskOutput.\n\n' +
      '**When NOT to use:**\n' +
      '- Formal task delegation (use TaskAssign)\n' +
      '- Reporting to your boss (use your session output)\n' +
      '- Trivial messages that don\'t add value\n' +
      '- Expecting an immediate response in your session';
  }
  
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          description: 'ID of the target agent to send the message to',
        },
        content: {
          type: 'string',
          description: 'Message content to send',
        },
      },
      required: ['targetAgentId', 'content'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Low;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const targetAgentId = params.targetAgentId as string;
    const content = params.content as string;

    if (!targetAgentId || !content) {
      return this.makeError('Both targetAgentId and content are required.');
    }

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
    const allSessions = sessionManager.listSessions();
    let targetSession = allSessions.find(
      (s) => s.agentId === targetAgentId && !s.isArchived(),
    );

    if (!targetSession) {
      const parentSessionId = isDirectSubordinate
        ? ctx.sessionId
        : (allSessions.find((s) => s.agentId === targetAgentId && s.isMain() && !s.isArchived())?.id ?? ctx.sessionId);

      try {
        targetSession = await sessionManager.createSubSession(parentSessionId, targetAgentId);
        // Link for interrupt propagation — stop propagates from caller to target
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
    } catch { /* best-effort — session injection already succeeded */ }

    // ── Notify target's browser session via TypedEventBus ──
    try {
      TypedEventBus.emit('delegation:subsession_created', {
        sessionId: targetSession.id,
        parentSessionId: targetSession.parentSessionId || ctx.sessionId,
        agentId: targetAgentId,
        title: `Msg: ${content.slice(0, 40)}`,
      });
    } catch { /* non-critical — UI notification is best-effort */ }

    // ── Determine delivery status ──
    const targetActive = runtime.isSessionActive(targetSession.id);

    if (targetActive) {
      // Target is already in an AgentLoop — message will be seen on next turn
      return this.makeResult(
        `Message delivered to '${targetAgentId}' (session: ${targetSession.id}). ` +
        `Agent is currently active — the message will be seen on their next turn.`,
      );
    }

    // Target is idle — start a background AgentLoop that persists events.
    // Uses StreamPersister for JSONL durability + bubbleEventToParent for
    // the parent session's delegation activity card.
    logger.debug('AgentMessage starting background processing', { from: ctx.agentId, to: targetAgentId, sid: targetSession.id });
    const parentSessionId = ctx.sessionId;
    (async () => {
      const { StreamPersister } = await import('../../../infra/StreamPersister.js');
      const store = SessionStore.getInstance();
      const persister = new StreamPersister(store, targetSession.id,
        `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        '00000000-0000-0000-0000-000000000000');
      try {
        for await (const event of runtime.processMessage(targetSession.id, targetAgentId, message)) {
          // ── Persist to JSONL ──
          if (event.type === 'text') {
            await persister.persistEvent('text', { content: event.content || '' });
          } else if (event.type === 'think') {
            await persister.persistEvent('think', { content: event.content || '' });
          } else if (event.type === 'tool_call') {
            await persister.persistEvent('tool_call', {
              id: (event.toolCallId || event.toolId || '') as string,
              name: (event.toolName || event.name || '') as string,
              input: (event.params || event.args || event.input || event.toolInput || {}) as Record<string, unknown>,
            });
          } else if (event.type === 'tool_result') {
            await persister.persistEvent('tool_result', {
              toolCallId: (event.toolCallId || event.toolId || '') as string,
              is_error: (event as Record<string, unknown>).success === false,
              content: (event.result || event.content || '') as string,
            });
          }
          // ── Bubble to parent for live delegation card ──
          bubbleEventToParent(null as any, parentSessionId, targetSession.id, targetAgentId, event);
        }
        await persister.flushDeltas();
        SessionManager.getInstance().rebuildMessageCache(targetSession.id).catch(() => {});
        logger.debug('AgentMessage processed by recipient', { from: ctx.agentId, to: targetAgentId, sid: targetSession.id });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('AgentMessage background processing error', { from: ctx.agentId, to: targetAgentId, error: msg });
      }
    })();

    return this.makeResult(
      `Message delivered to '${targetAgentId}' (session: ${targetSession.id}). ` +
      `Agent was idle — processing started in background.`,
    );
  }
}
