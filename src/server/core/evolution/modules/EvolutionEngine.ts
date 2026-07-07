/**
 * EvolutionEngine — M6: analysis, branch comparison, and report generation.
 *
 * Analyzes data from M1-M5 quality scores, usage stats, patterns, and tags
 * to produce an EvolutionReport with actionable findings. Supports dry-run
 * (preview only) and apply (execute changes) modes.
 *
 * Triggered manually by the user via Settings page, or potentially by cron.
 * All changes must go through a human-reviewed report before application.
 */

import type { EvolutionStore } from '../storage/EvolutionStore.js';
import type { QualityScoreManager, ScoreStats } from './QualityScoreManager.js';
import type { StatsCollector, StatsSnapshot } from './StatsCollector.js';
import type { SessionTagger } from './SessionTagger.js';
import { createLogger } from '../../logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// ── Types ──

export interface SkillChange {
  skillId: string;
  action: 'promote_branch' | 'archive' | 'keep';
  reason: string;
  diff?: string;
  branchId?: string;    // If promoting a branch, which one
}

export interface MemoryFinding {
  memoryId: string;
  action: 'keep' | 'merge' | 'stale' | 'modify';
  reason: string;
  suggestedContent?: string;
}

export interface PromptSuggestion {
  agentId: string;
  action: 'tweak' | 'keep';
  diff?: string;
  reason: string;
}

export interface TokenFinding {
  toolName: string;
  finding: string;
  recommendation: string;
  estimatedSavings: number;
}

export interface BranchSuggestion {
  currentScore: number;
  branchScore?: number;
  sampleSize: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface EvolutionReport {
  id: string;
  createdAt: string;
  trigger: 'manual' | 'auto' | 'scheduled';
  mode: 'dry-run' | 'apply';

  skillChanges: SkillChange[];
  memoryFindings: MemoryFinding[];
  promptSuggestions: PromptSuggestion[];
  tokenFindings: TokenFinding[];

  summary: {
    totalFindings: number;
    criticalFindings: number;
    estimatedSavingsTokens: number;
  };

  appliedAt?: string;
  rollbackId?: string;
}

export interface AnalyzeOptions {
  mode: 'dry-run' | 'apply';
  skillArchiveDays?: number;    // Days of no use before stale (default: 30)
  scoreThreshold?: number;      // Score below which triggers investigation (default: 2.5)
  promptMinScores?: number;     // Minimum scores before prompt analysis triggers (default: 20)
  confidenceThreshold?: 'high' | 'medium' | 'low'; // Min confidence for branch promotion
}

const DEFAULT_OPTIONS: Required<AnalyzeOptions> = {
  mode: 'dry-run',
  skillArchiveDays: 30,
  scoreThreshold: 2.5,
  promptMinScores: 20,
  confidenceThreshold: 'medium',
};

export class EvolutionEngine {
  private _store: EvolutionStore;
  private _scoreMgr: QualityScoreManager;
  private _stats: StatsCollector;
  private _tagger: SessionTagger;
  private _log = createLogger('anochat.evolution.engine');

  constructor(
    store: EvolutionStore,
    scoreMgr: QualityScoreManager,
    stats: StatsCollector,
    tagger: SessionTagger,
  ) {
    this._store = store;
    this._scoreMgr = scoreMgr;
    this._stats = stats;
    this._tagger = tagger;
  }

  /**
   * Run full analysis and produce an EvolutionReport.
   * @returns EvolutionReport with all findings
   */
  async analyze(options: AnalyzeOptions): Promise<EvolutionReport> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const skillChanges = await this._analyzeSkills(opts);
    const memoryFindings = await this._analyzeMemory(opts);
    const promptSuggestions = await this._analyzePrompts(opts);
    const tokenFindings = this._analyzeTokenUsage();

    const totalFindings = skillChanges.length + memoryFindings.length
      + promptSuggestions.length + tokenFindings.length;
    const criticalFindings = skillChanges.filter(s => s.action === 'archive').length;
    const estimatedSavingsTokens = tokenFindings.reduce((s, f) => s + f.estimatedSavings, 0);

