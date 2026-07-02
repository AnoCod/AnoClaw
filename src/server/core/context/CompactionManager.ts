// CompactionManager — compaction trigger logic + message-rebuild
// Lives in context/ to keep all compaction concerns in one module.
//
// IMPORTANT: Compaction only affects the in-memory message array used for LLM
// context. The persisted JSONL on disk remains append-only and always keeps the
// FULL history.

import type { Message } from '../../../shared/types/session.js';
import { ContextCompressor } from './ContextCompressor.js';
import { COMPRESSION_TRIGGER_RATIO } from '../../../shared/constants.js';

/** Lightweight API message shape — a subset of what AgentLoopHelpers.ApiMessage provides. */
export interface ApiMsgLite {
  role: string;
  content: string | null;
  id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface CompactionResult {
  wasCompacted: boolean;
  messages: ApiMsgLite[];
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
  _sessionId: string,
  tailCount: number = 15,
): Promise<CompactionResult> {
  const compressor = ContextCompressor.getInstance();

  const result = await compressor.compact(
    messages as unknown as Message[],
    contextWindow,
    COMPRESSION_TRIGGER_RATIO,
  );

  if (!result.wasCompacted) {
    return { wasCompacted: false, messages };
  }

  // Rebuild: system msg + prior compaction summaries + recent tail
  const sysMsg = messages[0];
  const rebuilt: ApiMsgLite[] = [sysMsg];

  for (const m of result.messages) {
    if (m.id?.startsWith('compact-summary-')) {
      rebuilt.push(m as unknown as ApiMsgLite);
    }
  }

  const tail = result.messages.filter(
    (m) => m.role !== 'system' && !m.id?.startsWith('compact-summary-'),
  );
  for (const m of tail.slice(-tailCount)) {
    rebuilt.push(m as unknown as ApiMsgLite);
  }

  // Replace in-place
  messages.length = 0;
  messages.push(...rebuilt);

  return { wasCompacted: true, messages };
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
