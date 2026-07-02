/**
 * AnoClaw -- WebSocket Protocol Types
 * Single bidirectional channel for all client-server communication.
 * Replaces HTTP REST + SSE with one persistent WebSocket connection per session.
 *
 * Client -> Server messages: send_message, stop, ping
 * Server -> Client messages: think, text, tool_call, tool_result, todo_write,
 *   plan_enter, plan_exit, subsession_created, error, done,
 *   sleep, wake, delegate_result, approval_request
 */

export { WsMessageType } from './events.js';
import type { WsMessageType } from './events.js';

/** Message sent from the browser client to the server. */
export interface WsClientMessage {
  type: 'send_message' | 'stop' | 'ping' | 'run_command' | 'set_running_mode' | 'editor_context';
  messageId?: string;     // for correlation
  content?: string;       // send_message
  mode?: string;          // send_message: ask / auto-edit / plan / auto
  runningMode?: string;   // set_running_mode: normal / infinite
  effort?: boolean;       // send_message
  attachments?: Array<{ name: string; path: string; type?: string; size?: number; content?: string }>; // send_message
  parentSessionId?: string; // send_message: parent session for sub-session creation
  command?: string;       // run_command: command name e.g. "init", "clear"
  args?: Record<string, string>; // run_command: command arguments
  // editor_context: real-time editor state for prompt injection
  openFiles?: string[];    // paths of open tabs (max 20)
  activeFile?: string;     // currently focused file path
  cursorLine?: number;     // 1-based
  cursorColumn?: number;   // 1-based
  selectedText?: string;   // currently selected text in editor
  selectedStartLine?: number;
  selectedEndLine?: number;
}

/** Message sent from the server to the browser client (streaming updates, events, responses). */
export interface WsServerMessage {
  type: WsMessageType;
  messageId?: string;
  content?: string;
  toolName?: string;
  toolId?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  status?: string;
  params?: Record<string, unknown>;
  success?: boolean;
  durationMs?: number;
  turnCount?: number;
  tokenUsage?: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
  /** agent_status / agent_registered: agent display name */
  name?: string;
  /** agent_registered: agent role */
  role?: string;
  /** agent_status: agent capabilities snapshot */
  capabilities?: { skills: string[]; tools: string[]; maxComplexity: number };
  errorMessage?: string;
  code?: string;
  todos?: Array<{ content: string; status: string }>;
  /** Structured data for tools like TodoWrite — carries todos, summary, etc. */
  structured?: Record<string, unknown>;
  /** task_notification: background task completion/failure */
  taskStatus?: 'completed' | 'failed';
  taskSummary?: string;
  taskResult?: string;
}
