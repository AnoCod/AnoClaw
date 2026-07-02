/**
 * QualityScoreManager — M5: manage, persist, and aggregate quality scores.
 *
 * Scores are stored via EvolutionStore (JSONL daily shards) and cached
 * in memory for fast queries. Update on same (messageId + sessionId + agentId)
 * overwrites the previous score for that message.
 */

import type { EvolutionStore } from '../storage/EvolutionStore.js';
import type { QualityScore } from '../../../../shared/types/evolution.js';
import { createLogger } from '../../logger.js';

export interface ScoreStats {
  totalScores: number;
  globalAvg: number;
  byAgent: Record<string, { count: number; avg: number }>;
  bySession: Record<string, { count: number; avg: number }>;
}

export class QualityScoreManager {
  private _store: EvolutionStore;
  private _cache: QualityScore[] = [];
  private _loaded = false;
  private _log = createLogger('anochat.evolution.score');

  constructor(store: EvolutionStore) {
    this._store = store;
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    this._cache = await this._store.readScores();
    this._loaded = true;
  }

  /**
   * Save a quality score. If a score with the same (messageId + sessionId + agentId)
   * already exists, it is updated in-place. Returns the saved score.
   */
  async saveScore(score: QualityScore): Promise<QualityScore> {
    await this._ensureLoaded();

    // Update in cache if same message+session+agent
    const existingIdx = this._cache.findIndex(
      s => s.messageId === score.messageId
        && s.sessionId === score.sessionId
        && s.agentId === score.agentId
        && s.id === score.id,
    );

    if (existingIdx >= 0) {
      this._cache[existingIdx] = { ...this._cache[existingIdx], ...score, updatedAt: new Date().toISOString() };
      const updated = this._cache[existingIdx];
      // Persist by re-appending to JSONL (append-only, latest record takes precedence in reports)
      await this._store.appendScore(updated);
      this._log.debug('Score updated', { id: score.id, score: score.score });
      return updated;
    }

    const saved = { ...score, id: score.id || `score-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
    this._cache.push(saved);
    await this._store.appendScore(saved);
    this._log.debug('Score saved', { id: saved.id, score: saved.score });
    return saved;
  }

  /** Get all recent scores (from cache, persisted). */
  async getRecentScores(limit = 100): Promise<QualityScore[]> {
    await this._ensureLoaded();
    return this._cache.slice(-limit);
  }

  /** Get all scores for a specific session. */
  async getSessionScores(sessionId: string): Promise<QualityScore[]> {
    await this._ensureLoaded();
    return this._cache.filter(s => s.sessionId === sessionId);
  }

  /** Compute average score for a specific agent. */
  async getAgentAverage(agentId: string): Promise<number> {
    await this._ensureLoaded();
    const scores = this._cache.filter(s => s.agentId === agentId);
    if (scores.length === 0) return 0;
    return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  }

  /** Compute average score for a specific session. */
  async getSessionAverage(sessionId: string): Promise<number> {
    await this._ensureLoaded();
    const scores = this._cache.filter(s => s.sessionId === sessionId);
    if (scores.length === 0) return 0;
    return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  }

  /** Compute full stats summary. */
  async getStats(): Promise<ScoreStats> {
    await this._ensureLoaded();
    const byAgent: Record<string, { count: number; sum: number }> = {};
    const bySession: Record<string, { count: number; sum: number }> = {};
    let totalScores = 0;
    let sum = 0;

    for (const s of this._cache) {
      totalScores++;
      sum += s.score;

      if (!byAgent[s.agentId]) byAgent[s.agentId] = { count: 0, sum: 0 };
      byAgent[s.agentId].count++;
      byAgent[s.agentId].sum += s.score;

      if (!bySession[s.sessionId]) bySession[s.sessionId] = { count: 0, sum: 0 };
      bySession[s.sessionId].count++;
      bySession[s.sessionId].sum += s.score;
    }

    const agentStats: Record<string, { count: number; avg: number }> = {};
    for (const [id, v] of Object.entries(byAgent)) {
      agentStats[id] = { count: v.count, avg: v.sum / v.count };
    }

    const sessionStats: Record<string, { count: number; avg: number }> = {};
    for (const [id, v] of Object.entries(bySession)) {
      sessionStats[id] = { count: v.count, avg: v.sum / v.count };
    }

    return {
      totalScores,
      globalAvg: totalScores > 0 ? sum / totalScores : 0,
      byAgent: agentStats,
      bySession: sessionStats,
    };
  }

  /** Reload scores from store (e.g. after new data from another source). */
  async reload(): Promise<void> {
    this._loaded = false;
    await this._ensureLoaded();
  }
}
