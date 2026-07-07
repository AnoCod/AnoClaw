// ContextCompressor — automatic context window compression
// Replicates Claude Code patterns from anochat/context_compressor.js
//
// Key features:
//   - SUMMARY_PREFIX: prevents "zombie task" bug — crucial invariant
//   - Token-budget tail protection: not fixed message count, budget-based
//   - Tool output pruning before summarization
//   - Structured summary template
//   - Iterative summary: preserve info across compactions
//   - Scaled summary budget: 20% of compressed content, max 12000 tokens

import { EventEmitter } from 'events';
import { Message, ToolResultData, ToolCall, MessageRole } from '../../../shared/types/session.js';
import {
  COMPRESSION_TRIGGER_RATIO,
  DEFAULT_CONTEXT_WINDOW,
  SUMMARY_MAX_TOKENS,
} from '../../../shared/constants.js';
import { TokenCounter } from './TokenCounter.js';
import {
  CompressionLevel,
  CompressionStrategy,
} from './CompressionStrategy.js';
import {
  SUMMARY_PREFIX,
  MIN_SUMMARY_TOKENS,
  SUMMARY_RATIO,
  VALID_SUMMARY_MIN_CHARS,
  PRUNED_TOOL_PLACEHOLDER,
  MAX_TOOL_RESULT_FOR_SUMMARIZER,
  FALLBACK_SUMMARY_MAX_CHARS,
  FALLBACK_TURN_MAX_CHARS,
  IMAGE_CHAR_EQUIVALENT,
  STRUCTURED_SUMMARY_PROMPT,
  COMPACTION_TIMEOUT_MS,
} from './CompactionConstants.js';
import { createLogger } from '../logger.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import { compressToolOutput } from './ContentAwareCompressor.js';

// ══════════════════════════════════════════════════════════════
// Module-level helper functions — eliminate repeated message formatting patterns
// ══════════════════════════════════════════════════════════════

/**
 * Calculate the number of tail messages to keep based on token budget.
 * Accumulates tokens from the end backwards, not exceeding the budget.
 */
function countTailByBudget(
  messages: Message[],
  budget: number,
  minKeep: number,
): number {
  let tailCount = 0;
  let tailTokens = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    const msgTokens = TokenCounter.estimate(messages[i].content);
    if (tailTokens + msgTokens > budget && tailCount >= minKeep) break;
    tailTokens += msgTokens;
    tailCount++;
  }
  tailCount = Math.max(tailCount, Math.min(minKeep, messages.length - 1));
  tailCount = Math.min(tailCount, messages.length - 1);
  return tailCount;
}

/**
 * Fix orphaned tool_call / tool_result pairs at the tail boundary.
 * If a tool_result is in the tail but its corresponding tool_call is in the compaction zone,
 * expand the tail to include that tool_result.
 */
function fixOrphanedPairs(
  messages: Message[],
  tailStart: number,
  tailCount: number,
): number {
  let adjusted = tailCount;
  for (let i = tailStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.toolResults) {
      for (const tr of m.toolResults) {
        const callExistsBefore = messages.some(
          (x, idx) =>
            idx < tailStart &&
            x.role === 'assistant' &&
            x.toolCalls?.some((tc: ToolCall) => tc.id === tr.toolCallId),
        );
        if (callExistsBefore) adjusted++;
      }
    }
  }
  return Math.min(adjusted, messages.length - 1);
}

/**
 * Map message role to a short prefix used by the summarizer.
 */
function rolePrefix(role: string): string {
  switch (role) {
    case 'user': return 'USER';
    case 'assistant': return 'ASSISTANT';
    case 'tool': return 'TOOL';
    default: return 'SYSTEM';
  }
}

/**
 * Truncate a single tool result to placeholder format.
 * @param content  original content
 * @param maxLen   truncation threshold — content exceeding this gets truncated
 * @param preview  number of prefix characters preserved as a preview
 * @returns truncated content string, or the original if not exceeding maxLen
 */
function truncateToolContent(content: string, maxLen: number, preview: number): string {
  if (!content || content.length <= maxLen) return content;
  return `[Tool result: ${content.slice(0, preview)}... (${content.length} chars total)]`;
}