    const report: EvolutionReport = {
      id: `report-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      trigger: options.mode === 'apply' ? 'manual' : 'manual',
      mode: opts.mode,
      skillChanges,
      memoryFindings,
      promptSuggestions,
      tokenFindings,
      summary: {
        totalFindings,
        criticalFindings,
        estimatedSavingsTokens,
      },
    };

    this._log.info('Analysis complete', {
      mode: opts.mode,
      findings: totalFindings,
      critical: criticalFindings,
    });

    return report;
  }

  /**
   * Apply a report's changes. In 'apply' mode, the report was already generated
   * with mode='dry-run' and approved by the user. This stores the applied report
   * with a rollback ID. Actual content changes (skill edits, prompt tweaks) are
   * delegated to the EvolutionManager.
   *
   * @returns true on success
   */
  async applyReport(report: EvolutionReport, sourceMode: 'dry-run' | 'apply'): Promise<boolean> {
    const applied: EvolutionReport = {
      ...report,
      mode: 'apply',
      appliedAt: new Date().toISOString(),
      rollbackId: `rollback-${Date.now().toString(36)}`,
    };

    // Actually apply skill archival actions
    for (const change of report.skillChanges) {
      if (change.action === 'archive') {
        try {
          const skillsDir = path.resolve(process.cwd(), 'skills');
          const archivedDir = path.resolve(process.cwd(), 'skills', '.archived');
          const skillPath = path.join(skillsDir, change.skillId);
          const archivedPath = path.join(archivedDir, change.skillId);
          await fs.mkdir(archivedDir, { recursive: true });
          // Use copy + delete instead of rename to avoid EXDEV on Windows
          // when skillsDir and archivedDir are on different mount points.
          await fs.cp(skillPath, archivedPath, { recursive: true });
          await fs.rm(skillPath, { recursive: true, force: true });
          this._log.info('Skill archived', { skillId: change.skillId });
        } catch (err) {
          this._log.warn('Failed to archive skill', { skillId: change.skillId, error: (err as Error).message });
        }
      }
    }

    // Store applied report for rollback
    await this._store.writeStats(`applied-${applied.id}.json`, applied);
    this._log.info('Report applied', { reportId: applied.id, rollbackId: applied.rollbackId });
    return true;
  }

  // ── Analysis helpers ──

  private async _analyzeSkills(opts: Required<AnalyzeOptions>): Promise<SkillChange[]> {
    const changes: SkillChange[] = [];
    const skillStats = this._stats.getSkillStats();
    const scoreStats = await this._scoreMgr.getStats();
    const now = Date.now();
    const staleMs = opts.skillArchiveDays * 24 * 60 * 60 * 1000;

    for (const [skillId, stat] of Object.entries(skillStats)) {
      const lastUsed = new Date(stat.lastUsedAt).getTime();
      const daysSinceUse = (now - lastUsed) / (24 * 60 * 60 * 1000);

      if (daysSinceUse > opts.skillArchiveDays) {
        changes.push({
          skillId,
          action: 'archive',
          reason: `Not used in ${Math.round(daysSinceUse)} days. ${stat.loadCount} total loads, last used ${new Date(stat.lastUsedAt).toISOString().slice(0, 10)}.`,
        });
        continue;
      }

      // Per-skill score check: flag skill if the owning agent's average is below threshold.
      // We don't have a direct skill→agent mapping, so check all agents with sufficient
      // score samples — if any relevant agent scores low, the skill may need revision.
      const lowAgentScores = Object.entries(scoreStats.byAgent)
        .filter(([_, v]) => v.count >= 3 && v.avg < opts.scoreThreshold);

      if (stat.loadCount > 10 && lowAgentScores.length > 0) {
        const worstAgent = lowAgentScores.reduce((a, b) => a[1].avg < b[1].avg ? a : b);
        changes.push({
          skillId,
          action: 'promote_branch',
          reason: `Agent "${worstAgent[0]}" score ${worstAgent[1].avg.toFixed(1)} is below threshold ${opts.scoreThreshold}. ${stat.loadCount} loads. Consider revision.`,
        });
      }
    }

    return changes;
  }

  private async _analyzeMemory(opts: Required<AnalyzeOptions>): Promise<MemoryFinding[]> {
    const findings: MemoryFinding[] = [];
    const memStats = this._stats.getMemoryStats();
    const now = Date.now();
    const staleMs = 30 * 24 * 60 * 60 * 1000;

    for (const [memId, stat] of Object.entries(memStats)) {
      // Low click-through rate — memory is retrieved but not used
      if (stat.retrievalCount >= 5 && stat.clickThroughRate < 0.3) {
        findings.push({
          memoryId: memId,
          action: 'stale',
          reason: `Low click-through rate (${(stat.clickThroughRate * 100).toFixed(0)}%). Retrieved ${stat.retrievalCount}× but only clicked ${stat.clickThroughCount}×.`,
        });
        continue;
      }

      // Not retrieved in a long time
      const lastRetrieved = new Date(stat.lastRetrievedAt).getTime();
      if (now - lastRetrieved > staleMs && stat.retrievalCount > 0) {
        findings.push({
          memoryId: memId,
          action: 'stale',
          reason: `Not retrieved in ${Math.round((now - lastRetrieved) / (24 * 60 * 60 * 1000))} days.`,
        });
      }
    }

    return findings;
  }

  private async _analyzePrompts(opts: Required<AnalyzeOptions>): Promise<PromptSuggestion[]> {
    const suggestions: PromptSuggestion[] = [];
    const scoreStats = await this._scoreMgr.getStats();

    for (const [agentId, stat] of Object.entries(scoreStats.byAgent)) {
      if (stat.count < opts.promptMinScores) continue;

      if (stat.avg < opts.scoreThreshold) {
        suggestions.push({
          agentId,
          action: 'tweak',
          reason: `Average score ${stat.avg.toFixed(1)} across ${stat.count} ratings is below threshold ${opts.scoreThreshold}. Review agent prompt for clarity or correctness issues.`,
        });
      }
    }

    return suggestions;
  }

  private _analyzeTokenUsage(): TokenFinding[] {
    const findings: TokenFinding[] = [];
    const toolStats = this._stats.getToolStats();

    for (const [toolName, stat] of Object.entries(toolStats)) {
      if (stat.callCount < 5) continue; // Not enough data

      // Detect high token usage patterns
      if (stat.avgTokens > 2000) {
        findings.push({
          toolName,
          finding: `High token usage (avg ${stat.avgTokens.toFixed(0)} tokens, ${stat.callCount} calls).`,
          recommendation: `Consider limiting output size or using pagination for ${toolName}.`,
          estimatedSavings: Math.round(stat.avgTokens * stat.callCount * 0.3),
        });
      }
    }

    return findings;
  }
}
