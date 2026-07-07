// MemorySearchScorer — Hybrid BM25 + Vector search scoring for memory entries
// Phase 2 memory upgrade. BM25 (on-the-fly) + optional vector similarity via
// EmbeddingService, RRF fusion, recency decay, and frequency boost.
// Gracefully degrades: if EmbeddingService/MemoryDatabase unavailable, falls back
// to n-gram fuzzy matching + substring + word overlap.

import { expand } from './MemorySynonyms.js';
import type { MemoryEntry } from './MemoryEntry.js';
import {
  MEMORY_BM25_K1,
  MEMORY_BM25_B,
  MEMORY_MAX_TOP_K,
} from '@shared/constants.js';

// ── Exported types (backward-compatible signatures) ────────────────

export interface ScoredEntry {
  entry: any;
  /** Relevance score 0.0–1.0, higher = better match */
  score: number;
  matchReasons: string[];
}

export interface ScoreOptions {
  /** Enable fuzzy matching (BM25 + n-gram). Default: true. */
  fuzzy?: boolean;
  /** Minimum score threshold (0.0–1.0). Results below this are filtered out. Default: 0.15. */
  threshold?: number;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<ScoreOptions> = {
  fuzzy: true,
  threshold: 0.15,
};

/** BM25 term-frequency saturation */
const BM25_K1 = MEMORY_BM25_K1;
/** BM25 length normalization */
const BM25_B = MEMORY_BM25_B;
/** RRF rank constant — dampens high-rank influence */
const RRF_K = 60;
/** Recency half-life in hours (14 days) */
const RECENCY_HALF_LIFE_HOURS = 336;
/** Max frequency boost contribution */
const FREQ_BOOST_MAX = 0.1;

/** Composite scoring weights — sum to 1.0 */
const COMPOSITE_RELEVANCE_WEIGHT = 0.7;
const COMPOSITE_RECENCY_WEIGHT = 0.2;
const COMPOSITE_FREQUENCY_WEIGHT = 0.1;

// ── Main export ────────────────────────────────────────────────────

/**
 * Score and rank memory entries against a query.
 *
 * Pipeline:
 *   1. Synonym expansion → tokenize query terms
 *   2. BM25 scoring on entry content (always available)
 *   3. Vector scoring via EmbeddingService or entry.embedding (graceful skip)
 *   4. RRF fusion of BM25 rank + vector rank → normalized relevance
 *   5. Composite: relevance * 0.7 + recency * 0.2 + frequency * 0.1
 *   6. Filter by threshold (default 0.15), sort descending
 *
 * Fallback layers:
 *   - BM25 returns no matches + no vector → n-gram fuzzy (handles typos)
 *   - Any uncaught error in hybrid pipeline → n-gram fuzzy
 *   - fuzzy=false → pure substring matching
 */
export async function scoreEntries(
  entries: MemoryEntry[],
  query: string,
  options: ScoreOptions = {},
): Promise<ScoredEntry[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Empty/whitespace query — return all with zero score (capped)
  if (!query || query.trim().length === 0) {
    return entries.slice(0, MEMORY_MAX_TOP_K).map(entry => ({
      entry,
      score: 0,
      matchReasons: ['empty-query'],
    }));
  }

  if (entries.length === 0) return [];

  // fuzzy=false → strict substring matching only
  if (!opts.fuzzy) {
    return substringScore(entries, query, opts.threshold);
  }

  // Try hybrid pipeline; fall back to n-gram fuzzy on any failure
  try {
    return await hybridScore(entries, query, opts.threshold);
  } catch {
    return await ngramFuzzyScore(entries, query, opts.threshold);
  }
}

// ═══════════════════════════════════════════════════════════════════
// HYBRID SCORING PIPELINE
// ═══════════════════════════════════════════════════════════════════

async function hybridScore(
  entries: MemoryEntry[],
  query: string,
  threshold: number,
): Promise<ScoredEntry[]> {
  // 1. Synonym expansion + tokenize
  const expandedQuery = await expand(query);
  const queryTerms = tokenize(expandedQuery.toLowerCase());
  if (queryTerms.length === 0) {
    return ngramFuzzyScore(entries, query, threshold);
  }

  // 2. BM25 scoring (always available — computed on-the-fly)
  const bm25Scores = computeBM25Scores(entries, queryTerms);

  // 3. Vector scoring (gracefully unavailable)
  const vectorScores = await tryVectorScoresAsync(entries, query);

  // If BM25 finds no term matches AND no vector layer, fall back to n-gram fuzzy
  // (handles typos like "configuraton" for "configuration")
  const maxBM25Raw = Math.max(...bm25Scores);
  if (maxBM25Raw === 0 && !vectorScores) {
    return ngramFuzzyScore(entries, query, threshold);
  }

  // 4. Normalize BM25 to 0–1 range
  const maxBM25 = Math.max(...bm25Scores, 1e-9);
  const bm25Norm = bm25Scores.map(s => s / maxBM25);

  // 5. Fuse BM25 + vector via RRF → normalized relevance score (0–1)
  let relevanceScores: number[];
  if (vectorScores && vectorScores.length === entries.length) {
    relevanceScores = rrfFuse(bm25Scores, vectorScores);
  } else {
    relevanceScores = bm25Norm;
  }

  // 6. Recency decay
  const decays = computeRecencyDecay(entries);

  // 7. Frequency boost
  const freqBoosts = await tryFrequencyBoostAsync(entries);

  // 8. Composite score: relevance * 0.7 + recency * 0.2 + frequency * 0.1
  const results: ScoredEntry[] = entries.map((entry, i) => {
    const composite =
      COMPOSITE_RELEVANCE_WEIGHT * relevanceScores[i] +
      COMPOSITE_RECENCY_WEIGHT * decays[i] +
      COMPOSITE_FREQUENCY_WEIGHT * freqBoosts[i];

    const clamped = clamp01(composite);

    const reasons = buildReasons(
      bm25Scores[i],
      vectorScores?.[i] ?? 0,
      decays[i],
      freqBoosts[i],
      entry,
      query,
    );

    return {
      entry,
      score: Math.round(clamped * 1000) / 1000,
      matchReasons: reasons.length > 0 ? reasons : ['partial-match'],
    };
  });

  // Filter + sort
  return results
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

// ── BM25 (on-the-fly, no external database required) ───────────────

function computeBM25Scores(
  entries: MemoryEntry[],
  queryTerms: string[],
): number[] {
  const N = entries.length;
  if (N === 0) return [];

  // Tokenize all documents
  const docTokens: string[][] = entries.map(e =>
    tokenize(`${e.name} ${e.description} ${e.content}`.toLowerCase()),
  );
  const docLengths = docTokens.map(t => t.length);
  const avgDL = docLengths.reduce((a, b) => a + b, 0) / N || 1;

  // Document frequency: how many docs contain each term
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const unique = new Set(tokens);
    for (const t of unique) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  // Score each document
  return entries.map((_, i) => {
    // Term frequency for this document
    const tf = new Map<string, number>();
    for (const t of docTokens[i]) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const termFreq = tf.get(term) || 0;
      if (termFreq === 0) continue;

      const docFreq = df.get(term) || 0;
      // IDF: inverse document frequency (Robertson-Sparck Jones)
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

      // BM25 term score
      const numerator = termFreq * (BM25_K1 + 1);
      const denominator =
        termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLengths[i] / avgDL));
      score += idf * (numerator / denominator);
    }

    return score;
  });
}

