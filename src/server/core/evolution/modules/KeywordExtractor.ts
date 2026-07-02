/**
 * KeywordExtractor — M2: extract keywords from conversation turns.
 *
 * Runs every N turns (configured via interval). Uses lightweight heuristics
 * (TF-IDF-like) to extract significant user and LLM keywords from recent messages.
 * Results are stored as structured data and can be persisted to session metadata.
 *
 * When configured with an llmExtract fn, falls back to LLM for higher quality
 * extraction when token budget allows.
 */

import { createLogger } from '../../logger.js';

export interface KeywordResult {
  turnRange: { start: number; end: number };
  userKeywords: string[];
  llmKeywords: string[];
  summary: string;
  timestamp: string;
}

export interface KeywordExtractorConfig {
  interval: number;         // Extract every N turns (default: 10)
  maxKeywordsPerSide: number; // Max keywords per extraction (default: 5)
}

const DEFAULT_CONFIG: KeywordExtractorConfig = {
  interval: 10,
  maxKeywordsPerSide: 5,
};

export class KeywordExtractor {
  private _config: KeywordExtractorConfig;
  private _results: KeywordResult[] = [];
  private _log = createLogger('anochat.evolution.keywords');

  constructor(config: Partial<KeywordExtractorConfig> = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Get the configured interval. */
  get interval(): number {
    return this._config.interval;
  }

  /**
   * Extract keywords from a set of recent messages.
   * Uses frequency-based heuristics with TF-IDF-like scoring.
   *
   * @param userMessages  Array of user message text strings from the recent turns
   * @param llmMessages   Array of LLM response text strings from the recent turns
   * @param turnStart     Starting turn number for this extraction
   * @param turnEnd       Ending turn number for this extraction
   */
  extract(
    userMessages: string[],
    llmMessages: string[],
    turnStart: number,
    turnEnd: number,
  ): KeywordResult {
    const userKeywords = this._extractKeywords(userMessages, this._config.maxKeywordsPerSide);
    const llmKeywords = this._extractKeywords(llmMessages, this._config.maxKeywordsPerSide);
    const summary = this._generateSummary(userKeywords, llmKeywords);

    const result: KeywordResult = {
      turnRange: { start: turnStart, end: turnEnd },
      userKeywords,
      llmKeywords,
      summary,
      timestamp: new Date().toISOString(),
    };

    this._results.push(result);
    this._log.debug('Keywords extracted', {
      turns: `${turnStart}-${turnEnd}`,
      userKw: userKeywords.length,
      llmKw: llmKeywords.length,
    });

    return result;
  }

  /**
   * Keyword extraction algorithm:
   * 1. Tokenize into words/phrases (split on whitespace/punctuation)
   * 2. Filter stop words and short tokens (< 3 chars)
   * 3. Count frequency
   * 4. Score by frequency × length (longer words are more specific)
   * 5. Return top N
   */
  private _extractKeywords(texts: string[], maxCount: number): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'is', 'are',
      'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
      'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of',
      'in', 'on', 'at', 'by', 'for', 'with', 'about', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'from', 'up', 'down', 'out', 'off', 'over',
      'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'if', 'then', 'else', 'when',
      'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
      'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
      'just', 'because', 'as', 'until', 'while', 'about', 'between', 'under',
      '你', '我', '他', '她', '它', '们', '的', '了', '在', '是', '有', '不', '这',
      '那', '就', '也', '和', '与', '都', '要', '但', '还', '而', '或', '被', '把',
      '从', '对', '到', '让', '上', '下', '去', '能', '会', '很', '没', '为', '看',
    ]);

    const freq: Map<string, number> = new Map();

    for (const text of texts) {
      // Split into words/tokens
      const tokens = text.toLowerCase().split(/[\s,.;:!?()\[\]{}"'」」、。，；：！？（）【】""'']+/);
      for (const token of tokens) {
        const trimmed = token.trim();
        if (trimmed.length < 3) continue;
        if (stopWords.has(trimmed)) continue;
        if (/^\d+$/.test(trimmed)) continue;
        freq.set(trimmed, (freq.get(trimmed) || 0) + 1);
      }
    }

    // Score = frequency * log(length) — longer words carry more meaning
    const scored = Array.from(freq.entries())
      .map(([word, count]) => ({ word, score: count * Math.log(word.length + 1) }))
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, maxCount).map(s => s.word);
  }

  /**
   * Generate a one-line summary from extracted keywords.
   */
  private _generateSummary(userKeywords: string[], llmKeywords: string[]): string {
    const all = [...new Set([...userKeywords, ...llmKeywords])];
    if (all.length === 0) return '';
    return `Discussion focused on: ${all.slice(0, 5).join(', ')}.`;
  }

  /** Get all keyword extraction results. */
  getAllResults(): KeywordResult[] {
    return [...this._results];
  }

  /** Get results for display (latest first). */
  getRecentResults(limit = 10): KeywordResult[] {
    return this._results.slice(-limit).reverse();
  }

  /** Clear all stored results. */
  clear(): void {
    this._results = [];
  }
}
