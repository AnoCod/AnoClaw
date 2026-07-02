/**
 * EvolutionStore — persistent storage for self-evolution system data.
 *
 * Uses atomic file operations and a write-lock pattern (same approach
 * as MemoryStore). JSON stats are written atomically via temp+rename;
 * quality scores are append-only JSONL sharded by day.
 *
 * File layout:
 *   data/evolution/
 *     stats/
 *       skill-stats.json, memory-stats.json, tool-stats.json
 *       patterns.json
 *     scores/
 *       YYYY-MM-DD.jsonl   (daily sharded quality scores)
 *       index.json         (aggregated summary)
 *
 * @module EvolutionStore
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createLogger } from '../../logger.js';
import type {
  QualityScore,
  ScoreIndex,
  SkillStatsStore,
  MemoryStatsStore,
  ToolStatsStore,
  EvolutionPattern,
  PatternStore,
} from '../../../../shared/types/evolution.js';

// ── Helpers ──

/** Write-lock map to serialize concurrent writes to the same file path */
const _writeLocks = new Map<string, Promise<void>>();

async function _withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(filePath) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(r => { release = r; });
  const chainLink = prev.then(() => next);
  _writeLocks.set(filePath, chainLink);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (_writeLocks.get(filePath) === chainLink) {
      _writeLocks.delete(filePath);
    }
  }
}

/** Today's date in YYYY-MM-DD format */
function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── EvolutionStore ──

export class EvolutionStore {
  private _dir: string;
  private _statsDir: string;
  private _scoresDir: string;
  private _initialized = false;

  constructor(dir: string) {
    this._dir = dir;
    this._statsDir = path.join(dir, 'stats');
    this._scoresDir = path.join(dir, 'scores');
  }

  // ── Init ──

  /** Ensure all required directories exist. Idempotent. */
  async init(): Promise<void> {
    if (this._initialized) return;
    mkdirSync(this._statsDir, { recursive: true });
    mkdirSync(this._scoresDir, { recursive: true });
    this._initialized = true;
    createLogger('anochat.evolution').debug('EvolutionStore initialized', { dir: this._dir });
  }

  // ── JSON Stats (atomic write) ──

  /**
   * Write a JSON stats file atomically (write .tmp → rename).
   * @param fileName  e.g. 'skill-stats.json'
   * @param data      Serializable object
   */
  async writeStats(fileName: string, data: unknown): Promise<void> {
    await this.init();
    const filePath = path.join(this._statsDir, fileName);
    await _withLock(filePath, async () => {
      const tmpPath = filePath + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    });
  }

  /**
   * Read a JSON stats file. Returns null if file doesn't exist.
   * @param fileName  e.g. 'skill-stats.json'
   */
  async readStats<T>(fileName: string): Promise<T | null> {
    await this.init();
    const filePath = path.join(this._statsDir, fileName);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  // ── Patterns ──

  async writePatterns(data: PatternStore): Promise<void> {
    return this.writeStats('patterns.json', data);
  }

  async readPatterns(): Promise<PatternStore | null> {
    return this.readStats<PatternStore>('patterns.json');
  }

  // ── Quality Scores (JSONL append, daily sharding) ──

  /**
   * Append a quality score to today's JSONL file.
   */
  async appendScore(score: QualityScore): Promise<void> {
    await this.init();
    const filePath = path.join(this._scoresDir, `${todayStr()}.jsonl`);
    const line = JSON.stringify(score) + '\n';
    await _withLock(filePath, async () => {
      await fs.appendFile(filePath, line, 'utf-8');
    });
  }

  /**
   * Read all quality scores across all daily shards.
   * Optionally filter to a specific date (YYYY-MM-DD).
   */
  async readScores(date?: string): Promise<QualityScore[]> {
    await this.init();
    const scores: QualityScore[] = [];

    let files: string[];
    try {
      files = (await fs.readdir(this._scoresDir))
        .filter(f => f.endsWith('.jsonl'))
        .sort();
    } catch {
      return scores;
    }

    for (const f of files) {
      if (date && f !== `${date}.jsonl`) continue;
      const filePath = path.join(this._scoresDir, f);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        for (const line of raw.split('\n').filter(Boolean)) {
          try {
            scores.push(JSON.parse(line) as QualityScore);
          } catch {
            // skip malformed line
          }
        }
      } catch {
        // skip unreadable file
      }
    }

    return scores;
  }

  /**
   * Compute an aggregated score index from all stored scores.
   * Saves the index to scores/index.json.
   */
  async computeScoreIndex(): Promise<ScoreIndex> {
    const scores = await this.readScores();

    let totalScores = 0;
    let scoreSum = 0;
    const byAgent: Record<string, { count: number; sum: number }> = {};
    const bySession: Record<string, { count: number; sum: number }> = {};

    for (const s of scores) {
      totalScores++;
      scoreSum += s.score;

      if (!byAgent[s.agentId]) byAgent[s.agentId] = { count: 0, sum: 0 };
      byAgent[s.agentId].count++;
      byAgent[s.agentId].sum += s.score;

      if (!bySession[s.sessionId]) bySession[s.sessionId] = { count: 0, sum: 0 };
      bySession[s.sessionId].count++;
      bySession[s.sessionId].sum += s.score;
    }

    const index: ScoreIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      summary: {
        totalScores,
        avgScore: totalScores > 0 ? scoreSum / totalScores : 0,
        byAgent: {},
        bySession: {},
      },
    };

    for (const [aid, v] of Object.entries(byAgent)) {
      index.summary.byAgent[aid] = { count: v.count, avg: v.sum / v.count };
    }
    for (const [sid, v] of Object.entries(bySession)) {
      index.summary.bySession[sid] = { count: v.count, avg: v.sum / v.count };
    }

    // Persist index
    const indexPath = path.join(this._scoresDir, 'index.json');
    await _withLock(indexPath, async () => {
      const tmpPath = indexPath + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
      await fs.rename(tmpPath, indexPath);
    });

    return index;
  }

  /** Read the persisted score index. */
  async readScoreIndex(): Promise<ScoreIndex | null> {
    const indexPath = path.join(this._scoresDir, 'index.json');
    try {
      const raw = await fs.readFile(indexPath, 'utf-8');
      return JSON.parse(raw) as ScoreIndex;
    } catch {
      return null;
    }
  }
}
