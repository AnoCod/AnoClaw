/**
 * PatternDetector — M1: detect repeated tool call sequences across sessions.
 *
 * Normalizes tool call sequences into canonical signatures (sorted parameter names)
 * so the same pattern from different sessions or with slightly different params
 * is recognized as the same. Stores patterns in EvolutionStore for persistence.
 *
 * Threshold for triggering skill creation: count >= 3
 * Threshold for re-evaluation: count >= 5 and skill already exists
 */

import type { EvolutionStore } from '../storage/EvolutionStore.js';
import type { EvolutionPattern, ToolCallSignature } from '../../../../shared/types/evolution.js';
import { createLogger } from '../../logger.js';

export class PatternDetector {
  private _store: EvolutionStore;
  private _patterns: EvolutionPattern[] = [];
  private _loaded = false;
  private _log = createLogger('anochat.evolution.pattern');

  constructor(store: EvolutionStore) {
    this._store = store;
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    const stored = await this._store.readPatterns();
    if (stored) this._patterns = stored.patterns;
    this._loaded = true;
  }

  /**
   * Build a canonical signature from tool names only (parameters are ignored).
   * "Read→Edit" and "Read→Edit" match regardless of which files are involved.
   */
  private _sigKey(sig: ToolCallSignature[]): string {
    return sig.map(s => s.tool).join('→');
  }

  /**
   * Record a sequence of tool calls and detect if it matches a known pattern.
   * Returns the matched/created pattern, or null if too short.
   */
  async recordToolSequence(
    sessionId: string,
    toolSequence: ToolCallSignature[],
    totalTokenCost: number,
  ): Promise<EvolutionPattern | null> {
    if (toolSequence.length < 1) return null;

    await this._ensureLoaded();
    const newSig = this._sigKey(toolSequence);

    const existing = this._patterns.find(p => this._sigKey(p.signature) === newSig);

    if (existing) {
      existing.count++;
      existing.lastSeen = new Date().toISOString();
      existing.avgTokenCost = Math.round(
        (existing.avgTokenCost * (existing.count - 1) + totalTokenCost) / existing.count,
      );
      if (!existing.sessions.includes(sessionId)) {
        existing.sessions.push(sessionId);
      }
      this._log.debug('Pattern count incremented', {
        patternId: existing.patternId, count: existing.count,
      });
      return existing;
    }

    // New pattern
    const pattern: EvolutionPattern = {
      patternId: `pat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      signature: toolSequence,
      count: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      sessions: [sessionId],
      avgTokenCost: totalTokenCost,
      skillId: null,
    };
    this._patterns.push(pattern);
    this._log.debug('New pattern recorded', { patternId: pattern.patternId, tools: toolSequence.map(t => t.tool).join('→') });
    return pattern;
  }

  /**
   * Get patterns with count >= threshold that haven't been linked to a skill yet.
   * @param threshold Minimum count to be considered "skill candidate" (default: 3)
   */
  getSkillCandidates(threshold = 3): EvolutionPattern[] {
    return this._patterns.filter(p => p.count >= threshold && p.skillId === null);
  }

  /**
   * Get patterns with count >= threshold that DO have a skill linked (need re-evaluation).
   */
  getExistingSkillsNeedingReeval(threshold = 5): EvolutionPattern[] {
    return this._patterns.filter(p => p.count >= threshold && p.skillId !== null);
  }

  /**
   * Link a generated skill to a pattern.
   */
  linkSkill(patternId: string, skillId: string): void {
    const pattern = this._patterns.find(p => p.patternId === patternId);
    if (pattern) {
      pattern.skillId = skillId;
      this._log.info('Pattern linked to skill', { patternId, skillId });
    }
  }

  /**
   * Get a pattern by ID.
   */
  getPattern(patternId: string): EvolutionPattern | undefined {
    return this._patterns.find(p => p.patternId === patternId);
  }

  /** Get all recorded patterns. */
  getAllPatterns(): EvolutionPattern[] {
    return [...this._patterns];
  }

  /** Persist patterns to store. */
  async flush(): Promise<void> {
    await this._store.writePatterns({
      version: 1,
      updatedAt: new Date().toISOString(),
      patterns: this._patterns,
    });
  }

  /** Load patterns from store. */
  async load(): Promise<void> {
    this._loaded = false;
    await this._ensureLoaded();
  }
}
