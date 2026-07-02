// CompressionStrategy — 5-layer compression pipeline
// 

import { Message, ToolResultData } from '../../../shared/types/session.js';
import {
  COMPRESSION_TRIGGER_RATIO,
  MAX_TOOL_RESULT_CHARS,
  TOOL_RESULT_HEAD_TAIL,
} from '../../../shared/constants.js';
import { TokenCounter } from './TokenCounter.js';

export enum CompressionLevel {
  /** Always active — token buffer trimming */
  L1_TokenBuffer = 1,
  /** Single tool output > max chars → head+tail+summary */
  L2_ToolTruncation = 2,
  /** >50 messages or >70% window → prune old messages */
  L3_MessagePruning = 3,
  /** Token usage over threshold → LLM summary */
  L4_LLMSummary = 4,
  /** Duplicate tool results → deduplicate */
  L5_SemanticDedup = 5,
}

export class CompressionStrategy {
  // ─── Needs compression? ────────────────────────────────────

  /**
   * Determine which compression level is needed.
   * Returns the HIGHEST level that applies, or null if no compression needed.
   */
  needsCompression(
    messages: readonly Message[],
    tokenCount: number,
    contextWindow: number,
    threshold: number = COMPRESSION_TRIGGER_RATIO,
  ): CompressionLevel | null {
    // L5: Check for semantic duplicates
    if (this.hasDuplicateToolResults(messages)) {
      return CompressionLevel.L5_SemanticDedup;
    }

    // L4: Token usage over threshold
    if (TokenCounter.isOverThreshold(tokenCount, contextWindow, threshold)) {
      return CompressionLevel.L4_LLMSummary;
    }

    // L3: Too many messages or approaching threshold
    if (messages.length > 50 || tokenCount > contextWindow * 0.7) {
      return CompressionLevel.L3_MessagePruning;
    }

    // L2: Check for oversized tool results
    for (const msg of messages) {
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          if (this.shouldTruncateToolOutput(tr.content)) {
            return CompressionLevel.L2_ToolTruncation;
          }
        }
      }
    }

    // L1: Token buffer trimming — always active (handled by ContextCompressor)
    // This is the baseline; we return null to indicate no higher level is needed
    return null;
  }

  // ─── L2: Tool output truncation ────────────────────────────

  /** Check if a tool output should be truncated */
  shouldTruncateToolOutput(content: string): boolean {
    return content.length > MAX_TOOL_RESULT_CHARS;
  }

  /**
   * Truncate a long tool output.
   * Keeps head + tail + summary of what was omitted.
   */
  truncateToolOutput(content: string): string {
    if (content.length <= MAX_TOOL_RESULT_CHARS) return content;

    const head = content.slice(0, TOOL_RESULT_HEAD_TAIL);
    const tail = content.slice(-TOOL_RESULT_HEAD_TAIL);
    const omitted = content.length - TOOL_RESULT_HEAD_TAIL * 2;
    const estimatedTokens = Math.ceil(omitted / 4);

    return `${head}\n\n[... ${estimatedTokens} tokens omitted (${omitted} chars total) ...]\n\n${tail}`;
  }

  // ─── L5: Duplicate detection ────────────────────────────────

  /** Check if messages contain duplicate tool results */
  hasDuplicateToolResults(messages: readonly Message[]): boolean {
    const seen = new Set<string>();
    for (const msg of messages) {
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          if (!tr.success) continue; // don't deduplicate errors
          // Simple fingerprint: first 200 chars of result
          const fingerprint = tr.content?.slice(0, 200) || '';
          if (fingerprint && seen.has(fingerprint)) {
            return true;
          }
          if (fingerprint) seen.add(fingerprint);
        }
      }
    }
    return false;
  }

  /**
   * Deduplicate tool results — mark duplicates as compressed.
   * Returns a new array with duplicates replaced by reference markers.
   */
  deduplicateToolResults(messages: Message[]): Message[] {
    const seen = new Map<string, number>(); // fingerprint → first occurrence index
    const result: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = { ...messages[i] };

      if (msg.toolResults && msg.toolResults.length > 0) {
        msg.toolResults = msg.toolResults.map((tr: ToolResultData) => {
          if (!tr.success) return tr;
          const fingerprint = tr.content?.slice(0, 200) || '';
          if (!fingerprint) return tr;

          const firstIdx = seen.get(fingerprint);
          if (firstIdx !== undefined) {
            // Replace duplicate with reference
            return {
              ...tr,
              content: `[Duplicate of result in message #${firstIdx + 1} — deduplicated to save context]`,
              wasTruncated: true,
            };
          }
          seen.set(fingerprint, i);
          return tr;
        });
      }

      result.push(msg);
    }

    return result;
  }
}
