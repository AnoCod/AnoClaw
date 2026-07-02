// src/shared/types/stream-events.ts
//
// Typed stream event definitions for agent loop → frontend streaming.
// Every event type in ChatHandlers.ts and ConversationWsHandlers.ts
// has a corresponding typed interface here.

import type { TokenBreakdown } from './session.js';

/** Every streaming event from agent loop to frontend */
export type StreamEvent =
  | StreamEventThink
  | StreamEventText
  | StreamEventToolCall
  | StreamEventToolResult
  | StreamEventPlanEnter
  | StreamEventPlanExit
  | StreamEventTodoWrite
  | StreamEventDelegationProgress
  | StreamEventDelegationStatus
  | StreamEventStatus
  | StreamEventSleep
  | StreamEventWake
  | StreamEventDone
  | StreamEventError
  | StreamEventCommandResult
  | StreamEventSubsessionCreated
  | StreamEventQualityScoreAck
  | StreamEventQualityScoreError;

export interface StreamEventThink {
  type: 'think';
  content: string;
  durationMs?: number;
}

export interface StreamEventText {
  type: 'text';
  content: string;
}

export interface StreamEventToolCall {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StreamEventToolResult {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  result: string;
  success: boolean;
}

export interface StreamEventPlanEnter {
  type: 'plan_enter';
  title: string;
}

export interface StreamEventPlanExit {
  type: 'plan_exit';
}

export interface StreamEventTodoWrite {
  type: 'todo_write';
  todos: Array<{ content: string; status: string; activeForm: string }>;
}

export interface StreamEventDelegationProgress {
  type: 'delegation_progress';
  subSessionId: string;
  subAgentId: string;
  content: string;
}

export interface StreamEventDelegationStatus {
  type: 'delegation_status';
  subSessionId: string;
  subAgentId: string;
  phase: string;
  taskSummary?: string;
}

export interface StreamEventStatus {
  type: 'status';
  content?: string;
}

export interface StreamEventSleep {
  type: 'sleep';
  content?: string;
}

export interface StreamEventWake {
  type: 'wake';
  content?: string;
}

export interface StreamEventDone {
  type: 'done';
  tokenUsage?: TokenBreakdown;
}

export interface StreamEventError {
  type: 'error';
  errorMessage: string;
  code?: string;
}

// ── Additional events found in ChatHandlers.ts not in initial plan ──

/** Server sends command execution result (e.g. compact completed) */
export interface StreamEventCommandResult {
  type: 'command_result';
  success: boolean;
  command: string;
  output: string;
}

/** Server notifies that a new sub-session was created under current session */
export interface StreamEventSubsessionCreated {
  type: 'subsession_created';
  sessionId: string;
  parentSessionId: string;
  agentId: string;
  title: string;
  level?: number;
}

/** Server confirms a quality score rating was saved */
export interface StreamEventQualityScoreAck {
  type: 'quality_score_ack';
}

/** Server rejected a quality score rating */
export interface StreamEventQualityScoreError {
  type: 'quality_score_error';
  error: string;
}

/** Connection state machine — mirrors Hermes GatewayClient states */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
