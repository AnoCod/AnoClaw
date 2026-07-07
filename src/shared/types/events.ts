/**
 * AnoClaw — Event Constants + TypedEventMap
 *
 * Named event string constants used by existing EventEmitters,
 * plus the TypedEventMap that powers the centralized TypedEventBus.
 * All new events go through TypedEventBus; existing EventEmitter
 * constants are retained for backward compat during migration.
 */

import type { ArtifactPreview, ArtifactRecord } from './artifact.js';

/** Events emitted by individual Agent instances. */
export const AgentEvents = {
  NameChanged: 'nameChanged',
  StatusChanged: 'statusChanged',
  RoleChanged: 'roleChanged',
  ConfigUpdated: 'configUpdated',
  ActiveStateChanged: 'activeStateChanged',
  SessionCountChanged: 'sessionCountChanged',
} as const;

/** Events emitted by AgentRegistry (global agent registration and org tree changes). */
export const AgentRegistryEvents = {
  AgentRegistered: 'agentRegistered',
  AgentUnregistered: 'agentUnregistered',
  AgentStatusChanged: 'agentStatusChanged',
  OrgTreeChanged: 'orgTreeChanged',
} as const;

/** Events emitted by AgentRuntime during agent execution. */
export const AgentRuntimeEvents = {
  StreamingToken: 'streamingToken',
  ToolCallStarted: 'toolCallStarted',
  ToolCallFinished: 'toolCallFinished',
  AgentLoopCompleted: 'agentLoopCompleted',
  TaskProgressUpdate: 'taskProgressUpdate',
} as const;

/** Events related to session lifecycle and message flow. */
export const SessionEvents = {
  Created: 'sessionCreated',
  Archived: 'sessionArchived',
  MessageAppended: 'messageAppended',
  TitleChanged: 'titleChanged',
} as const;

/** Events emitted when tools are executed or fail. */
export const ToolEvents = {
  Executed: 'executed',
  Error: 'toolError',
} as const;

/** Events emitted by the MCP (Model Context Protocol) subsystem. */
export const MCPEvents = {
  ServerConnected: 'serverConnected',
  ServerDisconnected: 'serverDisconnected',
  ToolsChanged: 'toolsChanged',
} as const;

/** Events emitted by the supervision/heartbeat monitoring layer. */
export const SupervisionEvents = {
  TaskProgressChanged: 'taskProgressChanged',
  HeartbeatMissed: 'heartbeatMissed',
  AgentUnresponsive: 'agentUnresponsive',
} as const;

/** Events emitted by the logging subsystem. */
export const LogEvents = {
  NewLogEntry: 'newLogEntry',
} as const;

// ── TypedEventMap — typed event registry for TypedEventBus ──

/**
 * Kernel-declared events with typed payloads.
 * Emitters and subscribers get compile-time type checking for these keys.
 * New kernel events MUST be added here — no ad-hoc string keys.
 */
export interface CoreEventMap {
  // session
  'session:created': { sessionId: string; agentId: string; parentSessionId?: string };
  'session:archived': { sessionId: string };
  'session:message_appended': { sessionId: string; messageId: string; role: string };
  'session:workspace_changed': { sessionId: string; workspace: string };
  'session:archiving': { sessionId: string };
  'session:title_changed': { sessionId: string; title: string };
  'session:hard_deleted': { sessionId: string };

  // tool
  'tool:execution_started': { sessionId: string; agentId: string; toolName: string };
  'tool:execution_completed': { sessionId: string; agentId: string; toolName: string; success: boolean; durationMs: number; tokensUsed: number };
  'tool:executed': { toolName: string; sessionId: string; agentId: string; params: Record<string, unknown> };
  'tool:error': { toolName: string; sessionId: string; agentId: string; error: string };

  // loop
  'loop:completed': { sessionId: string; agentId: string; turnCount: number; totalTokens: number };
  'loop:keyword_turn': { sessionId: string; agentId: string; turnNumber: number; userMessages: string[]; assistantMessages: string[] };
  'loop:compaction_triggered': { sessionId: string; beforeTokens: number; afterTokens: number };

  // llm
  'llm:token_usage': { sessionId: string; inputTokens: number; outputTokens: number; totalTokens: number };

