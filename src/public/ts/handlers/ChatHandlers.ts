// ChatHandlers — registers message handlers for chat/conversation WS events.
// Routes directly to SessionAgent — no global event switch, no pointer swap, no silent emit.

import type { WSMessageRouter } from '../viewmodel/WSMessageRouter.js';
import type { ConversationViewModel } from '../viewmodel/ConversationViewModel.js';
import type { SessionViewModel } from '../viewmodel/SessionViewModel.js';
import type { SessionStatus } from '../types.js';
import { ClientLogger } from '../ClientLogger.js';
import { BackgroundTaskStore } from '../viewmodel/BackgroundTaskStore.js';
import { slotRegistry } from '../SlotRegistry.js';
import { ToastManager } from '../ToastManager.js';
import { ToolConfirmationQueue } from '../viewmodel/ToolConfirmationQueue.js';

export function registerChatHandlers(
  router: WSMessageRouter,
  conversationVM: ConversationViewModel,
  sessionVM: SessionViewModel,
): void {
  // Chat streaming events — route directly to the owning SessionAgent
  const chatTypes = [
    'think', 'text', 'tool_call', 'tool_result', 'done', 'error',
    'plan_enter', 'plan_exit', 'todo_write', 'delegation_progress',
    'status', 'sleep', 'wake', 'task_notification',
  ];

  for (const type of chatTypes) {
    router.on(type, (ctx) => {
      const agent = conversationVM.getAgent(ctx.sessionId);
      agent.onServerEvent(ctx.type, ctx.data);
    });
  }

  // command_result — handle slash command results
  router.on('command_result', (ctx) => {
    const data = ctx.data as { success: boolean; command: string; output: string };
    if (data.command === 'compact' && data.success) {
      const sessionId = ctx.sessionId;
      if (sessionId) {
        ClientLogger.ui.info('Compact completed, reloading history');
        conversationVM.getAgent(sessionId).loadHistory().catch(() => {});
        window.dispatchEvent(new CustomEvent('compaction-completed', { detail: { sessionId } }));
      }
    }
    if (data.command === 'compact' && !data.success) {
      window.dispatchEvent(new CustomEvent('compaction-completed', { detail: { sessionId: ctx.sessionId } }));
    }
    if (data.success) {
      ToastManager.getInstance().success(data.output || `${data.command} completed`);
    } else {
      ToastManager.getInstance().error(data.output || `${data.command} failed`);
    }
  });

  // subsession_created — adds node to session tree
  router.on('subsession_created', (ctx) => {
    const d = ctx.data as { sessionId: string; parentSessionId: string; agentId: string; title: string; level?: number };
    const parentNode = sessionVM.sessions.getById(d.parentSessionId);
    sessionVM.sessions.addSession({
      id: d.sessionId,
      title: d.title || `Sub: ${d.agentId}`,
      parentId: d.parentSessionId,
      parentSessionId: d.parentSessionId,
      agentId: d.agentId,
      status: 'working',
      type: 'Sub',
      isMain: false,
      canWrite: false,
      level: d.level ?? (parentNode ? (parentNode.level || 0) + 1 : 1),
      children: [],
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
  });

  // delegation_status — update session tree node status (only if changed)
  router.on('delegation_status', (ctx) => {
    const d = ctx.data as { subSessionId: string; subAgentId: string; phase: string };
    const newStatus: SessionStatus = d.phase === 'completed' ? 'Idle' : d.phase === 'error' ? 'error' : 'working';
    const existing = sessionVM.sessions.getById(d.subSessionId);
    if (!existing || existing.status !== newStatus) {
      sessionVM.sessions.updateSession({ id: d.subSessionId, status: newStatus });
    }
    // Also deliver to parent session's agent for UI updates
    const agent = conversationVM.getAgent(ctx.sessionId);
    agent.onServerEvent('delegation_status', ctx.data);
  });

  // ── WsForwardSubscriber lifecycle events ──

  router.on('session_created', (_ctx) => {
    ClientLogger.ui.info('New session created, refreshing tree');
    sessionVM.loadSessions().catch(() => {});
  });

  // message_appended — API-injected message, refresh conversation
  router.on('message_appended', (ctx) => {
    const sid = ctx.data.sessionId as string || ctx.sessionId;
    if (sid) {
      const agent = conversationVM.getAgent(sid);
      const isActiveSession = sid === conversationVM.getActiveSessionId();
      const role = ctx.data.role as string | undefined;
      const lastLocalUser = [...agent.state.messages.messages]
        .reverse()
        .find((m) => m.role === 'user');
      const isRecentOptimisticUser =
        role === 'user' &&
        isActiveSession &&
        !!lastLocalUser &&
        Date.now() - Number(lastLocalUser.timestamp || 0) < 30000;

      if (agent.state.isStreaming || isRecentOptimisticUser) {
        ClientLogger.ui.debug('Skipping history reload for local streaming append', { sid, role });
        return;
      }
      ClientLogger.ui.info('Message appended externally, reloading history');
      agent.loadHistory().catch(() => {});
    }
  });

  router.on('compaction_triggered', (ctx) => {
    const sid = ctx.sessionId || (ctx.data as { sessionId?: string }).sessionId;
    if (sid) {
      ClientLogger.ui.info('Compaction triggered, reloading history');
      conversationVM.getAgent(sid).loadHistory().catch(() => {});
    }
  });

  router.on('quality_score_ack', (_ctx) => {
    ClientLogger.ui.info('Quality score saved');
  });

  router.on('quality_score_error', (ctx) => {
    const d = ctx.data as { error: string };
    ClientLogger.ui.warn('Quality score failed', d);
  });

  router.on('plugin_load_failed', (ctx) => {
    const d = ctx.data as { pluginName?: string; error?: string };
    const name = d.pluginName || 'plugin';
    ToastManager.getInstance().show('error', `Plugin "${name}" failed to load: ${d.error || 'unknown error'}`, 8000);
  });

  router.on('tool_execution_started', (ctx) => {
    const d = ctx.data as { sessionId: string; agentId?: string; toolName: string };
    ClientLogger.ui.info('Tool started', { tool: d.toolName, session: d.sessionId });
  });

  router.on('tool_execution_completed', (ctx) => {
    const d = ctx.data as { sessionId: string; agentId?: string; toolName: string; success: boolean; durationMs: number };
    ClientLogger.ui.info('Tool completed', { tool: d.toolName, success: d.success, ms: d.durationMs });
  });

  router.on('loop_completed', (ctx) => {
    const d = ctx.data as { sessionId: string; agentId: string; turnCount: number; totalTokens: number };
    ClientLogger.ui.info('Agent loop completed', { agent: d.agentId, turns: d.turnCount, tokens: d.totalTokens });
  });

  // task_list_update — background task panel refresh
  router.on('task_list_update', (ctx) => {
    const d = ctx.data as Record<string, unknown>;
    const store = BackgroundTaskStore.getInstance();
    store.upsert(d);
  });

  // plugin:ui:mount — plugin wants to mount content into a named slot
  router.on('plugin:ui:mount', (ctx) => {
    const d = ctx.data as { slot: string; htmlContent: string; opts?: { position?: 'append' | 'prepend'; replace?: boolean; id?: string; priority?: number }; pluginName: string };
    console.log(`[Plugin] WS mount request → slot="${d.slot}" plugin="${d.pluginName}"`);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = d.htmlContent;
    const el = wrapper.firstElementChild as HTMLElement;
    if (el) {
      slotRegistry.mount(d.slot, el, d.opts || {}, d.opts?.replace, d.pluginName);
    } else {
      console.warn(`[Plugin] WS mount failed — no valid element in htmlContent for slot="${d.slot}"`);
    }
  });

  // plugin:ui:unmountAll — plugin wants to clear all its content from a slot
  router.on('plugin:ui:unmountAll', (ctx) => {
    const d = ctx.data as { slot: string; pluginName: string };
    console.log(`[Plugin] WS unmountAll request → slot="${d.slot}" plugin="${d.pluginName}"`);
    slotRegistry.unmountAll(d.slot, d.pluginName);
  });

  // system:toast — backend-triggered toast notifications (plugin errors, system alerts)
  router.on('system:toast', (ctx) => {
    const d = ctx.data as { toastType?: string; message: string; duration?: number };
    const type = (d.toastType === 'error' || d.toastType === 'success' || d.toastType === 'info')
      ? d.toastType : 'info';
    ToastManager.getInstance().show(type, d.message, d.duration ?? 5000);
  });

  // tool_confirm_request — route to confirmation queue
  router.on('tool_confirm_request', (ctx) => {
    const d = ctx.data as {
      toolCallId: string; toolName: string; displayName: string;
      riskLevel: string; params: Record<string, unknown>;
    };
    ToolConfirmationQueue.getInstance().enqueue({
      toolCallId: d.toolCallId,
      toolName: d.toolName,
      displayName: d.displayName || d.toolName,
      riskLevel: d.riskLevel,
      params: d.params || {},
    });
  });
}