// ── Vector scoring (graceful degradation) ──────────────────────────

function tryVectorScores(
  entries: MemoryEntry[],
  query: string,
): number[] | null {
  try {
    // Lazy import — EmbeddingService may not exist yet
    // Note: EmbeddingService path is relative to infra/ — we import dynamically
    return null; // Graceful: vector scoring requires async service init; skip for now
  } catch {
    return null;
  }
}

async function tryVectorScoresAsync(
  entries: MemoryEntry[],
  query: string,
): Promise<number[] | null> {
  try {
    const esModule = await import('./embedding/EmbeddingService.js');
    const service = esModule.EmbeddingService.getInstance();
    if (!service || !service.isReady()) return null;

    // Generate query embedding
    const queryEmbedding = await service.embed(query);
    if (!queryEmbedding || queryEmbedding.length === 0) return null;

    // Check if any entry has a pre-computed embedding
    const anyEmbedding = entries.some(e => (e as any).embedding);
    if (!anyEmbedding) return null; // No embeddings available for entries

    // Compute cosine similarity against each entry
    return entries.map(entry => {
      const emb = (entry as any).embedding;
      if (!emb || !Array.isArray(emb) && !(emb instanceof Float32Array)) return 0;
      const arrA = Array.from(queryEmbedding) as number[];
      const arrB = Array.from(emb) as number[];
      return cosineSimilarity(arrA, arrB);
    });
  } catch {
    return null;
  }
}