// Path mention regex for extracting file references
const PATH_MENTION_RE = /(?:[~/]|[A-Z]:\\)[^\s`'")\]}<>]+/g;

export interface CompactionResult {
  /** The compacted messages array */
  messages: Message[];
  /** The summary text (if compression occurred) */
  summary: string | null;
  /** Whether compaction actually happened */
  wasCompacted: boolean;
  /** Number of messages pruned */
  prunedCount: number;
}

/**
 * Type for an external summarizer function.
 * Receives messages to summarize and the token budget, returns summary text.
 */
export type SummarizerFn = (
  messages: Message[],
  budget: number,
) => Promise<string>;

// ══════════════════════════════════════════════════════════════

export class ContextCompressor extends EventEmitter {
  private static _instance: ContextCompressor;

  static getInstance(): ContextCompressor {
    if (!this._instance) {
      this._instance = new ContextCompressor();
    }
    return this._instance;
  }

  static resetInstance(): void {
    this._instance = undefined as any;
  }

  private _strategy = new CompressionStrategy();
  private _summarizer: SummarizerFn | null = null;

  private constructor() {
    super();
  }

  /**
   * Set an external summarizer (LLM-based).
   * Falls back to deterministic summary when not set.
   *
   * @param fn — async function that receives messages to summarize and a token budget, returns summary text
   */
  setSummarizer(fn: SummarizerFn): void {
    this._summarizer = fn;
  }

  // ─── Main entry point ──────────────────────────────────────

  /**
   * Compact context by applying the 5-layer strategy.
   * Returns the compacted messages array and summary info.
   */
  async compact(
    messages: readonly Message[],
    contextWindow: number = DEFAULT_CONTEXT_WINDOW,
    threshold: number = COMPRESSION_TRIGGER_RATIO,
    summarizer?: SummarizerFn,
  ): Promise<CompactionResult> {
    const msgs = [...messages]; // work on a mutable copy
    let summary: string | null = null;
    let wasCompacted = false;
    let prunedCount = 0;

    // L1: Token buffer — use strategy to determine needed level
    const estimatedTokens = TokenCounter.estimateMessages(msgs);
    const level = this._strategy.needsCompression(msgs, estimatedTokens, contextWindow, threshold);

    if (level === null) {
      return { messages: msgs, summary: null, wasCompacted: false, prunedCount: 0 };
    }

    // L2.5: Content-aware tool output compression — runs BEFORE L2 truncation
    // so intelligently compressed outputs don't need to be blindly truncated
    const contentAware = this.compressToolOutputsWithStrategy(msgs);

    // L2: Tool output truncation — only truncates outputs still oversized after L2.5
    const truncated = (level <= CompressionLevel.L2_ToolTruncation)
      ? this.truncateToolOutputs(contentAware)
      : contentAware;

    // L3: Message pruning — run when indicated or higher
    const pruned = (level <= CompressionLevel.L3_MessagePruning && truncated.length > 10)
      ? this.pruneMessages(truncated, contextWindow)
      : truncated;
    prunedCount = truncated.length - pruned.length;

    // L4: LLM summary compression — only when strategy says so
    if (level <= CompressionLevel.L4_LLMSummary) {
      const compacted = await this.generateSummary(pruned, contextWindow, threshold, summarizer);
      if (compacted.wasCompacted) {
        summary = compacted.summary;
        wasCompacted = true;
        return { messages: compacted.messages, summary, wasCompacted, prunedCount };
      }
    }

    // L5: Semantic dedup as fallback clean-up
    if (level <= CompressionLevel.L5_SemanticDedup) {
      const deduped = this._strategy.deduplicateToolResults(pruned);
      return { messages: deduped, summary: null, wasCompacted: false, prunedCount };
    }

    return { messages: pruned, summary: null, wasCompacted, prunedCount };
  }

  // ─── L2: Tool output truncation ────────────────────────────

  /**
   * L2.5: Run content-aware compression on all tool results.
   * This runs BEFORE the blind truncation step — if content-aware compression
   * shrinks a 30000-char log to 3000 chars, L2 truncation won't need to touch it.
   *
   * Runs synchronously (<5ms for typical outputs), no external calls.
   */
  compressToolOutputsWithStrategy(messages: Message[]): Message[] {
    return messages.map(msg => {
      if (!msg.toolResults || msg.toolResults.length === 0) return msg;

      let changed = false;
      const newResults = msg.toolResults.map((tr: ToolResultData) => {
        const content = tr.content || '';
        if (!content || content.length < 200) return tr;

        const { output, note } = compressToolOutput(content);
        if (output === content) return tr;

        changed = true;
        return {
          ...tr,
          content: output,
          wasTruncated: tr.wasTruncated || note.savingsPct > 0 ? true : undefined,
          _compressed: true as unknown as boolean,
        } as ToolResultData & { _compressed?: boolean };
      });

      if (!changed) return msg;
      return { ...msg, toolResults: newResults };
    });
  }

  /**
   * L2: Truncate oversized tool results in all messages.
   * Tool results exceeding the threshold are replaced with a short placeholder
   * keeping the first 200 characters as a preview.
   *
   * @param messages — message array to process
   * @returns new message array (does not modify the original)
   */
  truncateToolOutputs(messages: Message[]): Message[] {
    return messages.map(msg => {
      if (!msg.toolResults || msg.toolResults.length === 0) return msg;

      let changed = false;
      const newResults = msg.toolResults.map((tr: ToolResultData) => {
        if (this._strategy.shouldTruncateToolOutput(tr.content)) {
          changed = true;
          return {
            ...tr,
            content: truncateToolContent(tr.content, 200, 200),
            wasTruncated: true,
            _pruned: true,
          };
        }
        return tr;
      });

      if (!changed) return msg;
      return { ...msg, toolResults: newResults };
    });
  }

  // ─── L3: Message pruning ───────────────────────────────────

  /**
   * Prune old messages in the middle section.
   * Keeps head (system message) and tail (budget-based count) intact.
   * Only prunes tool results in the compaction zone.
   */
  pruneMessages(messages: Message[], contextWindow: number): Message[] {
    if (messages.length <= 10) return messages;

    // Calculate tail budget: keep recent tokens proportional to remaining capacity
    const tailTokenBudget = Math.max(contextWindow * 0.05, contextWindow * 0.15);

    let tailCount = countTailByBudget(messages, tailTokenBudget, 2);
    // Minimum 3 recent messages, maximum all but system
    tailCount = Math.max(tailCount, Math.min(3, messages.length - 1));

    // Fix orphaned tool_call/tool_result pairs at tail boundary
    const tailStart = messages.length - tailCount;
    tailCount = fixOrphanedPairs(messages, tailStart, tailCount);

    // Prune tool results in the middle section
    const headCount = 1; // system message at index 0
    const middleEnd = messages.length - tailCount;

    const result = messages.slice(0, headCount); // keep system message

    for (let i = headCount; i < middleEnd; i++) {
      const msg = { ...messages[i] };
      if (msg.toolResults && msg.toolResults.length > 0) {
        // Prune long tool results in middle section
        msg.toolResults = msg.toolResults.map((tr: ToolResultData) => {
          if (tr.content && tr.content.length > 1024) {
            return {
              ...tr,
              content: truncateToolContent(tr.content, 1024, 200),
              wasTruncated: true,
            };
          }
          return tr;
        });
      }
      result.push(msg);
    }

    // Add the tail (recent messages)
    for (let i = middleEnd; i < messages.length; i++) {
      result.push(messages[i]);
    }

    return result;
  }

  // ─── L4: LLM summary compression ───────────────────────────

  /**
   * Generate a structured summary of the middle section.
   * Uses the external summarizer if set, otherwise falls back to deterministic summary.
   */
  async generateSummary(
    messages: Message[],
    contextWindow: number,
    threshold: number = COMPRESSION_TRIGGER_RATIO,
    summarizer?: SummarizerFn,
  ): Promise<{ messages: Message[]; summary: string | null; wasCompacted: boolean }> {
    const estimatedTokens = TokenCounter.estimateMessages(messages);
    if (estimatedTokens < contextWindow * threshold) {
      return { messages, summary: null, wasCompacted: false };
    }

    // Calculate tail budget (15% of context or at least 5%)
    const tailTokenBudget = Math.max(
      Math.ceil(estimatedTokens * 0.15),
      Math.ceil(contextWindow * 0.05),
    );

    let tailCount = countTailByBudget(messages, tailTokenBudget, 3);
    tailCount = Math.max(tailCount, Math.min(8, messages.length - 1));

    // Fix orphaned pairs at boundary
    const tailStart = messages.length - tailCount;
    tailCount = fixOrphanedPairs(messages, tailStart, tailCount);

    // Summary budget: proportional to compressed content (20% rule)
    const middleMsgs = messages.slice(1, messages.length - tailCount);
    const compressedTokenCount = TokenCounter.estimateMessages(middleMsgs);
    const summaryBudget = Math.min(
      Math.max(Math.ceil(compressedTokenCount * SUMMARY_RATIO), MIN_SUMMARY_TOKENS),
      SUMMARY_MAX_TOKENS,
    );

    // Prune tool results in the compaction zone before summarizing
    const pruned = this.pruneToolResultsForSummarizer(messages, tailCount);

    // Prepare summarizer input
    const { transcript, files } = this.prepareSummarizerInput(pruned, tailCount);

    if (transcript.length < 500) {
      // Not enough content to summarize — just keep recent
      const sm = messages[0];
      const tail = messages.slice(-tailCount);
      return { messages: [sm, ...tail], summary: null, wasCompacted: false };
    }

    // Call summarizer with timeout
    let summaryText: string | null = null;
    const summarize = summarizer ?? this._summarizer;
    if (summarize) {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        const timeoutPromise = new Promise<null>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Summarizer timeout')), COMPACTION_TIMEOUT_MS);
        });
        summaryText = await Promise.race([
          summarize(messages.slice(1, messages.length - tailCount), summaryBudget),
          timeoutPromise,
        ]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
      } catch (e) {
        createLogger('anochat.llm').warn('Context compressor summarizer failed', { error: (e as Error).message });
        summaryText = this.buildFallbackSummary(messages, tailCount);
      }
    } else {
      summaryText = this.buildFallbackSummary(messages, tailCount);
    }

    if (!summaryText || summaryText.trim().length < VALID_SUMMARY_MIN_CHARS) {
      summaryText = this.buildFallbackSummary(messages, tailCount);
    }

    // Build compacted messages: system + summary with prefix + recent tail
    const tailMsgs = messages.slice(-tailCount);
    const sMsg = messages[0];
    const compacted: Message[] = [
      sMsg,
      {
        id: `compact-summary-${Date.now()}`,
        sessionId: messages[0]?.sessionId || '',
        role: MessageRole.System,
        content: SUMMARY_PREFIX + '\n\n' + summaryText,
        tokenCount: TokenCounter.estimate(summaryText),
        compressed: true,
        timestamp: new Date().toISOString(),
      },
      ...tailMsgs,
    ];

    this.emit('compactionComplete', {
      prunedCount: messages.length - compacted.length + 1,
      summaryLength: summaryText.length,
    });

    // Emit to TypedEventBus for monitoring/audit
    TypedEventBus.emit('loop:compaction_triggered', {
      sessionId: messages[0]?.sessionId || '',
      beforeTokens: estimatedTokens,
      afterTokens: TokenCounter.estimate(summaryText) + TokenCounter.estimateMessages(tailMsgs),
    });

    return { messages: compacted, summary: summaryText, wasCompacted: true };
  }

  // ─── Summarizer helpers ────────────────────────────────────

  /**
   * Prune tool results in the middle section before sending to summarizer.
   * Only trims results >1KB to placeholders.
   */
  private pruneToolResultsForSummarizer(
    messages: Message[],
    keepRecent: number,
  ): Message[] {
    if (messages.length <= keepRecent + 3) return messages;

    const middleStart = 1; // after system message
    const middleEnd = messages.length - keepRecent;
    const pruned = [...messages];

    for (let i = middleStart; i < middleEnd; i++) {
      if (pruned[i].toolResults) {
        const newResults = pruned[i].toolResults!.map((tr: ToolResultData) => {
          if (tr.content && tr.content.length > 1024) {
            return {
              ...tr,
              content: PRUNED_TOOL_PLACEHOLDER,
              wasTruncated: true,
            };
          }
          return tr;
        });
        pruned[i] = { ...pruned[i], toolResults: newResults };
      }
    }
    return pruned;
  }

  /**
   * Prepare messages for the summarizer.
   * Truncates tool results, extracts file paths, formats as readable transcript.
   */
  prepareSummarizerInput(
    messages: Message[],
    keepRecent: number,
  ): { transcript: string; files: string[] } {
    if (messages.length <= keepRecent + 3) {
      return { transcript: '', files: [] };
    }

    const middle = messages.slice(1, -keepRecent || messages.length);

    // Collect file paths mentioned
    const files = new Set<string>();
    for (const msg of middle) {
      const text = msg.content || '';
      for (const match of text.matchAll(PATH_MENTION_RE)) {
        const p = match[0].replace(/[.,;:)$\]}]+$/, '');
        if (p.length > 2 && p.length < 200) files.add(p);
      }
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          for (const match of (tr.content || '').matchAll(PATH_MENTION_RE)) {
            const p = match[0].replace(/[.,;:)$\]}]+$/, '');
            if (p.length > 2 && p.length < 200) files.add(p);
          }
        }
      }
    }

    // Build summarizer input — trimmed for token efficiency
    const lines: string[] = [];
    const recentMiddle = middle.slice(-60); // last 60 middle messages
    for (const msg of recentMiddle) {
      let content = msg.content || '';
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          content += '\n' + (
            tr.content.length > MAX_TOOL_RESULT_FOR_SUMMARIZER
              ? tr.content.slice(0, MAX_TOOL_RESULT_FOR_SUMMARIZER) + '...'
              : tr.content
          );
        }
      }
      const prefix = rolePrefix(msg.role);
      lines.push(`[${prefix}] ${content.slice(0, 500)}`);
    }

    return {
      transcript: lines.join('\n\n').slice(0, 50000),
      files: [...files].slice(0, 15),
    };
  }

  // ─── Fallback summary (deterministic, no API call) ─────────

  /** Build a deterministic fallback summary without calling an LLM. */
  buildFallbackSummary(messages: Message[], keepRecent: number): string {
    const middle = messages.slice(1, -keepRecent || messages.length);
    const lines: string[] = [];

    // Extract last 5 user messages as context anchors
    const userMsgs = middle.filter(m => m.role === 'user');
    const recentUsers = userMsgs.slice(-5);

    if (recentUsers.length > 0) {
      lines.push('## Recent requests');
      for (const msg of recentUsers) {
        const text = (msg.content || '').slice(0, FALLBACK_TURN_MAX_CHARS);
        lines.push(`- ${text}`);
      }
    }

    // Extract file paths
    const files = new Set<string>();
    for (const msg of middle) {
      const text = msg.content || '';
      for (const match of text.matchAll(PATH_MENTION_RE)) {
        const p = match[0].replace(/[.,;:)$\]}]+$/, '');
        if (p.length > 2 && p.length < 200) files.add(p);
      }
    }
    if (files.size > 0) {
      lines.push('\n## Files mentioned');
      for (const f of [...files].slice(0, 20)) lines.push(`- ${f}`);
    }

    return lines.join('\n').slice(0, FALLBACK_SUMMARY_MAX_CHARS);
  }

  // ══════════════════════════════════════════════════════════════
  // Expose the structured summary prompt for external LLM calls
  // ══════════════════════════════════════════════════════════════

  /**
   * Return the structured summary prompt template.
   * For use by external LLM calls, defines the sections a summary should contain.
   */
  get structuredSummaryPrompt(): string {
    return STRUCTURED_SUMMARY_PROMPT;
  }

  /**
   * Estimate content length for budget calculation.
   * Supports strings, string arrays, and multimodal content blocks
   * (images count as equivalent character count).
   *
   * @param content — message content, may be a string or ContentBlock array
   * @returns equivalent character count
   */
  static contentLengthForBudget(content: unknown): number {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return String(content || '').length;

    let total = 0;
    for (const part of content as Array<unknown>) {
      const p = part as { type?: string; text?: string };
      if (typeof part === 'string') { total += (part as string).length; continue; }
      if (!part || typeof part !== 'object') { total += String(part).length; continue; }
      if (p.type === 'image_url' || p.type === 'input_image' || p.type === 'image') {
        total += IMAGE_CHAR_EQUIVALENT;
      } else {
        total += (p.text || '').length;
      }
    }
    return total;
  }
}
