/**
 * AnoClaw — Event Constants + TypedEventMap
 *
 * Named event string constants used by existing EventEmitters,
 * plus the TypedEventMap that powers the centralized TypedEventBus.
 * All new events go through TypedEventBus; existing EventEmitter
 * constants are retained for backward compat during migration.
 */

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

  // tool
  'tool:execution_started': { sessionId: string; agentId: string; toolName: string };
  'tool:execution_completed': { sessionId: string; agentId: string; toolName: string; success: boolean; durationMs: number; tokensUsed: number };

  // loop
  'loop:completed': { sessionId: string; agentId: string; turnCount: number; totalTokens: number };
  'loop:keyword_turn': { sessionId: string; agentId: string; turnNumber: number; userMessages: string[]; assistantMessages: string[] };
  'loop:compaction_triggered': { sessionId: string; beforeTokens: number; afterTokens: number };

  // llm
  'llm:token_usage': { sessionId: string; inputTokens: number; outputTokens: number; totalTokens: number };

  // memory
  'memory:retrieved': { agentId: string; scope: string; query: string; memoryNames: string[] };

  // skill
  'skill:loaded': { agentId: string; skillNames: string[] };

  // evolution
  'evolution:score_saved': { score: { id: string; sessionId: string; agentId: string; messageId: string; score: number } };
  'evolution:analysis_complete': { reportId: string; mode: string; totalFindings: number; criticalFindings: number };

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

  // task
  'task:completed': { taskId: string; parentSessionId: string; parentAgentId: string; type: string; summary: string; turnCount: number; durationMs: number; content: string };
  'task:failed': { taskId: string; parentSessionId: string; parentAgentId: string; type: string; summary: string; durationMs: number; error: string };
  'task:registry_update': { task: { id: string; type: string; parentSessionId: string; parentAgentId: string; summary: string; status: string; startedAt: number; turnCount?: number; currentTool?: string; durationMs?: number; error?: string; pid?: number; command?: string } };

  // subscription
  'subscription:delivered': { sessionId: string; agentId: string; topic: string; subscriberCount: number }; // @internal — emitted by EventSubscriptionManager.publish() for observability

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
  // Client → Server
  SendMessage   = 'send_message',
  Stop          = 'stop',
  Ping          = 'ping',
  RunCommand    = 'run_command',
  EditorContext = 'editor_context',
  // Server → Client (delegation / commands)
  DelegateResult = 'delegate_result',
  ApprovalRequest = 'approval_request',
  DelegationProgress = 'delegation_progress',
  DelegationStatus = 'delegation_status',
  // Task notification (background task completion/failure)
  TaskNotification = 'task_notification',
  CommandResult = 'command_result',
  StatusInfo  = 'status',
  // Agent lifecycle events
  AgentStatus = 'agent_status',
  AgentRegistered = 'agent_registered',
  // Session lifecycle events (from WsForwardSubscriber)
  SessionCreated = 'session_created',
  MessageAppended = 'message_appended',
  WorkspaceChanged = 'workspace_changed',
  // Tool execution events
  ToolExecutionStarted = 'tool_execution_started',
  ToolExecutionCompleted = 'tool_execution_completed',
  // Loop lifecycle events
  LoopCompleted = 'loop_completed',
  CompactionTriggered = 'compaction_triggered',
}

/** Generic WebSocket message shape for event dispatch. */
export interface WsMessage {
  type: WsMessageType;
  [key: string]: unknown;
}

// Legacy SSEEventType alias — keep for backward compat during migration
export import SSEEventType = WsMessageType;
export type SSEEvent = WsMessage;