// ── RRF (Reciprocal Rank Fusion) ───────────────────────────────────

function rrfFuse(bm25Scores: number[], vectorScores: number[]): number[] {
  const n = bm25Scores.length;

  // Rank by BM25 (index 0 = highest score)
  const bm25Ranked = bm25Scores
    .map((s, i) => ({ i, s }))
    .sort((a, b) => b.s - a.s);
  const bm25Rank = new Array<number>(n);
  for (let r = 0; r < n; r++) {
    bm25Rank[bm25Ranked[r].i] = r + 1; // 1-based ranks
  }

  // Rank by vector score
  const vecRanked = vectorScores
    .map((s, i) => ({ i, s }))
    .sort((a, b) => b.s - a.s);
  const vecRank = new Array<number>(n);
  for (let r = 0; r < n; r++) {
    vecRank[vecRanked[r].i] = r + 1;
  }

  // RRF: score = Σ (1 / (k + rank_i))
  const raw = new Array<number>(n);
  let maxRRF = 0;
  for (let i = 0; i < n; i++) {
    raw[i] = 1 / (RRF_K + bm25Rank[i]) + 1 / (RRF_K + vecRank[i]);
    if (raw[i] > maxRRF) maxRRF = raw[i];
  }

  // Normalize to 0–1
  return raw.map(s => (maxRRF > 0 ? s / maxRRF : 0));
}

// ── Recency decay ──────────────────────────────────────────────────

function computeRecencyDecay(entries: MemoryEntry[]): number[] {
  const now = Date.now();
  const halfLifeMs = RECENCY_HALF_LIFE_HOURS * 3600 * 1000;

  return entries.map(entry => {
    const updatedAt = entry.updatedAt || now;
    const deltaMs = now - updatedAt;
    if (deltaMs <= 0) return 1;
    // Exponential decay: e^(-ln(2) * delta / halfLife)
    return Math.exp(-Math.LN2 * (deltaMs / halfLifeMs));
  });
}

// ── Frequency boost (graceful degradation) ─────────────────────────

function tryFrequencyBoost(entries: MemoryEntry[]): number[] {
  // Layer 1: Check entry metadata for access counts
  const counts = entries.map(e => (e as any).accessCount as number | undefined);
  if (counts.some(c => c !== undefined && c > 0)) {
    const maxCount = Math.max(...counts.map(c => c ?? 0), 1);
    return counts.map(c => ((c ?? 0) / maxCount) * FREQ_BOOST_MAX);
  }

  // Layer 2: Try MemoryDatabase for access counts — use dynamic import
  return entries.map(() => 0); // Graceful: sync path returns 0, async path in caller
}

