/**
 * WsForwardSubscriber — translates TypedEventBus events into WebSocket messages.
 *
 * This is the ONLY place that bridges backend domain events to the WebSocket
 * transport. Every TypedEventBus event that should reach the frontend is
 * forwarded here.
 *
 * @module WsForwardSubscriber
 */

import { TypedEventBus } from '../../core/events/TypedEventBus.js';
import { WsServer } from './WsServer.js';
import { SessionManager } from '../../core/session/SessionManager.js';
import { WsMessageType } from '../../../shared/types/ws-protocol.js';

function resolveRootSessionId(sessionId: string): string {
  try {
    const sm = SessionManager.getInstance();
    const root = sm.getRootSession(sessionId);
    return root.id;
  } catch {
    return sessionId;
  }
}

export function installWsForwarding(): void {
  const ws = WsServer.getInstance();

  // ═══════════════════════════════════════════════════════════════
  // Session lifecycle events
  // ═══════════════════════════════════════════════════════════════

  TypedEventBus.on('session:created', (payload) => {
    const sid = payload.parentSessionId || payload.sessionId;
    const rootId = resolveRootSessionId(sid);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.SessionCreated,
        sessionId: payload.sessionId,
        parentSessionId: payload.parentSessionId || null,
        agentId: payload.agentId,
      });
    }
  });

  TypedEventBus.on('session:message_appended', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.MessageAppended,
        sessionId: payload.sessionId,
        messageId: payload.messageId,
        role: payload.role,
      });
    }
  });

  TypedEventBus.on('session:workspace_changed', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.WorkspaceChanged,
        sessionId: payload.sessionId,
        workspace: payload.workspace,
      });
    }
  });

  // ── session:archived (triggers frontend tree refresh) ──
  TypedEventBus.on('session:archived', (payload) => {
    ws.broadcast({
      type: WsMessageType.SessionCreated, // reuse existing type to trigger frontend reload
      sessionId: payload.sessionId,
    });
  });

  // ── session:title_changed (triggers frontend session list update) ──
  TypedEventBus.on('session:title_changed', (payload) => {
    ws.broadcast({
      type: WsMessageType.SessionTitleChanged,
      sessionId: payload.sessionId,
      title: payload.title,
    });
  });

  // ── session:hard_deleted (triggers frontend session list removal) ──
  TypedEventBus.on('session:hard_deleted', (payload) => {
    ws.broadcast({
      type: WsMessageType.SessionHardDeleted,
      sessionId: payload.sessionId,
    });
  });

  // ── subsession_created (delegation) ──
  TypedEventBus.on('delegation:subsession_created', (payload) => {
    const rootId = resolveRootSessionId(payload.parentSessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.SubsessionCreated,
        sessionId: payload.sessionId,
        parentSessionId: payload.parentSessionId,
        agentId: payload.agentId,
        title: payload.title,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Agent lifecycle events
  // ═══════════════════════════════════════════════════════════════

  TypedEventBus.on('agent:status_changed', (payload) => {
    ws.broadcast({
      type: WsMessageType.AgentStatus,
      agentId: payload.agentId,
      oldStatus: payload.oldStatus,
      newStatus: payload.newStatus,
    });
  });

  TypedEventBus.on('agent:registered', (payload) => {
    ws.broadcast({
      type: WsMessageType.AgentRegistered,
      agentId: payload.agentId,
      role: payload.role,
      name: payload.name,
    });
  });

  // ── agent:config_updated → forward to frontend ──
  TypedEventBus.on('agent:config_updated', (payload) => {
    ws.broadcast({
      type: WsMessageType.AgentConfigUpdated,
      agentId: payload.agentId,
      role: payload.role,
      name: payload.name,
    });
  });

  // ── agent:unregistered → forward to frontend ──
  TypedEventBus.on('agent:unregistered', (payload) => {
    ws.broadcast({
      type: WsMessageType.AgentUnregistered,
      agentId: payload.agentId,
      role: payload.role,
      name: payload.name,
    });
  });

  // ── agent:changed → forward to frontend ──
  TypedEventBus.on('agent:changed', (payload) => {
    ws.broadcast({
      type: WsMessageType.AgentChanged,
      action: payload.action,
      agentId: payload.agentId,
    });
  });

  // ── talent_pool:changed → forward to frontend ──
  TypedEventBus.on('talent_pool:changed', (payload) => {
    ws.broadcast({
      type: WsMessageType.TalentPoolChanged,
      action: payload.action,
      entityId: payload.entityId,
    });
  });

  // ── memory:changed → forward to frontend ──
  TypedEventBus.on('memory:changed', (payload) => {
    ws.broadcast({
      type: WsMessageType.MemoryChanged,
      action: payload.action,
      name: payload.name,
      scope: payload.scope,
    });
  });

  // ── skill:changed → forward to frontend ──
  TypedEventBus.on('skill:changed', (payload) => {
    ws.broadcast({
      type: WsMessageType.SkillChanged,
      action: payload.action,
      name: payload.name,
    });
  });

  // ── plugin:load_failed → forward to frontend for error display ──
  TypedEventBus.on('plugin:load_failed', (payload) => {
    ws.broadcast({
      type: WsMessageType.PluginLoadFailed,
      pluginName: payload.pluginName,
      error: payload.error,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Tool execution events
  // ═══════════════════════════════════════════════════════════════

  TypedEventBus.on('tool:execution_started', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.ToolExecutionStarted,
        sessionId: payload.sessionId,
        toolName: payload.toolName,
      });
    }
  });

  TypedEventBus.on('tool:execution_completed', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.ToolExecutionCompleted,
        sessionId: payload.sessionId,
        toolName: payload.toolName,
        success: payload.success,
        durationMs: payload.durationMs,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Loop lifecycle events
  // ═══════════════════════════════════════════════════════════════

  TypedEventBus.on('loop:completed', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.LoopCompleted,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        turnCount: payload.turnCount,
        totalTokens: payload.totalTokens,
      });
    }
  });

  TypedEventBus.on('loop:compaction_triggered', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.CompactionTriggered,
        sessionId: payload.sessionId,
        beforeTokens: payload.beforeTokens,
        afterTokens: payload.afterTokens,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Delegation lifecycle events
  // ═══════════════════════════════════════════════════════════════

  TypedEventBus.on('delegation:started', (payload) => {
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.DelegationStatus,
        parentSessionId: payload.parentSessionId,
        subSessionId: payload.subSessionId,
        subAgentId: payload.subAgentId,
        phase: 'started',
        taskSummary: payload.taskSummary,
        timestamp: new Date().toISOString(),
      });
    }
  });

  TypedEventBus.on('delegation:working', (payload) => {
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.DelegationStatus,
        parentSessionId: payload.parentSessionId,
        subSessionId: payload.subSessionId,
        subAgentId: payload.subAgentId,
        phase: 'working',
        taskSummary: payload.taskSummary,
        turnCount: payload.turnCount,
        currentTool: payload.currentTool,
        elapsedMs: payload.elapsedMs,
        timestamp: new Date().toISOString(),
      });
    }
  });

  TypedEventBus.on('delegation:tool_executing', (payload) => {
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.DelegationStatus,
        parentSessionId: payload.parentSessionId,
        subSessionId: payload.subSessionId,
        subAgentId: payload.subAgentId,
        phase: 'tool_executing',
        taskSummary: payload.taskSummary,
        turnCount: payload.turnCount,
        currentTool: payload.currentTool,
        elapsedMs: payload.elapsedMs,
        timestamp: new Date().toISOString(),
      });
    }
  });

  TypedEventBus.on('delegation:completed', (payload) => {
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.DelegationStatus,
        parentSessionId: payload.parentSessionId,
        subSessionId: payload.subSessionId,
        subAgentId: payload.subAgentId,
        phase: 'completed',
        taskSummary: payload.taskSummary,
        turnCount: payload.turnCount,
        elapsedMs: payload.elapsedMs,
        timestamp: new Date().toISOString(),
      });
    }
  });

  TypedEventBus.on('delegation:error', (payload) => {
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.DelegationStatus,
        parentSessionId: payload.parentSessionId,
        subSessionId: payload.subSessionId,
        subAgentId: payload.subAgentId,
        phase: 'error',
        taskSummary: payload.taskSummary,
        elapsedMs: payload.elapsedMs,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── delegation:progress ──
  TypedEventBus.on('delegation:progress', (payload) => {
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.DelegationProgress,
        subSessionId: payload.subSessionId,
        subAgentId: payload.subAgentId,
        originalType: payload.originalType,
        content: payload.content,
        toolName: payload.toolName,
        timestamp: payload.timestamp,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Task notification events (BackgroundTaskManager)
  // ═══════════════════════════════════════════════════════════════

  TypedEventBus.on('task:completed', (payload) => {
    // Send to the direct parent session — NOT resolved to root.
    // Resolving to root leaks sub-agent notifications into the CEO's chat.
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.TaskNotification,
        parentSessionId: payload.parentSessionId,
        taskId: payload.taskId,
        parentAgentId: payload.parentAgentId,
        taskStatus: 'completed' as const,
        taskSummary: payload.summary,
        taskResult: payload.content.slice(0, 2000),
        turnCount: payload.turnCount,
        durationMs: payload.durationMs,
      });
    }
  });

  TypedEventBus.on('task:failed', (payload) => {
    const directParentId = payload.parentSessionId;
    if (ws.isConnected(directParentId)) {
      ws.send(directParentId, {
        type: WsMessageType.TaskNotification,
        parentSessionId: payload.parentSessionId,
        taskId: payload.taskId,
        parentAgentId: payload.parentAgentId,
        taskStatus: 'failed' as const,
        taskSummary: payload.summary,
        taskResult: payload.error.slice(0, 500),
        durationMs: payload.durationMs,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Task registry updates (BackgroundTaskManager → frontend panel)
  // ═══════════════════════════════════════════════════════════════

  TypedEventBus.on('task:registry_update', (payload) => {
    const task = payload.task;
    const rootId = resolveRootSessionId(task.parentSessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.TaskListUpdate,
        id: task.id,
        taskType: task.type,
        parentSessionId: task.parentSessionId,
        parentAgentId: task.parentAgentId,
        summary: task.summary,
        status: task.status,
        startedAt: task.startedAt,
        turnCount: task.turnCount,
        currentTool: task.currentTool,
        durationMs: task.durationMs,
        error: task.error,
        pid: task.pid,
        command: task.command,
      });
    }
  });

  TypedEventBus.on('artifact:created', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.ArtifactCreated,
        sessionId: payload.sessionId,
        artifactId: payload.artifactId,
        artifact: payload.artifact,
      });
    }
  });

  TypedEventBus.on('artifact:updated', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.ArtifactUpdated,
        sessionId: payload.sessionId,
        artifactId: payload.artifactId,
        artifact: payload.artifact,
      });
    }
  });

  TypedEventBus.on('artifact:preview', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.ArtifactPreview,
        sessionId: payload.sessionId,
        artifactId: payload.artifactId,
        preview: payload.preview,
        artifact: payload.artifact,
      });
    }
  });

  TypedEventBus.on('artifact:done', (payload) => {
    const rootId = resolveRootSessionId(payload.sessionId);
    if (ws.isConnected(rootId)) {
      ws.send(rootId, {
        type: WsMessageType.ArtifactDone,
        sessionId: payload.sessionId,
        artifactId: payload.artifactId,
        artifact: payload.artifact,
      });
    }
  });
}
