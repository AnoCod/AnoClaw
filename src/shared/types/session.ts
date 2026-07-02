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

export interface ToolResultData {
  toolCallId: string;
  success: boolean;
  content: string;
  structured?: unknown;
  errorMessage?: string;
  tokensUsed: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  wasTruncated: boolean;
}

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

  // Messages — assistant (one content block per event, shared message.id)
  | (EventBase & { type: 'assistant'; message: { id: string; role: 'assistant'; model?: string; content: [ContentBlock] } })

  // Metadata events
  | (EventBase & { type: 'title_change'; newTitle: string })
  | (EventBase & { type: 'workspace_change'; path: string })
  | (EventBase & { type: 'compaction'; summary: string; prunedCount: number })
  | (EventBase & { type: 'plan_enter' })
  | (EventBase & { type: 'plan_exit' })
  | (EventBase & { type: 'todo_write'; todos: Array<{ content: string; status: string }> })

  // Legacy compat — will be phased out but still readable
  | { type: 'message'; message: Record<string, unknown>; [key: string]: unknown }
  | ({ type: 'message' } & Record<string, unknown>)
  | { type: 'think'; content: string; [key: string]: unknown }
  | { type: 'tool_call'; toolCall: Record<string, unknown>; [key: string]: unknown }
  | { type: 'tool_result'; toolResult: Record<string, unknown>; [key: string]: unknown };

// ── Conversion helpers ──────────────────────────────────────────────