  // memory
  'memory:retrieved': { agentId: string; scope: string; query: string; memoryNames: string[] };
  'memory:changed': { action: 'created' | 'updated' | 'deleted'; name: string; scope: string };

  // skill
  'skill:loaded': { agentId: string; skillNames: string[] };
  'skill:changed': { action: 'created' | 'updated' | 'deleted' | 'reloaded'; name: string };

  // evolution
  'evolution:score_saved': { score: { id: string; sessionId: string; agentId: string; messageId: string; score: number } };
  'evolution:analysis_complete': { reportId: string; mode: string; totalFindings: number; criticalFindings: number };

  // talent pool
  'talent_pool:changed': { action: 'group_created' | 'group_updated' | 'group_deleted' | 'template_created' | 'template_deleted' | 'hired'; entityId: string };

  // delegation
  'delegation:started': { parentSessionId: string; subSessionId: string; subAgentId: string; taskSummary: string };
  'delegation:working': { parentSessionId: string; subSessionId: string; subAgentId: string; taskSummary: string; turnCount: number; currentTool?: string; elapsedMs: number };
  'delegation:tool_executing': { parentSessionId: string; subSessionId: string; subAgentId: string; taskSummary: string; turnCount: number; currentTool: string; elapsedMs: number };
  'delegation:completed': { parentSessionId: string; subSessionId: string; subAgentId: string; taskSummary: string; turnCount: number; elapsedMs: number };
  'delegation:error': { parentSessionId: string; subSessionId: string; subAgentId: string; taskSummary: string; elapsedMs: number };
  'delegation:progress': { parentSessionId: string; subSessionId: string; subAgentId: string; originalType: string; content: string; toolName?: string; timestamp: string };
  'delegation:subsession_created': { sessionId: string; parentSessionId: string; agentId: string; title?: string };

  // agent
  'agent:message': { fromAgentId: string; toAgentId: string; content: string; role: 'system' | 'user'; sessionId: string };
  'agent:status_changed': { agentId: string; oldStatus: string; newStatus: string };
  'agent:registered': { agentId: string; role: string; name: string };
  'agent:config_updated': { agentId: string; role: string; name: string };
  'agent:unregistered': { agentId: string; role: string; name: string };
  'agent:changed': { action: 'state' | 'parent' | 'reloaded'; agentId: string; };

  // task
  'task:completed': { taskId: string; parentSessionId: string; parentAgentId: string; type: string; summary: string; turnCount: number; durationMs: number; content: string };
  'task:failed': { taskId: string; parentSessionId: string; parentAgentId: string; type: string; summary: string; durationMs: number; error: string };
  'task:registry_update': { task: { id: string; type: string; parentSessionId: string; parentAgentId: string; summary: string; status: string; startedAt: number; turnCount?: number; currentTool?: string; durationMs?: number; error?: string; pid?: number; command?: string } };

  // subscription
  'subscription:delivered': { sessionId: string; agentId: string; topic: string; subscriberCount: number }; // @internal — emitted by EventSubscriptionManager.publish() for observability

  // artifacts
  'artifact:created': { sessionId: string; artifactId: string; artifact: ArtifactRecord };
  'artifact:updated': { sessionId: string; artifactId: string; artifact: ArtifactRecord };
  'artifact:preview': { sessionId: string; artifactId: string; artifact: ArtifactRecord; preview: ArtifactPreview };
  'artifact:done': { sessionId: string; artifactId: string; artifact: ArtifactRecord };

  // plugin
  'plugin:load_failed': { pluginName: string; error: string };
}

/**
 * Open-ended event map for the full TypedEventBus.
 * Core events are typed; plugins and future events fall back to `unknown`.
 */
export interface TypedEventMap extends CoreEventMap {
  [event: string]: unknown;
}

