// TokenCounter — token estimation and breakdown
// Uses gpt-tokenizer for accurate counting (compatible with DeepSeek/GPT-4 tokenizers).
// Falls back to heuristic chars/4 when tokenizer is unavailable.

import { createRequire } from 'node:module';
import type { TokenBreakdown, Message } from '../../../shared/types/session.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../../shared/constants.js';

// ─── Real tokenizer (lazy-loaded, sync via createRequire) ────────

let _tokenizerModule: { encode: (text: string) => number[] } | null = null;
let _tokenizerLoadAttempted = false;

function getTokenizer(): { encode: (text: string) => number[] } | null {
  if (_tokenizerLoadAttempted) return _tokenizerModule;
  _tokenizerLoadAttempted = true;
  try {
    const req = createRequire(import.meta.url);
    _tokenizerModule = req('gpt-tokenizer') as { encode: (text: string) => number[] } | null;
  } catch { /* will fall back to heuristic */ }
  return _tokenizerModule;
}

/**
 * Count tokens using real tokenizer when available.
 * Falls back to heuristic estimation when tokenizer can't load.
 */
/**
 * Chunk size for token counting — gpt-tokenizer uses recursive BPE that
 * overflows the stack on very large inputs. Chunk at 100K chars to stay safe.
 */
const TOKEN_COUNT_CHUNK_SIZE = 100_000;

function countTokensReal(text: string): number {
  if (!text) return 0;
  const tok = getTokenizer();
  if (!tok) return TokenCounter._heuristicEstimate(text);
  // Chunk large strings to avoid BPE stack overflow on recursive encoding
  if (text.length <= TOKEN_COUNT_CHUNK_SIZE) {
    return tok.encode(text).length;
  }
  let total = 0;
  for (let i = 0; i < text.length; i += TOKEN_COUNT_CHUNK_SIZE) {
    total += tok.encode(text.slice(i, i + TOKEN_COUNT_CHUNK_SIZE)).length;
  }
  return total;
}

// ─── Heuristic fallback (chars/4, CJK-aware) ────────────────────

const CHARS_PER_TOKEN_PROSE = 4;
const CHARS_PER_TOKEN_CODE = 2;
const CJK_CHAR_WEIGHT = 1.5;
const TOOLS_PER_TOKEN = 4;

// ─── Content type detection ─────────────────────────────────────