/** Convert an internal Message to JSONL events */
export function messageToJsonlEvents(
  msg: Message,
  prevUuid: string,
): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  let parentUuid = prevUuid;
  const uuid = (): string => {
    // We use a simple counter-based pseudo-UUID within a batch
    const id = `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return id;
  };

  if (msg.role === 'user') {
    events.push({
      type: 'user',
      uuid: uuid(),
      parentUuid,
      sessionId: msg.sessionId,
      timestamp: msg.timestamp,
      message: {
        role: 'user',
        content: [{ type: 'text', text: msg.content }],
      },
      agentId: msg.agentId,
      agentName: msg.agentName,
    });
    return events;
  }

  // Assistant message — split into one event per content block
  const msgId = msg.id || uuid();
  let p = parentUuid;

  // Thinking
  if (msg.thinking) {
    const evUuid = uuid();
    events.push({
      type: 'assistant',
      uuid: evUuid,
      parentUuid: p,
      sessionId: msg.sessionId,
      timestamp: msg.timestamp,
      message: {
        id: msgId,
        role: 'assistant',
        content: [{ type: 'thinking', thinking: msg.thinking }],
      },
    });
    p = evUuid;
  }

  // Tool calls
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      const evUuid = uuid();
      events.push({
        type: 'assistant',
        uuid: evUuid,
        parentUuid: p,
        sessionId: msg.sessionId,
        timestamp: msg.timestamp,
        message: {
          id: msgId,
          role: 'assistant',
          content: [{ type: 'tool_use', id: tc.id, name: tc.toolName, input: tc.params }],
        },
      });
      p = evUuid;
    }
  }

  // Tool results (as user events referencing tool_use.id)
  if (msg.toolResults) {
    for (const tr of msg.toolResults) {
      const evUuid = uuid();
      events.push({
        type: 'user',
        uuid: evUuid,
        parentUuid: p,
        sessionId: msg.sessionId,
        timestamp: msg.timestamp,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tr.toolCallId, content: tr.content }],
        },
      });
      p = evUuid;
    }
  }

  // Text (last)
  if (msg.content && msg.content !== '(tool calls)' && msg.content !== '(reasoning only)') {
    const evUuid = uuid();
    events.push({
      type: 'assistant',
      uuid: evUuid,
      parentUuid: p,
      sessionId: msg.sessionId,
      timestamp: msg.timestamp,
      message: {
        id: msgId,
        role: 'assistant',
        content: [{ type: 'text', text: msg.content }],
      },
    });
  }

  return events;
}

/** Merge Claude-format JSONL events back into internal Messages.
 *  @param flat  When true, return individual events as separate Messages in
 *               chronological order (no merging by message.id). Tool results
 *               are embedded in their tool_call messages. This preserves the
 *               interleaving of think/text/tool events that occurred during
 *               streaming — matching what the user actually saw. When false
 *               (default), all assistant events sharing the same message.id are
 *               merged into a single Message (needed for agent context loading). */
export function jsonlEventsToMessages(events: JsonlEvent[], flat?: boolean): Message[] {
  if (flat) return jsonlEventsToFlat(events);

  const messages: Message[] = [];
  // Accumulator for assistant events sharing the same message.id
  let acc: { id: string; sessionId: string; thinking: string; text: string; toolCalls: ToolCall[]; toolResults: ToolResultData[]; timestamp: string } | null = null;

  const flushAcc = () => {
    if (!acc) return;
    messages.push({
      id: acc.id,
      sessionId: acc.sessionId,
      role: MessageRole.Assistant,
      content: acc.text || (acc.toolCalls.length > 0 ? '(tool calls)' : ''),
      toolCalls: acc.toolCalls.length > 0 ? acc.toolCalls : undefined,
      toolResults: acc.toolResults.length > 0 ? acc.toolResults : undefined,
      thinking: acc.thinking || undefined,
      tokenCount: 0,
      compressed: false,
      timestamp: acc.timestamp,
    });
    acc = null;
  };

  for (const ev of events) {
    // Legacy formats
    if (ev.type === 'message') {
      // Legacy nested
      const legacy = (ev as Record<string, unknown>);
      const msg = (legacy.role ? legacy : legacy.message) as unknown as Message;
      if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
        messages.push(msg);
      }
      continue;
    }

    // New format — user events
    if (ev.type === 'user') {
      const userEv = ev as JsonlEvent & { type: 'user'; message: { role: 'user'; content: ContentBlock[] } };
      const textBlock = userEv.message.content.find((c): c is TextBlock => c.type === 'text');
      const resultBlock = userEv.message.content.find((c): c is ToolResultBlock => c.type === 'tool_result');

      // Tool result events belong to the current assistant accumulator — don't flush
      if (resultBlock) {
        if (acc) {
          acc.toolResults.push({
            toolCallId: resultBlock.tool_use_id,
            success: resultBlock.is_error !== true,
            content: typeof resultBlock.content === 'string' ? resultBlock.content : '',
            tokensUsed: 0,
            startedAt: Date.parse(ev.timestamp) || 0,
            finishedAt: Date.parse(ev.timestamp) || 0,
            durationMs: 0,
            wasTruncated: false,
          });
        }
        continue;
      }

      // Regular user text message — flush accumulated assistant first
      flushAcc();
      if (textBlock) {
        messages.push({
          id: ev.uuid,
          sessionId: ev.sessionId,
          role: MessageRole.User,
          content: textBlock.text,
          tokenCount: 0,
          compressed: false,
          timestamp: ev.timestamp,
          agentId: (ev as any).agentId,
          agentName: (ev as any).agentName,
        });
      }
      continue;
    }

    // New format — assistant events
    if (ev.type === 'assistant') {
      const asstEv = ev as JsonlEvent & { type: 'assistant'; message: { id: string; role: 'assistant'; model?: string; content: [ContentBlock] } };
      const block = asstEv.message.content[0];
      const msgId = asstEv.message.id;

      if (!acc || acc.id !== msgId) {
        flushAcc();
        acc = {
          id: msgId,
          sessionId: ev.sessionId,
          thinking: '',
          text: '',
          toolCalls: [],
          toolResults: [],
          timestamp: ev.timestamp,
        };
      }

      if (block.type === 'thinking') acc.thinking += block.thinking;
      else if (block.type === 'text') acc.text += block.text;
      else if (block.type === 'tool_use') acc.toolCalls.push({ id: block.id, toolName: block.name, params: block.input });
      continue;
    }
  }

  flushAcc();
  return messages;
}

/**
 * Flat mode: produces one Message per logical block (think / text / tool_use),
 * merging consecutive per-token assistant events that share the same message.id.
 *
 * Hermes/Cursor reference: streaming deltas are per-token for live display, but
 * persistence is per-block. We write per-token JSONL for durability (so session
 * switching mid-stream doesn't lose data), then merge back on read.
 *
 * Tool results are embedded directly in their tool_call Message.
 */
function jsonlEventsToFlat(events: JsonlEvent[]): Message[] {
  const messages: Message[] = [];
  const pendingResults: ToolResultData[] = [];

  const flushPendingResults = (toolCalls: ToolCall[]) => {
    if (!pendingResults.length) return;
    for (const tr of pendingResults) {
      const tc = toolCalls.find(c => c.id === tr.toolCallId);
      if (tc) {
        (tc as ToolCall & { result?: ToolResultData }).result = tr;
      }
    }
    pendingResults.length = 0;
  };

  // Accumulator for merging consecutive same-type, same-message-id assistant events.
  // Reset on type change, message-id change, or any non-assistant event.
  let acc:
    | { kind: 'think'; msgId: string; thinking: string; timestamp: string; id: string; sessionId: string }
    | { kind: 'text'; msgId: string; content: string; timestamp: string; id: string; sessionId: string }
    | null = null;

  const flushAcc = (lastTc?: Message) => {
    if (!acc) return;
    if (acc.kind === 'think' && acc.thinking) {
      messages.push({
        id: acc.id, sessionId: acc.sessionId,
        role: MessageRole.Assistant, content: '',
        thinking: acc.thinking, tokenCount: 0, compressed: false, timestamp: acc.timestamp,
      });
    } else if (acc.kind === 'text' && acc.content) {
      messages.push({
        id: acc.id, sessionId: acc.sessionId,
        role: MessageRole.Assistant, content: acc.content,
        tokenCount: 0, compressed: false, timestamp: acc.timestamp,
      });
    }
    acc = null;
  };

  for (const ev of events) {
    if (ev.type === 'message') {
      flushAcc();
      const legacy = (ev as Record<string, unknown>);
      const msg = (legacy.role ? legacy : legacy.message) as unknown as Message;
      if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
        messages.push(msg);
      }
      continue;
    }

    if (ev.type === 'user') {
      flushAcc();
      const userEv = ev as JsonlEvent & { type: 'user'; message: { role: 'user'; content: ContentBlock[] } };
      const textBlock = userEv.message.content.find((c): c is TextBlock => c.type === 'text');
      const resultBlock = userEv.message.content.find((c): c is ToolResultBlock => c.type === 'tool_result');

      if (resultBlock) {
        pendingResults.push({
          toolCallId: resultBlock.tool_use_id,
          success: resultBlock.is_error !== true,
          content: typeof resultBlock.content === 'string' ? resultBlock.content : '',
          tokensUsed: 0,
          startedAt: Date.parse(ev.timestamp) || 0,
          finishedAt: Date.parse(ev.timestamp) || 0,
          durationMs: 0,
          wasTruncated: false,
        });
        continue;
      }

      const lastTc = [...messages].reverse().find(m => m.role === 'assistant' && m.toolCalls?.length);
      if (lastTc?.toolCalls) flushPendingResults(lastTc.toolCalls);

      if (textBlock) {
        messages.push({
          id: ev.uuid, sessionId: ev.sessionId,
          role: MessageRole.User, content: textBlock.text,
          tokenCount: 0, compressed: false, timestamp: ev.timestamp,
          agentId: (ev as any).agentId, agentName: (ev as any).agentName,
        });
      }
      continue;
    }

    if (ev.type === 'assistant') {
      const asstEv = ev as JsonlEvent & { type: 'assistant'; message: { id: string; role: 'assistant'; content: [ContentBlock] } };
      const block = asstEv.message.content[0];
      const msgId = asstEv.message.id;

      if (block.type === 'thinking') {
        const thinkText = typeof block.thinking === 'string' ? block.thinking : '';
        if (acc && acc.kind === 'think' && acc.msgId === msgId) {
          // Merge into same think block
          acc.thinking += thinkText;
        } else {
          flushAcc();
          acc = { kind: 'think', msgId, thinking: thinkText, timestamp: ev.timestamp, id: `think-${ev.uuid}`, sessionId: ev.sessionId };
        }
      } else if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text) {
          if (acc && acc.kind === 'text' && acc.msgId === msgId) {
            // Merge into same text block — per-token streaming fragments
            acc.content += text;
          } else {
            flushAcc();
            acc = { kind: 'text', msgId, content: text, timestamp: ev.timestamp, id: msgId || ev.uuid, sessionId: ev.sessionId };
          }
        }
      } else if (block.type === 'tool_use') {
        flushAcc(); // tool_use always starts a new card — no merging
        const tc: ToolCall = { id: block.id, toolName: block.name, params: block.input };
        const pendingForThis = pendingResults.filter(r => r.toolCallId === tc.id);
        if (pendingForThis.length) {
          (tc as ToolCall & { result?: ToolResultData }).result = pendingForThis[0];
          pendingResults.splice(0, pendingForThis.length);
        }
        messages.push({
          id: msgId || ev.uuid, sessionId: ev.sessionId,
          role: MessageRole.Assistant, content: '',
          toolCalls: [tc], tokenCount: 0, compressed: false, timestamp: ev.timestamp,
        });
      }
      continue;
    }

    // ── TodoWrite persistence — survives page refresh ──
    if (ev.type === 'todo_write') {
      flushAcc();
      const todoEv = ev as JsonlEvent & { type: 'todo_write'; todos: Array<{ content: string; status: string; activeForm?: string }> };
      if (Array.isArray(todoEv.todos)) {
        const todoMsg: any = {
          id: ev.uuid,
          sessionId: ev.sessionId,
          role: MessageRole.Assistant,
          content: '',
          tokenCount: 0,
          compressed: false,
          timestamp: ev.timestamp,
        };
        todoMsg.type = 'todo_write';
        todoMsg.todos = todoEv.todos;
        messages.push(todoMsg);
      }
      continue;
    }

    // Unknown event types (session_created, title_change, etc.) — ignore
  }

  flushAcc();

  const lastTc = [...messages].reverse().find(m => m.role === 'assistant' && m.toolCalls?.length);
  if (lastTc?.toolCalls) flushPendingResults(lastTc.toolCalls);

  return messages;
}

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
}