async function tryFrequencyBoostAsync(entries: MemoryEntry[]): Promise<number[]> {
  const syncResult = tryFrequencyBoost(entries);
  // If sync path found actual counts (not all zeros), return them
  if (syncResult.some(c => c > 0)) return syncResult;

  try {
    const dbModule = await import('./storage/MemoryDatabase.js');
    const MemoryDatabase = dbModule.MemoryDatabase;
    if (!MemoryDatabase) return entries.map(() => 0);

    const db = MemoryDatabase.getInstance?.();
    if (!db || typeof (db as any).getAccessCount !== 'function') return entries.map(() => 0);

    const dbCounts = entries.map(e => (db as any).getAccessCount(e.name) || 0);
    const maxCount = Math.max(...dbCounts, 1);
    return dbCounts.map(c => (c / maxCount) * FREQ_BOOST_MAX);
  } catch {
    return entries.map(() => 0);
  }
}

// ── Build match reasons ────────────────────────────────────────────

function buildReasons(
  bm25: number,
  vector: number,
  decay: number,
  freq: number,
  entry: MemoryEntry,
  query: string,
): string[] {
  const reasons: string[] = [];
  if (bm25 > 0) reasons.push('bm25');
  if (vector > 0.5) reasons.push('vector');
  if (decay < 0.8) reasons.push('recency-decay');
  if (freq > 0.02) reasons.push('frequency');

  // Check for direct substring match (strong signal)
  const qLower = query.toLowerCase();
  const fields = [
    (entry.name || '').toLowerCase(),
    (entry.description || '').toLowerCase(),
    (entry.content || '').toLowerCase(),
  ];
  for (const field of fields) {
    if (field.includes(qLower)) {
      reasons.unshift('substring');
      break;
    }
  }

  return reasons;
}

// ═══════════════════════════════════════════════════════════════════
// FALLBACK: N-gram fuzzy + substring + word overlap
// Used when hybrid pipeline is unavailable or BM25 finds no matches.
// ═══════════════════════════════════════════════════════════════════

