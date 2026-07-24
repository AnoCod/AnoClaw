/**
 * SendMessageHandler — handles 'send_message' WS messages.
 *
 * Input:  `{ type: 'send_message', content, mode?, effort?, attachments?, parentSessionId?, sessionId }`
 * Output: Streams agent response events (text, think, tool_call, tool_result, etc.) to the session.
 *         Auto-creates session if needed. Soft-interrupts active sessions.
 */
// Extracted from main.ts: session creation, history loading, agent streaming, persistence.

import type { WsMessageHandler } from '../WsMessageRouter.js';
import type { Message } from '../../../../shared/types/session.js';
import { MessageRole } from '../../../../shared/types/session.js';
import { WsMessageType } from '../../../../shared/types/ws-protocol.js';
import { AgentRuntime } from '../../../core/agent/AgentRuntime.js';
import { AgentRegistry } from '../../../core/agent/AgentRegistry.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { SessionStore } from '../../../core/session/SessionStore.js';
import { LogManager } from '../../logging/LogManager.js';
import { pickFunMessage } from '../../../core/agent/StatusMessages.js';
import { InterruptController, InterruptReason } from '../../../core/agent/supervision/InterruptController.js';
import { selectRunnableAgent } from '../../../core/agent/AgentSelection.js';
import { resolveSessionEffort, resolveSessionPermissionMode } from '../../../core/agent/PermissionModePolicy.js';

const log = LogManager.getInstance().logger('anochat.ws');

export interface IncomingAttachment {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
  content?: string;
}

export function hasSendableUserPayload(content: unknown, attachments: unknown): boolean {
  return (typeof content === 'string' && content.trim().length > 0)
    || (Array.isArray(attachments) && attachments.length > 0);
}

export function attachmentTextBlocks(attachments: IncomingAttachment[] | undefined): string[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((attachment) => {
    const name = attachment.name?.trim() || 'unnamed';
    if (typeof attachment.content === 'string') {
      return `[File: ${name}]\n${attachment.content || '(empty file)'}`;
    }

    const details = [
      attachment.type ? `type=${attachment.type}` : '',
      Number.isFinite(attachment.size) ? `size=${attachment.size} bytes` : '',
    ].filter(Boolean).join(', ');
    return `[Attached file: ${name}]\nContent not available in message payload.${details ? ` Metadata: ${details}.` : ''}`;
  });
}

export function buildUserContent(rawContent: string, attachments: IncomingAttachment[] | undefined): string {
  const content = rawContent.trim();
  const blocks = attachmentTextBlocks(attachments);
  if (blocks.length === 0) return content;
  const attachmentText = blocks.join('\n\n');
  if (!content) return attachmentText;
  if (content.includes(attachmentText)) return content;
  return `${attachmentText}\n\n${content}`;
}

