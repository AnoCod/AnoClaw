// Session, message, and transcript types
// v2.1 — Claude-style content blocks + uuid chain (JSONL layer only)
export var SessionType;
(function (SessionType) {
    SessionType["Main"] = "Main";
    SessionType["Sub"] = "Sub";
})(SessionType || (SessionType = {}));
export var SessionStatus;
(function (SessionStatus) {
    SessionStatus["Active"] = "Active";
    SessionStatus["Idle"] = "Idle";
    SessionStatus["Archived"] = "Archived";
})(SessionStatus || (SessionStatus = {}));
export const MessageRole = {
    User: 'user',
    Assistant: 'assistant',
    System: 'system',
    Tool: 'tool',
};
// ── Conversion helpers ──────────────────────────────────────────────
/** Convert an internal Message to JSONL events */
export function messageToJsonlEvents(msg, prevUuid) {
    const events = [];
    let parentUuid = prevUuid;
    const uuid = () => {
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
export function jsonlEventsToMessages(events, flat) {
    if (flat)
        return jsonlEventsToFlat(events);
    const messages = [];
    // Accumulator for assistant events sharing the same message.id
    let acc = null;
    const flushAcc = () => {
        if (!acc)
            return;
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
            const legacy = ev;
            const msg = (legacy.role ? legacy : legacy.message);
            if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
                messages.push(msg);
            }
            continue;
        }
        // New format — user events
        if (ev.type === 'user') {
            const userEv = ev;
            const textBlock = userEv.message.content.find((c) => c.type === 'text');
            const resultBlock = userEv.message.content.find((c) => c.type === 'tool_result');
            // Tool result events belong to the current assistant accumulator — don't flush
            if (resultBlock) {
                if (acc) {
                    acc.toolResults.push({
                        toolCallId: resultBlock.tool_use_id,
                        success: resultBlock.is_error !== true,
                        content: typeof resultBlock.content === 'string' ? resultBlock.content : '',
                        tokensUsed: 0,
                        startedAt: ev.timestamp,
                        finishedAt: ev.timestamp,
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
                    agentId: ev.agentId,
                    agentName: ev.agentName,
                });
            }
            continue;
        }
        // New format — assistant events
        if (ev.type === 'assistant') {
            const asstEv = ev;
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
            if (block.type === 'thinking')
                acc.thinking += block.thinking;
            else if (block.type === 'text')
                acc.text += block.text;
            else if (block.type === 'tool_use')
                acc.toolCalls.push({ id: block.id, toolName: block.name, params: block.input });
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
function jsonlEventsToFlat(events) {
    const messages = [];
    const pendingResults = [];
    const flushPendingResults = (toolCalls) => {
        if (!pendingResults.length)
            return;
        for (const tr of pendingResults) {
            const tc = toolCalls.find(c => c.id === tr.toolCallId);
            if (tc) {
                tc.result = tr;
            }
        }
        pendingResults.length = 0;
    };
    // Accumulator for merging consecutive same-type, same-message-id assistant events.
    // Reset on type change, message-id change, or any non-assistant event.
    let acc = null;
    const flushAcc = (lastTc) => {
        if (!acc)
            return;
        if (acc.kind === 'think' && acc.thinking) {
            messages.push({
                id: acc.id, sessionId: acc.sessionId,
                role: MessageRole.Assistant, content: '',
                thinking: acc.thinking, tokenCount: 0, compressed: false, timestamp: acc.timestamp,
            });
        }
        else if (acc.kind === 'text' && acc.content) {
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
            const legacy = ev;
            const msg = (legacy.role ? legacy : legacy.message);
            if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
                messages.push(msg);
            }
            continue;
        }
        if (ev.type === 'user') {
            flushAcc();
            const userEv = ev;
            const textBlock = userEv.message.content.find((c) => c.type === 'text');
            const resultBlock = userEv.message.content.find((c) => c.type === 'tool_result');
            if (resultBlock) {
                pendingResults.push({
                    toolCallId: resultBlock.tool_use_id,
                    success: resultBlock.is_error !== true,
                    content: typeof resultBlock.content === 'string' ? resultBlock.content : '',
                    tokensUsed: 0,
                    startedAt: ev.timestamp,
                    finishedAt: ev.timestamp,
                    durationMs: 0,
                    wasTruncated: false,
                });
                continue;
            }
            const lastTc = [...messages].reverse().find(m => m.role === 'assistant' && m.toolCalls?.length);
            if (lastTc?.toolCalls)
                flushPendingResults(lastTc.toolCalls);
            if (textBlock) {
                messages.push({
                    id: ev.uuid, sessionId: ev.sessionId,
                    role: MessageRole.User, content: textBlock.text,
                    tokenCount: 0, compressed: false, timestamp: ev.timestamp,
                    agentId: ev.agentId, agentName: ev.agentName,
                });
            }
            continue;
        }
        if (ev.type === 'assistant') {
            const asstEv = ev;
            const block = asstEv.message.content[0];
            const msgId = asstEv.message.id;
            if (block.type === 'thinking') {
                const thinkText = typeof block.thinking === 'string' ? block.thinking : '';
                if (acc && acc.kind === 'think' && acc.msgId === msgId) {
                    // Merge into same think block
                    acc.thinking += thinkText;
                }
                else {
                    flushAcc();
                    acc = { kind: 'think', msgId, thinking: thinkText, timestamp: ev.timestamp, id: `think-${ev.uuid}`, sessionId: ev.sessionId };
                }
            }
            else if (block.type === 'text') {
                const text = typeof block.text === 'string' ? block.text : '';
                if (text) {
                    if (acc && acc.kind === 'text' && acc.msgId === msgId) {
                        // Merge into same text block — per-token streaming fragments
                        acc.content += text;
                    }
                    else {
                        flushAcc();
                        acc = { kind: 'text', msgId, content: text, timestamp: ev.timestamp, id: msgId || ev.uuid, sessionId: ev.sessionId };
                    }
                }
            }
            else if (block.type === 'tool_use') {
                flushAcc(); // tool_use always starts a new card — no merging
                const tc = { id: block.id, toolName: block.name, params: block.input };
                const pendingForThis = pendingResults.filter(r => r.toolCallId === tc.id);
                if (pendingForThis.length) {
                    tc.result = pendingForThis[0];
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
            const todoEv = ev;
            if (Array.isArray(todoEv.todos)) {
                const todoMsg = {
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
    if (lastTc?.toolCalls)
        flushPendingResults(lastTc.toolCalls);
    return messages;
}
//# sourceMappingURL=session.js.map