// AnoClaw — Shared types for conversation components
// Imports base types from parent types.ts where possible; keeps event-specific types local.

import type { MessageRole, TodoItem, TokenBreakdown } from '../../types.js';
import type { SessionNode } from '../../types.js';

// Re-exports for convenience
export type { MessageRole, TodoItem, TokenBreakdown, SessionNode };

/** Agent status */
export type AgentStatus = 'working' | 'idle' | 'paused' | 'error' | 'Active' | 'started' | 'tool_executing';

/** Input mode */
export type InputMode = 'ask' | 'auto-edit' | 'plan' | 'auto';

export function goalPermissionModeToUi(permissionMode: unknown, fallback: InputMode = 'auto'): InputMode {
  switch (permissionMode) {
    case 'Ask': return 'ask';
    case 'AutoEdit': return 'auto-edit';
    case 'Plan': return 'plan';
    case 'Auto': return 'auto';
    default: return fallback;
  }
}

/** Running mode — how long the agent stays alive */
export interface GoalState {
  goalId: string;
  version: number;
  objective: string;
  acceptanceCriteria: string;
  workspace: string;
  permissionMode: string;
  maxRuns: number;
  maxConsecutiveFailures: number;
  wakeIntervalMs: number;
  completionMode: 'review' | 'automatic';
  status: 'active' | 'paused' | 'waiting_user' | 'waiting_confirmation' | 'waiting_review' | 'blocked' | 'failed' | 'budget_exhausted' | 'completed' | 'deleted';
  statusReason?: string;
  createdAt?: string;
  updatedAt?: string;
  runCount: number;
  consecutiveFailures: number;
  nextRunAt?: string;
  currentRunId?: string;
  progress?: number;
  lastSummary?: string;
  nextStep?: string;
  evidence?: Array<{
    type: 'file' | 'image' | 'test' | 'url' | 'note';
    label: string;
    path?: string;
    url?: string;
    detail?: string;
  }>;
  lastError?: string;
  lastRunAt?: string;
  lastWorkspace?: string;
  lastPermissionMode?: string;
  lastEffort?: 'HIGH' | 'NORMAL';
  lastUserMode?: string;
}

export interface GoalContractDraft {
  objective: string;
  acceptanceCriteria?: string;
  workspace?: string;
  permissionMode?: string;
  maxRuns?: number;
  maxConsecutiveFailures?: number;
  wakeIntervalMs?: number;
  completionMode?: 'review' | 'automatic';
}

/** Todo status */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** Tool call status */
export type ToolStatus = 'running' | 'success' | 'error';

/** Attachment */
export interface Attachment {
  name: string;
  path: string;
  type: string;
  size: number;
  content?: string;
}

/** A single user/assistant text message event in the transcript.
 *  Named ConversationMessage to avoid shadowing the canonical Message from ../../types.ts. */
export interface ConversationMessage {
  type: 'message';
  role: MessageRole;
  content: string;
  timestamp?: string;
  attachments?: Attachment[];
  id?: string;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
}

/** Think event */
export interface ThinkEvent {
  type: 'think';
  content: string;
  durationMs?: number;
  timestamp?: string;
  id?: string;
}

/** Tool call event */
export interface ToolCall {
  type: 'tool_call';
  toolName: string;
  params: Record<string, unknown>;
  status: ToolStatus;
  durationMs?: number;
  resultSummary?: string;
  errorMessage?: string;
  result?: string;
  /** Friendly description extracted from params (e.g. bash description, file path, search pattern) */
  description?: string;
  /** Sequence number in the conversation timeline (1-based) */
  index?: number;
  id?: string;
  timestamp?: string;
}

/** Tool result event — now merged into ToolCall, kept for backward compat */
export interface ToolResultData {
  type: 'tool_result';
  toolName: string;
  content: string;
  tokenCount?: number;
  isError?: boolean;
  /** Human-readable summary of the result (e.g. "Read 42 lines", "Found 5 matches") */
  summary?: string;
  /** Execution duration in milliseconds */
  durationMs?: number;
  /** Original tool input, used by rich tool cards when available. */
  toolInput?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
}

/** Todo write event */
export interface TodoWriteEvent {
  type: 'todo_write';
  todos: TodoItem[];
  timestamp?: string;
  id?: string;
}

/** Plan mode indicator event */
export interface PlanEvent {
  type: 'plan_enter' | 'plan_exit';
  title?: string;
  description?: string;
  timestamp?: string;
  id?: string;
}

/** System message event */
export interface SystemMessageEvent {
  type: 'system';
  content: string;
  level?: 'info' | 'warning' | 'error';
  timestamp?: string;
  id?: string;
}

/** Plan step */
export interface PlanStep {
  step: number;
  description: string;
  status: TodoStatus;
}

/** Plan data */
export interface PlanData {
  title: string;
  steps: PlanStep[];
}
