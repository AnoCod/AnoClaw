/**
 * EvolutionManager — singleton orchestrator for the self-evolution system.
 *
 * Coordinates all 6 modules:
 *   M1: PatternDetector  — repetition detection
 *   M2: KeywordExtractor — periodic keyword extraction
 *   M3: StatsCollector   — usage statistics
 *   M4: SessionTagger    — session labeling
 *   M5: QualityScoreManager — human quality scores
 *   M6: EvolutionEngine  — analysis + report generation
 *
 * Provides a unified API for AgentRuntime hooks, WS event handlers,
 * and file system persistence via EvolutionStore.
 *
 * @module EvolutionManager
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import { EvolutionStore } from './storage/EvolutionStore.js';
import { QualityScoreManager } from './modules/QualityScoreManager.js';
import { StatsCollector } from './modules/StatsCollector.js';
import { SessionTagger } from './modules/SessionTagger.js';
import { PatternDetector } from './modules/PatternDetector.js';
import { KeywordExtractor } from './modules/KeywordExtractor.js';
import { EvolutionEngine } from './modules/EvolutionEngine.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import type { EvolutionReport, AnalyzeOptions } from './modules/EvolutionEngine.js';
import type { QualityScore, EvolutionPattern } from '../../../shared/types/evolution.js';
import { createLogger } from '../logger.js';
import { SkillManager } from '../skills/SkillManager.js';

export { EvolutionEngine } from './modules/EvolutionEngine.js';
export type { EvolutionReport, AnalyzeOptions, SkillChange, MemoryFinding, PromptSuggestion, TokenFinding } from './modules/EvolutionEngine.js';

export class EvolutionManager extends EventEmitter {
  private static _instance: EvolutionManager;

  readonly store: EvolutionStore;
  readonly scores: QualityScoreManager;
  readonly stats: StatsCollector;
  readonly tagger: SessionTagger;
  readonly patterns: PatternDetector;
  readonly keywords: KeywordExtractor;
  readonly engine: EvolutionEngine;

  private _initialized = false;
  private _log = createLogger('anochat.evolution');

  /** The directory path used for evolution data storage */
  static readonly DATA_DIR = 'data/evolution';

  static getInstance(): EvolutionManager {
    if (!this._instance) {
      this._instance = new EvolutionManager();
    }
    return this._instance;
  }

  static resetInstance(): void {
    this._instance = undefined as unknown as EvolutionManager;
  }

  private constructor() {
    super();
    const dir = path.resolve(process.cwd(), EvolutionManager.DATA_DIR);
    this.store = new EvolutionStore(dir);
    this.scores = new QualityScoreManager(this.store);
    this.stats = new StatsCollector(this.store);
    this.tagger = new SessionTagger();
    this.patterns = new PatternDetector(this.store);
    this.keywords = new KeywordExtractor();
    this.engine = new EvolutionEngine(this.store, this.scores, this.stats, this.tagger);
  }

  /** Initialize all modules. Load persisted data. */
  async init(): Promise<void> {
    if (this._initialized) return;
    await this.store.init();
    await this.stats.load();
    await this.patterns.load();

    this._initialized = true;
    this._log.info('Evolution system initialized');
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  // ── M5: Quality Score convenience methods ──

  /** Save a quality score (forwarded from WS handler). */
  async saveScore(score: QualityScore): Promise<QualityScore> {
    const saved = await this.scores.saveScore(score);
    TypedEventBus.emit('evolution:score_saved', {
      score: {
        id: saved.id,
        sessionId: saved.sessionId,
        agentId: saved.agentId,
        messageId: saved.messageId,
        score: saved.score,
      },
    });
    return saved;
  }

  // ── M3: Stats recording convenience methods ──

  /** Record a tool execution (called from TypedEventBus subscription or hook). */
  recordToolCall(toolName: string, success: boolean, tokensUsed: number, durationMs: number): void {
    this.stats.recordToolCall(toolName, success, tokensUsed, durationMs);
  }

  // ── M6: Evolution analysis ──

  /** Run evolution analysis. Returns a report ready for preview. */
  async analyze(options?: Partial<AnalyzeOptions>): Promise<EvolutionReport> {
    const report = await this.engine.analyze({
      mode: options?.mode || 'dry-run',
      skillArchiveDays: options?.skillArchiveDays,
      scoreThreshold: options?.scoreThreshold,
      promptMinScores: options?.promptMinScores,
    });
    TypedEventBus.emit('evolution:analysis_complete', {
      reportId: report.id,
      mode: report.mode,
      totalFindings: report.summary.totalFindings,
      criticalFindings: report.summary.criticalFindings,
    });
    return report;
  }

  /** Persist all volatile data to disk. */
  async flush(): Promise<void> {
    await this.stats.flush();
    await this.patterns.flush();
    this._log.debug('Evolution data flushed');
  }

  // ── M1: Generate SKILL.md from a detected pattern ──

  /**
   * Generate a SKILL.md file from a detected pattern and register it.
   * Returns the skill name if created, null if skipped.
   */
  async generateSkillFromPattern(patternId: string): Promise<string | null> {
    const pattern = this.patterns.getPattern(patternId);
    if (!pattern || pattern.skillId !== null) return null;

    try {
      // Delegate to SkillManager's LLM-powered autoGenerateSkill
      const skillName = await SkillManager.getInstance().autoGenerateSkill(
        [], // transcript not available from pattern — LLM will work from sessions
        pattern.signature.map(s => ({ name: s.tool })),
      );

      if (skillName) {
        // Link pattern to generated skill
        this.patterns.linkSkill(patternId, skillName);
        await this.patterns.flush();
        this._log.info('LLM-generated skill from pattern', { skillName, patternId, count: pattern.count });
      }
      return skillName;
    } catch (err) {
      this._log.warn('Failed to generate skill from pattern', {
        patternId,
        error: (err as Error).message,
      });
      return null;
    }
  }
}