export const sendMessageHandler: WsMessageHandler = async (ctx) => {
  const msg = ctx.data;
  if (!hasSendableUserPayload(msg.content, msg.attachments)) {
    ctx.ws.send(ctx.sessionId, { type: WsMessageType.Error, errorMessage: 'Missing content or attachments', code: 'MISSING_CONTENT' });
    return;
  }

  const runtime = AgentRuntime.getInstance();
  const registry = AgentRegistry.getInstance();
  const sessionManager = SessionManager.getInstance();
  const isGoalKick = msg.internal === 'goal';

  // Ensure session exists — use mutable var so auto-creation updates it
  let effectiveSessionId = ctx.sessionId;
  let session = sessionManager.session(effectiveSessionId);
  if (isGoalKick && !session) {
    ctx.ws.send(effectiveSessionId, { type: WsMessageType.Done });
    return;
  }
  if (!session) {
    const agentSelection = selectRunnableAgent();
    if (!agentSelection.ok || !agentSelection.agentId) {
      ctx.ws.send(ctx.sessionId, {
        type: WsMessageType.Error,
        errorMessage: agentSelection.message || 'No runnable agent is configured',
        code: 'AGENT_REQUIRED',
      });
      return;
    }
    const agentId = agentSelection.agentId;
    const parentId = msg.parentSessionId as string | undefined;
    try {
      if (parentId) {
        const parentSession = sessionManager.session(parentId);
        if (!parentSession) {
          ctx.ws.send(ctx.sessionId, {
            type: WsMessageType.Error,
            errorMessage: `Parent session "${parentId}" not found`,
            code: 'PARENT_NOT_FOUND',
          });
          return;
        }
        if (parentSession.isArchived()) {
          ctx.ws.send(ctx.sessionId, {
            type: WsMessageType.Error,
            errorMessage: `Parent session "${parentId}" is archived`,
            code: 'PARENT_ARCHIVED',
          });
          return;
        }
        session = await sessionManager.createSubSession(parentId, agentId, (msg.content as string)?.slice(0, 30) || 'Sub Session');
      } else {
        session = await sessionManager.createMainSession(agentId, (msg.content as string)?.slice(0, 30) || 'New Session');
      }
      effectiveSessionId = session.id;
      ctx.ws.send(effectiveSessionId, {
        type: WsMessageType.Text,
        content: `Session created: ${effectiveSessionId}\n`,
      });
      ctx.ws.send(effectiveSessionId, {
        type: WsMessageType.SubsessionCreated,
        sessionId: effectiveSessionId,
        parentSessionId: parentId || null,
        agentId,
      });
    } catch (err) {
      ctx.ws.send(ctx.sessionId, {
        type: WsMessageType.Error,
        errorMessage: `Failed to create session: ${(err as Error).message}`,
        code: 'SESSION_CREATE_FAILED',
      });
      return;
    }
  }

  if (isGoalKick) {
    const kickGoal = sessionManager.getGoal(effectiveSessionId);
    if (!session.isRoot() || kickGoal?.status !== 'active') {
      ctx.ws.send(effectiveSessionId, {
        type: WsMessageType.StatusInfo,
        content: '(Goal is no longer active)',
      });
      ctx.ws.send(effectiveSessionId, { type: WsMessageType.Done });
      return;
    }
  }

  const agentSelection = selectRunnableAgent(session.agentId);
  if (!agentSelection.ok || !agentSelection.agentId) {
    ctx.ws.send(effectiveSessionId, {
      type: WsMessageType.Error,
      errorMessage: agentSelection.message || 'No runnable agent is configured',
      code: 'AGENT_REQUIRED',
    });
    return;
  }
  const agentId = agentSelection.agentId;
  const agent = registry.agent(agentId);
  if (!agent) {
    ctx.ws.send(effectiveSessionId, { type: WsMessageType.Error, errorMessage: `Agent not found: ${agentId}`, code: 'AGENT_NOT_FOUND' });
    return;
  }

  // Store permission mode + effort so AgentLoop picks them up (frontend→server bridge)
  let goal = sessionManager.getGoal(effectiveSessionId);
  const resumesWaitingGoal = !isGoalKick
    && goal?.status === 'waiting_user'
    && !runtime.isSessionActive(effectiveSessionId);
  if (!isGoalKick && goal?.status === 'waiting_user') {
    if (resumesWaitingGoal) {
      await sessionManager.updateGoalStatus(effectiveSessionId, 'paused', 'Resuming after the previous Goal runner stopped');
    }
    goal = await sessionManager.updateGoalStatus(effectiveSessionId, 'active', 'User response received');
    const root = sessionManager.getRootSession(effectiveSessionId);
    ctx.ws.send(root.id, {
      type: WsMessageType.GoalChanged,
      sessionId: root.id,
      action: 'user_response',
      goal,
    });
  }
  const effectivePermissionMode = isGoalKick && goal
    ? resolveSessionPermissionMode(sessionManager, effectiveSessionId, goal.permissionMode)
    : resolveSessionPermissionMode(sessionManager, effectiveSessionId, msg.mode);
  const effectiveEffort = resolveSessionEffort(sessionManager, effectiveSessionId, msg.effort);
  if (session.isRoot() && !isGoalKick) {
    // An active Goal applies AutoEdit as a runtime overlay. Do not persist that
    // overlay over the user's root-session preference; it must resume afterward.
    if (goal?.status !== 'active') {
      await sessionManager.setSessionPermissionMode(effectiveSessionId, effectivePermissionMode);
    }
    await sessionManager.setSessionEffortMode(effectiveSessionId, effectiveEffort === 'HIGH');
  }
  const loopOptions = {
    permissionMode: effectivePermissionMode,
    effort: effectiveEffort,
    goalKick: isGoalKick || resumesWaitingGoal,
  };

  const rawContent = typeof msg.content === 'string' ? msg.content.trim() : '';
  const attachments = Array.isArray(msg.attachments) ? msg.attachments as IncomingAttachment[] : undefined;
  const userContent = buildUserContent(rawContent, attachments);

  // Soft interrupt: if session already has an active AgentLoop, queue the message
  // without creating a second loop. The running AgentLoop handles it mid-turn.
  // Must return BEFORE touching StreamPersister/event-buffer to avoid corrupting
  // the first handler's state.
  if (runtime.isSessionActive(effectiveSessionId)) {
    if (isGoalKick) {
      ctx.ws.send(effectiveSessionId, {
        type: WsMessageType.StatusInfo,
        content: '(Goal runner is already active)',
      });
      ctx.ws.send(effectiveSessionId, { type: WsMessageType.Done });
      return;
    }
    const userMsg: Message = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: effectiveSessionId,
      role: MessageRole.User,
      content: userContent,
      tokenCount: 0,
      compressed: false,
      timestamp: new Date().toISOString(),
    };
    await sessionManager.appendMessage(effectiveSessionId, userMsg, { notify: false });
    InterruptController.getInstance().setPendingUserMessage(effectiveSessionId, userContent);
    InterruptController.getInstance().requestInterrupt(effectiveSessionId, InterruptReason.UserSteer);
    ctx.ws.send(effectiveSessionId, {
      type: WsMessageType.StatusInfo,
      content: '(Message queued — agent will respond shortly)',
    });
    return;
  }

  // Build user message — merge attachment contents and metadata into text.
  const userMessage: Message = {
    id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: effectiveSessionId,
    role: MessageRole.User,
    content: userContent,
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
  };

  // Load history
  let history: Message[] = [];
  try {
    history = await sessionManager.getHistory(effectiveSessionId);
  } catch { /* fresh session */ }
  const fullHistory = history;

  // Append user message
  try {
    if (!isGoalKick) await sessionManager.appendMessage(effectiveSessionId, userMessage, { notify: false });
  } catch (err) {
    log.error('Failed to persist user message', { sid: effectiveSessionId, error: (err as Error).message });
  }

  // Stream agent response via WebSocket
  const store = SessionStore.getInstance();
  const turnMsgId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const initialPrevUuid = session.lastEventUuid || '00000000-0000-0000-0000-000000000000';
  const { StreamPersister } = await import('../../../infra/StreamPersister.js');
  const persister = new StreamPersister(store, effectiveSessionId, turnMsgId, initialPrevUuid, agentId);
  const { StreamConsumer } = await import('../../../infra/stream/StreamConsumer.js');
  const consumer = new StreamConsumer(ctx.ws, effectiveSessionId, persister, {
    editIntervalMs: 20,
    bufferThreshold: 1,
    freshFinalAfterMs: 30000,
  });

  let statusInterval: ReturnType<typeof setInterval> | null = null;
  try {
    statusInterval = setInterval(() => {
      ctx.ws.send(effectiveSessionId, {
        type: WsMessageType.StatusInfo,
        content: pickFunMessage(),
      });
    }, 3000);

    for await (const event of runtime.processMessage(effectiveSessionId, agentId, userMessage, fullHistory, loopOptions)) {
      switch (event.type) {
        case 'text':
          consumer.onDelta('text', event.content as string);
          break;
        case 'think':
          consumer.onDelta('think', event.content as string);
          break;
        case 'tool_call':
          await persister.flushDeltas();
          await consumer.beforeToolEvent();
          await persister.persistEvent('tool_call', {
            id: event.toolCallId || event.id || event.toolId || '',
            name: event.toolName || event.name || '',
            input: (event.params || event.args || event.input || event.toolInput || {}) as Record<string, unknown>,
          });
          consumer.sendDirect(event as unknown as Record<string, unknown>);
          break;
        case 'tool_result':
          await persister.flushDeltas();
          await consumer.beforeToolEvent();
          // Persist structured TodoWrite data so the todo list survives page refresh
          const structured = (event as Record<string, unknown>).structured as Record<string, unknown> | undefined;
          const todosPayload = structured?.todos as Array<{ content: string; status: string; activeForm: string }> | undefined;
          await persister.persistEvent('tool_result', {
            toolCallId: event.toolCallId || event.id || event.toolId || '',
            is_error: event.success === false,
            content: event.result || event.content || '',
            ...(todosPayload ? { todos: todosPayload } : {}),
          });
          if (todosPayload && Array.isArray(todosPayload)) {
            await persister.persistEvent('todo_write', {
              todos: todosPayload.map(t => ({ content: t.content, status: t.status, activeForm: t.activeForm })),
            });
          }
          consumer.sendDirect(event as unknown as Record<string, unknown>);
          break;
        case 'error':
          await consumer.beforeToolEvent();
          await persister.persistEvent('error', {
            error: event.errorMessage || event.message || event.content || 'Unknown error',
            source: 'agent_loop',
          });
          consumer.sendDirect(event as unknown as Record<string, unknown>);
          break;
        case 'plan_enter':
          await persister.flushDeltas();
          await persister.persistEvent('plan_enter', {});
          consumer.sendDirect(event as unknown as Record<string, unknown>);
          break;
        case 'plan_exit':
          await persister.flushDeltas();
          await persister.persistEvent('plan_exit', {});
          consumer.sendDirect(event as unknown as Record<string, unknown>);
          break;
        default:
          consumer.sendDirect(event as unknown as Record<string, unknown>);
      }
    }
    // Drain any remaining buffered think/text deltas
    await consumer.flushAndFinalize();

    // Rebuild message cache so next getHistory() is instant
    sessionManager.rebuildMessageCache(effectiveSessionId).catch(() => {});
  } catch (err) {
    if (statusInterval) clearInterval(statusInterval);
    const errorMessage = `Agent error: ${(err as Error).message}`;
    await persister.flushDeltas();
    await persister.persistEvent('error', { error: errorMessage, source: 'send_message_handler' });
    ctx.ws.send(effectiveSessionId, {
      type: WsMessageType.Error,
      errorMessage,
      code: 'AGENT_ERROR',
    });
  }

  // Update session UUID chain and touch meta after turn completes
  if (statusInterval) clearInterval(statusInterval);
  session.lastEventUuid = persister.prevUuid;
  session.touch();
  try {
    await store.updateMeta(effectiveSessionId, { lastActiveAt: session.lastActiveAt });
  } catch { /* non-critical */ }
};
