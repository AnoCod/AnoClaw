/**
 * AnoClaw — JSONL Conversion Helpers
 *
 * Convert between internal Message objects and Claude-style JSONL events
 * for persistence. Extracted from session.ts to keep types and converters
 * separate concerns.
 */

import type {
  Message, MessageRole, JsonlEvent, ContentBlock,
  TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock,
  ToolCall, ToolResultData,
} from '../types/session.js';

const MessageRoles = {
  User: 'user' as MessageRole,
  Assistant: 'assistant' as MessageRole,
  System: 'system' as MessageRole,
  Tool: 'tool' as MessageRole,
};

/** Convert an internal Message to JSONL events */
export function messageToJsonlEvents(
  msg: Message,
  prevUuid: string,
): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  let parentUuid = prevUuid;
  const uuid = (): string => {
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

  if (msg.role === 'system') {
    events.push({
      type: 'system',
      uuid: uuid(),
      parentUuid,
      sessionId: msg.sessionId,
      timestamp: msg.timestamp,
      message: {
        role: 'system',
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
        agentId: msg.agentId,
        agentName: msg.agentName,
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
        agentId: msg.agentId,
        agentName: msg.agentName,
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
      agentId: msg.agentId,
      agentName: msg.agentName,
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
  let acc: { id: string; sessionId: string; thinking: string; text: string; toolCalls: ToolCall[]; toolResults: ToolResultData[]; timestamp: string; agentId?: string; agentName?: string } | null = null;

  const flushAcc = () => {
    if (!acc) return;
    messages.push({
      id: acc.id,
      sessionId: acc.sessionId,
      role: MessageRoles.Assistant,
      content: acc.text || (acc.toolCalls.length > 0 ? '(tool calls)' : ''),
      toolCalls: acc.toolCalls.length > 0 ? acc.toolCalls : undefined,
      toolResults: acc.toolResults.length > 0 ? acc.toolResults : undefined,
      thinking: acc.thinking || undefined,
      tokenCount: 0,
      compressed: false,
      timestamp: acc.timestamp,
      agentId: acc.agentId,
      agentName: acc.agentName,
    });
    acc = null;
  };

  for (const ev of events) {
    // Legacy formats
    if (ev.type === 'message') {
      const legacy = (ev as Record<string, unknown>);
      const msg = (legacy.role ? legacy : legacy.message) as unknown as Message;
      if (msg && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')) {
        messages.push(msg);
      }
      continue;
    }

    // New format — user events
    if (ev.type === 'user') {
      const userEv = ev as Extract<JsonlEvent, { type: 'user' }>;
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
          role: MessageRoles.User,
          content: textBlock.text,
          tokenCount: 0,
          compressed: false,
          timestamp: ev.timestamp,
          agentId: userEv.agentId,
          agentName: userEv.agentName,
        });
      }
      continue;
    }

    if (ev.type === 'system') {
      flushAcc();
      const sysEv = ev as Extract<JsonlEvent, { type: 'system' }>;
      const textBlock = sysEv.message.content.find((c): c is TextBlock => c.type === 'text');
      if (textBlock) {
        messages.push({
          id: ev.uuid,
          sessionId: ev.sessionId,
          role: MessageRoles.System,
          content: textBlock.text,
          tokenCount: 0,
          compressed: false,
          timestamp: ev.timestamp,
          agentId: sysEv.agentId,
          agentName: sysEv.agentName,
        });
      }
      continue;
    }

    // New format — assistant events
    if (ev.type === 'assistant') {
      const asstEv = ev as Extract<JsonlEvent, { type: 'assistant' }>;
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
          agentId: asstEv.agentId,
          agentName: asstEv.agentName,
        };
      } else {
        acc.agentId ||= asstEv.agentId;
        acc.agentName ||= asstEv.agentName;
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
  type RestoredToolCall = ToolCall & { result?: ToolResultData };
  const toolCallsById = new Map<string, RestoredToolCall>();
  const emptyIdToolCalls: RestoredToolCall[] = [];

  const attachToolResult = (tr: ToolResultData): boolean => {
    const exact = toolCallsById.get(tr.toolCallId);
    if (exact) {
      exact.result = tr;
      return true;
    }

    // Legacy tolerance: older streams could persist a tool_call before a stable
    // id was available, then persist the result with the later stable id.
    const emptyIdCall = emptyIdToolCalls.find(c => !c.result);
    if (emptyIdCall) {
      emptyIdCall.result = tr;
      return true;
    }

    return false;
  };

  const flushPendingResults = () => {
    if (!pendingResults.length) return;
    for (let i = pendingResults.length - 1; i >= 0; i--) {
      if (attachToolResult(pendingResults[i])) {
        pendingResults.splice(i, 1);
      }
    }
  };

  let acc:
    | { kind: 'think'; msgId: string; thinking: string; timestamp: string; id: string; sessionId: string; agentId?: string; agentName?: string }
    | { kind: 'text'; msgId: string; content: string; timestamp: string; id: string; sessionId: string; agentId?: string; agentName?: string }
    | null = null;

  const flushAcc = () => {
    if (!acc) return;
    if (acc.kind === 'think' && acc.thinking) {
      messages.push({
        id: acc.id, sessionId: acc.sessionId,
        role: MessageRoles.Assistant, content: '',
        thinking: acc.thinking, tokenCount: 0, compressed: false, timestamp: acc.timestamp,
        agentId: acc.agentId, agentName: acc.agentName,
      });
    } else if (acc.kind === 'text' && acc.content) {
      messages.push({
        id: acc.id, sessionId: acc.sessionId,
        role: MessageRoles.Assistant, content: acc.content,
        tokenCount: 0, compressed: false, timestamp: acc.timestamp,
        agentId: acc.agentId, agentName: acc.agentName,
      });
    }
    acc = null;
  };

  for (const ev of events) {
    if (ev.type === 'message') {
      flushAcc();
      const legacy = (ev as Record<string, unknown>);
      const msg = (legacy.role ? legacy : legacy.message) as unknown as Message;
      if (msg && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')) {
        messages.push(msg);
      }
      continue;
    }

    if (ev.type === 'user') {
      flushAcc();
      const userEv = ev as Extract<JsonlEvent, { type: 'user' }>;
      const textBlock = userEv.message.content.find((c): c is TextBlock => c.type === 'text');
      const resultBlock = userEv.message.content.find((c): c is ToolResultBlock => c.type === 'tool_result');

      if (resultBlock) {
        const result: ToolResultData = {
          toolCallId: resultBlock.tool_use_id,
          success: resultBlock.is_error !== true,
          content: typeof resultBlock.content === 'string' ? resultBlock.content : '',
          tokensUsed: 0,
          startedAt: Date.parse(ev.timestamp) || 0,
          finishedAt: Date.parse(ev.timestamp) || 0,
          durationMs: 0,
          wasTruncated: false,
        };
        if (!attachToolResult(result)) pendingResults.push(result);
        continue;
      }

      flushPendingResults();

      if (textBlock) {
        messages.push({
          id: ev.uuid, sessionId: ev.sessionId,
          role: MessageRoles.User, content: textBlock.text,
          tokenCount: 0, compressed: false, timestamp: ev.timestamp,
          agentId: userEv.agentId, agentName: userEv.agentName,
        });
      }
      continue;
    }

    if (ev.type === 'system') {
      flushAcc();
      const sysEv = ev as Extract<JsonlEvent, { type: 'system' }>;
      const textBlock = sysEv.message.content.find((c): c is TextBlock => c.type === 'text');
      if (textBlock) {
        messages.push({
          id: ev.uuid, sessionId: ev.sessionId,
          role: MessageRoles.System, content: textBlock.text,
          tokenCount: 0, compressed: false, timestamp: ev.timestamp,
          agentId: sysEv.agentId, agentName: sysEv.agentName,
        });
      }
      continue;
    }

    if (ev.type === 'assistant') {
      const asstEv = ev as Extract<JsonlEvent, { type: 'assistant' }>;
      const block = asstEv.message.content[0];
      const msgId = asstEv.message.id;

      if (block.type === 'thinking') {
        const thinkText = typeof block.thinking === 'string' ? block.thinking : '';
        if (acc && acc.kind === 'think' && acc.msgId === msgId) {
          acc.thinking += thinkText;
          acc.agentId ||= asstEv.agentId;
          acc.agentName ||= asstEv.agentName;
        } else {
          flushAcc();
          acc = {
            kind: 'think',
            msgId,
            thinking: thinkText,
            timestamp: ev.timestamp,
            id: `think-${ev.uuid}`,
            sessionId: ev.sessionId,
            agentId: asstEv.agentId,
            agentName: asstEv.agentName,
          };
        }
      } else if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text) {
          if (acc && acc.kind === 'text' && acc.msgId === msgId) {
            acc.content += text;
            acc.agentId ||= asstEv.agentId;
            acc.agentName ||= asstEv.agentName;
          } else {
            flushAcc();
            acc = {
              kind: 'text',
              msgId,
              content: text,
              timestamp: ev.timestamp,
              id: `text-${ev.uuid}`,
              sessionId: ev.sessionId,
              agentId: asstEv.agentId,
              agentName: asstEv.agentName,
            };
          }
        }
      } else if (block.type === 'tool_use') {
        flushAcc();
        const tc: RestoredToolCall = { id: block.id, toolName: block.name, params: block.input };
        if (tc.id) toolCallsById.set(tc.id, tc);
        else emptyIdToolCalls.push(tc);
        flushPendingResults();
        messages.push({
          id: `tool-${block.id || ev.uuid}`, sessionId: ev.sessionId,
          role: MessageRoles.Assistant, content: '',
          toolCalls: [tc], tokenCount: 0, compressed: false, timestamp: ev.timestamp,
          agentId: asstEv.agentId, agentName: asstEv.agentName,
        });
      }
      continue;
    }

    // TodoWrite persistence — survives page refresh
    if (ev.type === 'error') {
      flushAcc();
      const errEv = ev as Extract<JsonlEvent, { type: 'error' }>;
      const errMsg: any = {
        id: ev.uuid,
        sessionId: ev.sessionId,
        role: MessageRoles.Assistant,
        content: String(errEv.error || 'Unknown error'),
        tokenCount: 0,
        compressed: false,
        timestamp: ev.timestamp,
      };
      errMsg.type = 'error';
      messages.push(errMsg);
      continue;
    }

    if (ev.type === 'plan_enter') {
      flushAcc();
      const planEv = ev as Extract<JsonlEvent, { type: 'plan_enter' }>;
      const planMsg: any = {
        id: ev.uuid,
        sessionId: ev.sessionId,
        role: MessageRoles.Assistant,
        content: '',
        tokenCount: 0,
        compressed: false,
        timestamp: ev.timestamp,
      };
      planMsg.type = 'plan_enter';
      planMsg.planTitle = planEv.title || 'Plan Mode';
      messages.push(planMsg);
      continue;
    }

    if (ev.type === 'plan_exit') {
      flushAcc();
      const planMsg: any = {
        id: ev.uuid,
        sessionId: ev.sessionId,
        role: MessageRoles.Assistant,
        content: 'Plan mode exited',
        tokenCount: 0,
        compressed: false,
        timestamp: ev.timestamp,
      };
      planMsg.type = 'plan_exit';
      messages.push(planMsg);
      continue;
    }

    if (ev.type === 'todo_write') {
      flushAcc();
      const todoEv = ev as Extract<JsonlEvent, { type: 'todo_write' }>;
      if (Array.isArray(todoEv.todos)) {
        const todoMsg: any = {
          id: ev.uuid,
          sessionId: ev.sessionId,
          role: MessageRoles.Assistant,
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
    if (ev.type === 'compaction' || ev.type === 'compacted') {
      flushAcc();
      const compactEv = ev as Extract<JsonlEvent, { type: 'compaction' | 'compacted' }>;
      const statusMsg: any = {
        id: ev.uuid,
        sessionId: ev.sessionId,
        role: MessageRoles.Assistant,
        content: compactEv.summary ? `Context compacted: ${compactEv.summary}` : 'Context compacted',
        tokenCount: 0,
        compressed: false,
        timestamp: ev.timestamp,
      };
      statusMsg.type = 'status';
      messages.push(statusMsg);
      continue;
    }
  }

  flushAcc();

  flushPendingResults();

  return messages;
}