/** WebSocket streaming event type enum (bidirectional between server and browser). */
export enum WsMessageType {
  // Server → Client
  Think       = 'think',
  Text        = 'text',
  ToolCall    = 'tool_call',
  ToolResult  = 'tool_result',
  PlanEnter   = 'plan_enter',
  PlanExit    = 'plan_exit',
  TodoWrite   = 'todo_write',
  SubsessionCreated = 'subsession_created',
  Error       = 'error',
  Done        = 'done',
  Sleep       = 'sleep',
  Wake        = 'wake',
  Pong        = 'pong',
  ToolConfirmRequest = 'tool_confirm_request',
  // Client → Server
  SendMessage   = 'send_message',
  Stop          = 'stop',
  Ping          = 'ping',
  RunCommand    = 'run_command',
  SetSessionMode = 'set_session_mode',
  SetGoal       = 'set_goal',
  QualityScore  = 'quality_score',
  EditorContext = 'editor_context',
  ToolConfirmResponse = 'tool_confirm_response',
  // Server → Client (delegation / commands)
  DelegationProgress = 'delegation_progress',
  DelegationStatus = 'delegation_status',
  // Task notification (background task completion/failure)
  TaskNotification = 'task_notification',
  TaskResolution = 'task_resolution',
  CommandResult = 'command_result',
  StatusInfo  = 'status',
  // Agent lifecycle events
  AgentStatus = 'agent_status',
  AgentRegistered = 'agent_registered',
  AgentUnregistered = 'agent_unregistered',
  // Session lifecycle events (from WsForwardSubscriber)
  SessionCreated = 'session_created',
  MessageAppended = 'message_appended',
  WorkspaceChanged = 'workspace_changed',
  SessionModeChanged = 'session_mode_changed',
  GoalChanged = 'goal_changed',
  // Tool execution events
  ToolExecutionStarted = 'tool_execution_started',
  ToolExecutionCompleted = 'tool_execution_completed',
  // Loop lifecycle events
  LoopCompleted = 'loop_completed',
  CompactionTriggered = 'compaction_triggered',
  // Memory/Skill/Agent/TalentPool lifecycle events
  MemoryChanged = 'memory_changed',
  SkillChanged = 'skill_changed',
  AgentChanged = 'agent_changed',
  TalentPoolChanged = 'talent_pool_changed',
  SessionTitleChanged = 'session_title_changed',
  SessionHardDeleted = 'session_hard_deleted',
  AgentConfigUpdated = 'agent_config_updated',
  PluginLoadFailed = 'plugin_load_failed',
  TaskListUpdate = 'task_list_update',
  QualityScoreAck = 'quality_score_ack',
  QualityScoreError = 'quality_score_error',
  ArtifactCreated = 'artifact_created',
  ArtifactUpdated = 'artifact_updated',
  ArtifactPreview = 'artifact_preview',
  ArtifactDone = 'artifact_done',
}

/** Generic WebSocket message shape for event dispatch (backward compat). */
export interface WsMessage {
  type: WsMessageType | string;
  [key: string]: unknown;
}

/** Typed discriminated union for typed message handling.
 *  Use when you know the exact message type at compile time.
 *  Fall back to WsMessage for dynamic dispatch. */