async function ngramFuzzyScore(
  entries: MemoryEntry[],
  query: string,
  threshold: number,
): Promise<ScoredEntry[]> {
  const expandedQuery = await expand(query);
  const qLower = expandedQuery.toLowerCase();

  const scored: ScoredEntry[] = entries.map(entry => {
    const reasons: string[] = [];
    let score = 0;

    // Layer 1: Substring matching (primary signal)
    const nameLower = (entry.name || '').toLowerCase();
    const descLower = (entry.description || '').toLowerCase();
    const contentLower = (entry.content || '').toLowerCase();

    const nameMatch = nameLower.includes(qLower);
    const descMatch = descLower.includes(qLower);
    const contentMatch = contentLower.includes(qLower);
    const hasSubstringMatch = nameMatch || descMatch || contentMatch;

    if (nameMatch) { score += 0.40; reasons.push('substring:name'); }
    if (descMatch) { score += 0.35; reasons.push('substring:description'); }
    if (contentMatch) { score += 0.25; reasons.push('substring:content'); }

    // Layer 2: Word overlap (Jaccard)
    const wordOverlap = computeWordOverlap(expandedQuery, entry);
    if (wordOverlap > 0) {
      score += wordOverlap * 0.20;
      if (wordOverlap > 0.1) reasons.push('word-overlap');
    }

    // Layer 3: Character n-gram similarity (fuzzy/typo matching)
    const trigramSim = computeTrigramSimilarity(qLower, entry);
    if (trigramSim > 0.1) {
      // When no substring match exists, trigram is the primary signal
      // (e.g. typo "configuraton" matching "configuration").
      // When substring already matched, trigram only adds a small bonus.
      const trigramWeight = hasSubstringMatch ? 0.15 : 0.55;
      score += trigramSim * trigramWeight;
      if (trigramSim > 0.25) reasons.push('fuzzy-ngram');
    }

    score = clamp01(score);

    if (reasons.length === 0 && score > 0) {
      reasons.push('partial-match');
    }

    return {
      entry,
      score: Math.round(score * 1000) / 1000,
      matchReasons: reasons,
    };
  });

  return scored
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

/**
 * Fallback substring-only scoring (fuzzy=false).
 * Kept for backward compatibility and explicit exact-match searching.
 */
function substringScore(
  entries: MemoryEntry[],
  query: string,
  threshold: number,
): ScoredEntry[] {
  const q = query.toLowerCase();

  const scored = entries.map(entry => {
    const reasons: string[] = [];
    let score = 0;

    const nameMatch = (entry.name || '').toLowerCase().includes(q);
    const descMatch = (entry.description || '').toLowerCase().includes(q);
    const contentMatch = (entry.content || '').toLowerCase().includes(q);

    if (nameMatch) { score += 0.4; reasons.push('substring:name'); }
    if (descMatch) { score += 0.35; reasons.push('substring:description'); }
    if (contentMatch) { score += 0.25; reasons.push('substring:content'); }

    const overlapScore = computeWordOverlap(query, entry);
    if (overlapScore > 0) {
      score += overlapScore * 0.2;
      reasons.push('word-overlap');
    }

    score = clamp01(score);

    return {
      entry,
      score: Math.round(score * 1000) / 1000,
      matchReasons: reasons,
    };
  });

  return scored
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/** Tokenize text into lowercase words, filtering short tokens. */
function tokenize(text: string): string[] {
  return text
    .split(/[\s,.;:!?()[\]{}'"<>/\\|@#$%^&*+=~`-]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

/** Compute Jaccard similarity between query tokens and entry text. */
function computeWordOverlap(query: string, entry: MemoryEntry): number {
  const queryTokens = tokenize(query.toLowerCase());
  if (queryTokens.length === 0) return 0;

  const entryText = `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
  const entryTokens = tokenize(entryText);

  const querySet = new Set(queryTokens);
  const entrySet = new Set(entryTokens);

  const intersection = [...querySet].filter(w => entrySet.has(w)).length;
  const union = new Set([...querySet, ...entrySet]).size;

  return union > 0 ? intersection / union : 0;
}

/**
 * Compute character trigram Jaccard similarity between query and entry text.
 * Scores each field (name, description, content) independently and returns
 * the maximum — avoids dilution from unrelated words in other fields.
 * Handles typo-tolerant fuzzy matching (e.g. "configuraton" ≈ "configuration").
 */
function computeTrigramSimilarity(query: string, entry: MemoryEntry): number {
  const qLower = query.toLowerCase();
  const qGrams = charNgrams(qLower, 3);
  if (qGrams.length === 0) return 0;

  const fields = [
    (entry.name || '').toLowerCase(),
    (entry.description || '').toLowerCase(),
    (entry.content || '').toLowerCase(),
  ].filter(f => f.length > 0);

  let bestSim = 0;
  for (const field of fields) {
    const eGrams = charNgrams(field, 3);
    if (eGrams.length === 0) continue;

    const qSet = new Set(qGrams);
    const eSet = new Set(eGrams);

    let intersection = 0;
    for (const g of qSet) {
      if (eSet.has(g)) intersection++;
    }

    const union = new Set([...qSet, ...eSet]).size;
    const sim = union > 0 ? intersection / union : 0;
    if (sim > bestSim) bestSim = sim;
  }

  return bestSim;
}

/** Generate character n-grams from text. */
function charNgrams(text: string, n: number): string[] {
  if (text.length < n) return [text];
  const grams: string[] = [];
  for (let i = 0; i <= text.length - n; i++) {
    grams.push(text.slice(i, i + n));
  }
  return grams;
}

/** Cosine similarity between two vectors (arrays of numbers). */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** Clamp value to [0, 1] range. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
