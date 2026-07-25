// CompactionManager — compaction trigger logic + message-rebuild
// Lives in context/ to keep all compaction concerns in one module.
//
// IMPORTANT: Compaction only affects the in-memory message array used for LLM
// context. The persisted JSONL on disk remains append-only and always keeps the
// FULL history.

import type { Message } from '../../../shared/types/session.js';
import { ContextCompressor } from './ContextCompressor.js';
import type { SummarizerFn } from './ContextCompressor.js';
import { COMPRESSION_TRIGGER_RATIO } from '../../../shared/constants.js';
import { SettingsManager } from '../../infra/storage/SettingsManager.js';
import { isCompactionSummaryMessage } from './CompactionConstants.js';

/** Lightweight API message shape — a subset of what AgentLoopHelpers.ApiMessage provides. */
export interface ApiMsgLite {
  role: string;
  content: string | null;
  id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  tool_success?: boolean;
  reasoning_content?: string;
}

export interface CompactionResult {
  wasCompacted: boolean;
  messages: ApiMsgLite[];
}

/**
 * Convert ApiMsgLite to the Message shape used by ContextCompressor.
 * Runtime-only ids keep otherwise anonymous messages distinct for summarizer
 * selection, while tool calls/results stay structured for token counting and
 * pair-aware compaction.
 */
function parseToolParams(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function toCompressorMessage(msg: ApiMsgLite, sessionId: string, id: string): Message {
  const isToolResult = msg.role === 'tool' && Boolean(msg.tool_call_id);
  return {
    id,
    sessionId,
    role: msg.role as Message['role'],
    content: isToolResult ? '' : (msg.content || ''),
    toolCalls: (msg.tool_calls || []).map(call => ({
      id: call.id,
      toolName: call.function.name,
      params: parseToolParams(call.function.arguments),
    })),
    toolResults: isToolResult ? [{
      toolCallId: msg.tool_call_id!,
      success: msg.tool_success !== false,
      content: msg.content || '',
      tokensUsed: 0,
      startedAt: 0,
      finishedAt: 0,
      durationMs: 0,
      wasTruncated: false,
    }] : [],
    tokenCount: 0,
    compressed: isCompactionSummaryMessage(msg),
    timestamp: '',
  };
}

/**
 * Convert a compressor Message back to ApiMsgLite.
 * Merge with the original runtime message so provider metadata such as
 * tool_calls and reasoning_content survives the adapter round trip.
 */
function fromCompressorMessage(
  msg: Message,
  originals: ReadonlyMap<string, ApiMsgLite>,
): ApiMsgLite {
  const original = originals.get(msg.id);
  const toolResult = msg.role === 'tool' ? msg.toolResults?.[0] : undefined;
  return {
    ...(original || {}),
    role: msg.role,
    content: toolResult?.content ?? msg.content,
    id: msg.id,
    tool_success: toolResult?.success ?? original?.tool_success,
  };
}

function selectTailPreservingContext(messages: Message[], limit: number): Message[] {
  if (messages.length <= limit) return messages;

  let start = Math.max(0, messages.length - Math.max(1, limit));

  // Preserve the newest user request even when a large tool group follows it.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      start = Math.min(start, i);
      break;
    }
  }

  // Include the complete assistant call group when selected results cross the boundary.
  let changed = true;
  while (changed) {
    changed = false;
    const resultIds = new Set<string>();
    for (let i = start; i < messages.length; i++) {
      for (const result of messages[i].toolResults || []) {
        if (result.toolCallId) resultIds.add(result.toolCallId);
      }
    }
    for (let i = start - 1; i >= 0; i--) {
      if ((messages[i].toolCalls || []).some(call => resultIds.has(call.id))) {
        start = i;
        changed = true;
      }
    }
  }

  return messages.slice(start);
}

/**
 * Run context compaction and rebuild the messages array in-place.
 * Compaction affects ONLY the in-memory array — JSONL persists full history.
 * Never calls rewriteHistory — that would permanently delete messages.
 *
 * @param messages      — current message array (modified in-place on success)
 * @param contextWindow — total context window in tokens
 * @param sessionId     — session identifier (used for context only)
 * @param tailCount     — number of recent messages to keep after compaction (default 15)
 */
export async function compactAndRebuildMessages(
  messages: ApiMsgLite[],
  contextWindow: number,
  sessionId: string,
  tailCount: number = 15,
  summarizer?: SummarizerFn,
): Promise<CompactionResult> {
  const compressor = ContextCompressor.getInstance();

  const originals = new Map<string, ApiMsgLite>();
  const seenIds = new Set<string>();
  const compressorInput = messages.map((message, index) => {
    const baseId = message.id?.trim() || `runtime-msg-${index}`;
    let id = baseId;
    if (seenIds.has(id)) id = `${baseId}-${index}`;
    seenIds.add(id);
    originals.set(id, message);
    return toCompressorMessage(message, sessionId, id);
  });
  const result = await compressor.compact(
    compressorInput,
    contextWindow,
    configuredCompressionTriggerRatio(),
    summarizer,
  );

  if (!result.wasCompacted) {
    return { wasCompacted: false, messages };
  }

  // Rebuild: system msg + prior compaction summaries + recent tail
  const sysMsg = messages[0];
  const rebuilt: ApiMsgLite[] = sysMsg ? [sysMsg] : [];

  for (const m of result.messages) {
    if (isCompactionSummaryMessage(m)) {
      rebuilt.push(fromCompressorMessage(m, originals));
    }
  }

  const tail = result.messages.filter(
    (m) => m.role !== 'system' && !isCompactionSummaryMessage(m),
  );
  for (const m of selectTailPreservingContext(tail, tailCount)) {
    rebuilt.push(fromCompressorMessage(m, originals));
  }

  // Replace in-place
  messages.length = 0;
  messages.push(...rebuilt);

  return { wasCompacted: true, messages };
}

function configuredCompressionTriggerRatio(): number {
  try {
    const pct = SettingsManager.getInstance().get<number>('ui.compactionThreshold', COMPRESSION_TRIGGER_RATIO * 100);
    if (!Number.isFinite(pct)) return COMPRESSION_TRIGGER_RATIO;
    return Math.min(0.9, Math.max(0.3, pct / 100));
  } catch {
    return COMPRESSION_TRIGGER_RATIO;
  }
}

/**
 * Check whether compaction should be triggered based on token estimate.
 */
export function shouldCompact(
  compactCheckCounter: number,
  estimatedTokens: number,
  lastCompactionTokenCount: number,
  contextWindow: number,
  checkInterval: number = 8,
): boolean {
  if (compactCheckCounter <= checkInterval) return false;
  if (estimatedTokens <= lastCompactionTokenCount * 1.5) return false;
  if (estimatedTokens <= contextWindow * 0.7) return false;
  return true;
}
