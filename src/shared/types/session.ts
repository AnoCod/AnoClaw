// Session, message, and transcript types
// v2.1 — Claude-style content blocks + uuid chain (JSONL layer only)

export enum SessionType {
  Main = 'Main',
  Sub  = 'Sub',
}

export enum SessionStatus {
  Active   = 'Active',
  Idle     = 'Idle',
  Archived = 'Archived',
}

export interface SessionNode {
  sessionId: string;
  parentSessionId: string | null;
  level: number;
  agentId: string;
  type: SessionType;
  status: SessionStatus;
  title: string;
  workspace: string;
  createdAt: string;        // ISO8601
  lastActiveAt: string;     // ISO8601
  subSessionIds: string[];
  metadata: Record<string, unknown>;
}

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'waiting_user'
  | 'waiting_confirmation'
  | 'waiting_review'
  | 'blocked'
  | 'failed'
  | 'budget_exhausted'
  | 'completed'
  | 'deleted';

export type GoalReportOutcome =
  | 'progress'
  | 'waiting_user'
  | 'waiting_review'
  | 'blocked'
  | 'failed';

/** Canonical permission modes persisted on root sessions. `Auto` is Safe Auto. */
export type PermissionMode = 'Ask' | 'AutoEdit' | 'Plan' | 'Auto';

/** Internal execution constraints passed through the tool pipeline. */
export type ToolExecutionMode = 'ask' | 'auto_edit' | 'read_only' | 'readOnly' | 'auto';

export interface GoalEvidence {
  type: 'file' | 'image' | 'test' | 'url' | 'note';
  label: string;
  path?: string;
  url?: string;
  detail?: string;
}

export interface GoalRunRecord {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  outcome?: GoalReportOutcome | 'paused' | 'unreported';
  summary?: string;
  nextStep?: string;
  error?: string;
  evidence?: GoalEvidence[];
}

export interface GoalContractInput {
  objective: string;
  acceptanceCriteria?: string;
  workspace?: string;
  /** @deprecated Goal runs always use AutoEdit. Accepted for client compatibility. */
  permissionMode?: string;
  maxRuns?: number;
  maxConsecutiveFailures?: number;
  wakeIntervalMs?: number;
  completionMode?: 'review' | 'automatic';
}

export interface GoalRunReport {
  runId: string;
  outcome: GoalReportOutcome;
  summary: string;
  nextStep?: string;
  reason?: string;
  progress?: number;
  evidence?: GoalEvidence[];
}

export interface SessionGoal {
  goalId: string;
  version: number;
  objective: string;
  acceptanceCriteria: string;
  workspace: string;
  permissionMode: PermissionMode;
  maxRuns: number;
  maxConsecutiveFailures: number;
  wakeIntervalMs: number;
  completionMode: 'review' | 'automatic';
  status: GoalStatus;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  consecutiveFailures: number;
  nextRunAt?: string;
  currentRunId?: string;
  currentRunStartedAt?: string;
  lastReportedRunId?: string;
  progress?: number;
  lastSummary?: string;
  nextStep?: string;
  evidence?: GoalEvidence[];
  lastError?: string;
  recentRuns?: GoalRunRecord[];
  lastRunAt?: string;
  lastWorkspace?: string;
  lastPermissionMode?: PermissionMode;
  lastEffort?: 'HIGH' | 'NORMAL';
  lastUserMode?: string;
  completedAt?: string;
  deletedAt?: string;
}

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  tokenBreakdown: TokenBreakdown;
}

export interface TokenBreakdown {
  systemPrompt: number;
  systemTools: number;
  skills: number;
  messages: number;
  freeSpace: number;
  total: number;
  contextWindow?: number;
}

export const MessageRole = {
  User: 'user',
  Assistant: 'assistant',
  System: 'system',
  Tool: 'tool',
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export interface ToolCall {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
}

import type { ToolResult } from './tool.js';
export type { ToolResult };
/** @deprecated Use ToolResult from tool.ts instead. */
export type ToolResultData = ToolResult;

// Internal Message — unchanged, used everywhere
export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResultData[];
  thinking?: string;
  tokenCount: number;
  compressed: boolean;
  timestamp: string;
  withdrawn?: boolean;
  agentId?: string;
  agentName?: string;
}

// ── JSONL content blocks (Claude-style, used for persistence only) ──

export type TextBlock = { type: 'text'; text: string };
export type ThinkingBlock = { type: 'thinking'; thinking: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ── JSONL event types (Claude-style with uuid chain) ───────────────

interface EventBase {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
}

export type JsonlEvent =
  // Session lifecycle
  | (EventBase & { type: 'session_created'; agentId: string; parentSessionId: string | null })
  | (EventBase & { type: 'subsession_created'; subSessionId: string; agentId: string })
  | (EventBase & { type: 'session_archived' })

  // Messages — user
  | (EventBase & { type: 'user'; message: { role: 'user'; content: ContentBlock[] }; agentId?: string; agentName?: string })
  | (EventBase & { type: 'system'; message: { role: 'system'; content: ContentBlock[] }; agentId?: string; agentName?: string })

  // Messages — assistant (one content block per event, shared message.id)
  | (EventBase & { type: 'assistant'; message: { id: string; role: 'assistant'; model?: string; content: [ContentBlock] }; agentId?: string; agentName?: string })

  // Metadata events
  | (EventBase & { type: 'title_change'; newTitle: string })
  | (EventBase & { type: 'workspace_change'; path: string })
  | (EventBase & { type: 'compaction'; summary: string; prunedCount: number })
  | (EventBase & { type: 'compacted'; summary: string; prunedCount: number })
  | (EventBase & { type: 'error'; error: string; source?: string })
  | (EventBase & { type: 'plan_enter'; title?: string })
  | (EventBase & { type: 'plan_exit' })
  | (EventBase & { type: 'todo_write'; todos: Array<{ content: string; status: string }> })

  // Legacy compat — will be phased out but still readable
  | { type: 'message'; [key: string]: unknown }
  | { type: 'think'; content: string; [key: string]: unknown }
  | { type: 'tool_call'; toolCall: Record<string, unknown>; [key: string]: unknown }
  | { type: 'tool_result'; toolResult: Record<string, unknown>; [key: string]: unknown };

// ── Conversion helpers exported from serialization/jsonl-converters.ts ──
export { messageToJsonlEvents, jsonlEventsToMessages } from '../serialization/jsonl-converters.js';

// ── Execution context ───────────────────────────────────────────────

export interface ExecutionContext {
  sessionId: string;
  agentId: string;
  workspace: string;
  userConfirmed: boolean;
  /** Caller agent role, used for tool permission checks */
  callerRole?: import('./agent.js').AgentRole;
  /** AbortSignal from InterruptController — tools kill long ops when aborted */
  signal?: AbortSignal;
  /** Execution mode constraint selected by the session permission policy. */
  mode?: ToolExecutionMode;
}