const JSON_PAT = /^\s*[\[{]/;
const CODE_PAT = /^(#!|\/\/|\/\*|\*\/|import |export |function |class |const |let |var |if \(|for \(|while \(|def |```)/m;
const MARKDOWN_CODE_RE = /```[\s\S]*?```/g;

function detectContentType(text: string): 'json' | 'code' | 'prose' {
  const stripped = text.replace(MARKDOWN_CODE_RE, '');
  if (!stripped) return 'prose';
  if (JSON_PAT.test(stripped) && (stripped.includes('":') || stripped.includes('": '))) {
    return 'json';
  }
  if (CODE_PAT.test(stripped)) return 'code';
  let structural = 0;
  let alpha = 0;
  for (const ch of stripped) {
    if ('{}[]()"\'`;:.,<>|&^*/\\+-=!@#$%'.includes(ch)) structural++;
    else if (/[a-zA-Z]/.test(ch)) alpha++;
  }
  if (structural > stripped.length * 0.15 && structural > alpha * 0.5) {
    return 'json';
  }
  return 'prose';
}

// ─── Tool definition cache ──────────────────────────────────────

let _cachedToolsKey = '';
let _cachedToolsTokens = 0;

function estimateToolsTokens(tools: unknown[]): number {
  const key = tools.length + ':' + tools.map((t: any) => t?.name ?? '').sort().join(',');
  if (key === _cachedToolsKey) return _cachedToolsTokens;
  const tok = getTokenizer();
  const total = tok
    ? tok.encode(JSON.stringify(tools)).length
    : Math.ceil(JSON.stringify(tools).length / TOOLS_PER_TOKEN);
  _cachedToolsKey = key;
  _cachedToolsTokens = total;
  return total;
}

// ─── TokenCounter ─────────────────────────────────────────────────

export class TokenCounter {
  /** Heuristic fallback estimate (CJK-aware chars-based). Internal use only. */
  static _heuristicEstimate(text: string): number {
    if (!text) return 0;
    const ctype = detectContentType(text);
    let cjkChars = 0;
    let otherChars = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x20000 && code <= 0x2A6DF) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0x3040 && code <= 0x309F) ||
        (code >= 0x30A0 && code <= 0x30FF)
      ) {
        cjkChars++;
      } else {
        otherChars++;
      }
    }
    const nonCjkTokens = ctype === 'prose'
      ? otherChars / CHARS_PER_TOKEN_PROSE
      : otherChars / CHARS_PER_TOKEN_CODE;
    return Math.ceil(cjkChars * CJK_CHAR_WEIGHT + nonCjkTokens);
  }

  /**
   * Accurate token count. Uses gpt-tokenizer when available,
   * falls back to heuristic estimation.
   */
  static estimate(text: string): number {
    return countTokensReal(text);
  }

  /** Estimate tokens for an array of messages. */
  static estimateMessages(messages: readonly Message[]): number {
    if (!messages || messages.length === 0) return 0;
    let total = 0;
    for (const msg of messages) {
      total += countTokensReal(msg.content || '');
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        total += countTokensReal(JSON.stringify(msg.toolCalls));
      }
      if (msg.toolResults && msg.toolResults.length > 0) {
        for (const tr of msg.toolResults) {
          total += countTokensReal(tr.content || '');
        }
      }
    }
    return total;
  }

  /** Full breakdown including tool-definition caching. */
  static breakdown(
    systemPrompt: string,
    tools: unknown[],
    skillsText: string,
    messages: readonly Message[],
    contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  ): TokenBreakdown {
    const systemPromptTokens = countTokensReal(systemPrompt || '');
    const systemToolsTokens = tools && tools.length > 0 ? estimateToolsTokens(tools) : 0;
    const skillsTokens = skillsText ? countTokensReal(skillsText) : 0;
    const messagesTokens = messages ? TokenCounter.estimateMessages(messages) : 0;
    const total = systemPromptTokens + systemToolsTokens + skillsTokens + messagesTokens;
    const freeSpace = Math.max(0, contextWindow - total);

    return {
      systemPrompt: systemPromptTokens,
      systemTools: systemToolsTokens,
      skills: skillsTokens,
      messages: messagesTokens,
      freeSpace,
      total,
    };
  }

  /** Check if we're over the compression trigger threshold */
  static isOverThreshold(
    usedTokens: number,
    contextWindow: number,
    threshold: number = 0.7,
  ): boolean {
    return usedTokens > contextWindow * threshold;
  }

  /** Check if we can proceed (under 95% of context window) */
  static canProceed(usedTokens: number, contextWindow: number): boolean {
    return usedTokens < contextWindow * 0.95;
  }

  /** Percentage used */
  static usagePercent(usedTokens: number, contextWindow: number): number {
    return Math.round((usedTokens / contextWindow) * 1000) / 10;
  }

  /** Get the real tokenizer if available, for direct use by callers. */
  static realTokenizerAvailable(): boolean {
    return getTokenizer() !== null;
  }

  // ─── Utility percentage getters ───────────────────────────────

  static systemPromptPct(bd: TokenBreakdown): number {
    return bd.total > 0 ? Math.round((bd.systemPrompt / bd.total) * 1000) / 10 : 0;
  }
  static systemToolsPct(bd: TokenBreakdown): number {
    return bd.total > 0 ? Math.round((bd.systemTools / bd.total) * 1000) / 10 : 0;
  }
  static skillsPct(bd: TokenBreakdown): number {
    return bd.total > 0 ? Math.round((bd.skills / bd.total) * 1000) / 10 : 0;
  }
  static messagesPct(bd: TokenBreakdown): number {
    return bd.total > 0 ? Math.round((bd.messages / bd.total) * 1000) / 10 : 0;
  }
  static freePct(bd: TokenBreakdown): number {
    const ctxWindow = bd.total + bd.freeSpace;
    return ctxWindow > 0 ? Math.round((bd.freeSpace / ctxWindow) * 1000) / 10 : 0;
  }
}