export type WsTypedMessage =
  | { type: WsMessageType.Think; content: string; durationMs?: number; [key: string]: unknown }
  | { type: WsMessageType.Text; content: string; [key: string]: unknown }
  | { type: WsMessageType.ToolCall; toolName: string; toolInput?: Record<string, unknown>; [key: string]: unknown }
  | { type: WsMessageType.ToolResult; success?: boolean; content?: string; [key: string]: unknown }
  | { type: WsMessageType.PlanEnter; [key: string]: unknown }
  | { type: WsMessageType.PlanExit; [key: string]: unknown }
  | { type: WsMessageType.TodoWrite; todos: Array<{ content: string; status: string }>; [key: string]: unknown }
  | { type: WsMessageType.SubsessionCreated; sessionId: string; parentSessionId: string; [key: string]: unknown }
  | { type: WsMessageType.Error; errorMessage?: string; code?: string; [key: string]: unknown }
  | { type: WsMessageType.Done; turnCount?: number; tokenUsage?: import('./session.js').TokenBreakdown; [key: string]: unknown }
  | { type: WsMessageType.Sleep; content?: string; [key: string]: unknown }
  | { type: WsMessageType.Wake; content?: string; [key: string]: unknown }
  | { type: WsMessageType.Pong; [key: string]: unknown }
  | { type: WsMessageType.ToolConfirmRequest; toolCallId: string; toolName: string; riskLevel: string; params: Record<string, unknown>; [key: string]: unknown }
  | { type: WsMessageType.SendMessage; content?: string; mode?: string; effort?: boolean; [key: string]: unknown }
  | { type: WsMessageType.Stop; [key: string]: unknown }
  | { type: WsMessageType.Ping; [key: string]: unknown }
  | { type: WsMessageType.RunCommand; command?: string; args?: Record<string, string>; [key: string]: unknown }
  | { type: WsMessageType.SetSessionMode; mode?: string; effort?: boolean; [key: string]: unknown }
  | { type: WsMessageType.SetGoal; action?: string; objective?: string; [key: string]: unknown }
  | { type: WsMessageType.QualityScore; score?: number; [key: string]: unknown }
  | { type: WsMessageType.EditorContext; openFiles?: string[]; [key: string]: unknown }
  | { type: WsMessageType.ToolConfirmResponse; toolCallId: string; approved: boolean; [key: string]: unknown }
  | { type: WsMessageType.DelegationProgress; content?: string; [key: string]: unknown }
  | { type: WsMessageType.DelegationStatus; content?: string; [key: string]: unknown }
  | { type: WsMessageType.TaskNotification; taskStatus?: string; taskSummary?: string; taskResult?: string; [key: string]: unknown }
  | { type: WsMessageType.TaskResolution; taskResolution?: unknown; [key: string]: unknown }
  | { type: WsMessageType.CommandResult; content?: string; [key: string]: unknown }
  | { type: WsMessageType.StatusInfo; content?: string; [key: string]: unknown }
  | { type: WsMessageType.AgentStatus; agentId?: string; name?: string; [key: string]: unknown }
  | { type: WsMessageType.AgentRegistered; agentId?: string; name?: string; role?: string; [key: string]: unknown }
  | { type: WsMessageType.AgentUnregistered; agentId?: string; [key: string]: unknown }
  | { type: WsMessageType.SessionCreated; sessionId?: string; [key: string]: unknown }
  | { type: WsMessageType.MessageAppended; sessionId?: string; [key: string]: unknown }
  | { type: WsMessageType.WorkspaceChanged; [key: string]: unknown }
  | { type: WsMessageType.SessionModeChanged; sessionId?: string; mode?: string; effort?: boolean; locked?: boolean; [key: string]: unknown }
  | { type: WsMessageType.GoalChanged; sessionId?: string; action?: string; goal?: unknown; [key: string]: unknown }
  | { type: WsMessageType.ToolExecutionStarted; toolName?: string; [key: string]: unknown }
  | { type: WsMessageType.ToolExecutionCompleted; toolName?: string; success?: boolean; durationMs?: number; tokensUsed?: number; [key: string]: unknown }
  | { type: WsMessageType.LoopCompleted; turnCount?: number; totalTokens?: number; [key: string]: unknown }
  | { type: WsMessageType.CompactionTriggered; beforeTokens?: number; afterTokens?: number; [key: string]: unknown }
  | { type: WsMessageType.MemoryChanged; action?: string; name?: string; scope?: string; [key: string]: unknown }
  | { type: WsMessageType.SkillChanged; action?: string; name?: string; [key: string]: unknown }
  | { type: WsMessageType.AgentChanged; action?: string; agentId?: string; [key: string]: unknown }
  | { type: WsMessageType.TalentPoolChanged; action?: string; [key: string]: unknown }
  | { type: WsMessageType.SessionTitleChanged; sessionId?: string; title?: string; [key: string]: unknown }
  | { type: WsMessageType.SessionHardDeleted; sessionId?: string; [key: string]: unknown }
  | { type: WsMessageType.ArtifactCreated; sessionId: string; artifactId: string; artifact?: ArtifactRecord; [key: string]: unknown }
  | { type: WsMessageType.ArtifactUpdated; sessionId: string; artifactId: string; artifact?: ArtifactRecord; [key: string]: unknown }
  | { type: WsMessageType.ArtifactPreview; sessionId: string; artifactId: string; preview?: ArtifactPreview; artifact?: ArtifactRecord; [key: string]: unknown }
  | { type: WsMessageType.ArtifactDone; sessionId: string; artifactId: string; artifact?: ArtifactRecord; [key: string]: unknown }
  // Catch-all for forward compat
  | { type: string; [key: string]: unknown };

// Legacy SSEEventType alias — keep for backward compat during migration
export import SSEEventType = WsMessageType;
export type SSEEvent = WsMessage;
