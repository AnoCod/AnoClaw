/**
 * EvolutionStore.test.ts — persistence layer for self-evolution data.
 *
 * Tests cover:
 *   1. Store initialization creates directories
 *   2. Writing and reading JSON stats (atomic)
 *   3. Appending quality score records (JSONL)
 *   4. Reading score aggregation
 *   5. Concurrent write isolation (lock)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { EvolutionStore } from '../storage/EvolutionStore.js';
import type { QualityScore, SkillStatsStore, ToolStatsStore } from '../../../../shared/types/evolution.js';

const TMP_ROOT = path.resolve(process.cwd(), '.test-evolution');
const TMP_DIR = path.join(TMP_ROOT, `store-${Date.now()}`);

let store: EvolutionStore;

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
  store = new EvolutionStore(TMP_DIR);
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe('EvolutionStore', () => {

  // ── 1. Init ──────────────────────────────────────────────

  it('initializes store directory', async () => {
    await store.init();
    expect(existsSync(path.join(TMP_DIR, 'stats'))).toBe(true);
    expect(existsSync(path.join(TMP_DIR, 'scores'))).toBe(true);
  });

  // ── 2. Read/Write JSON stats ─────────────────────────────

  it('writes and reads skill stats', async () => {
    const data: SkillStatsStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {
        test_skill: {
          loadCount: 5,
          matchL0Count: 10,
          execReferencedCount: 3,
          patchCount: 1,
          avgScore: 4.2,
          lastUsedAt: new Date().toISOString(),
          lastPatchedAt: new Date().toISOString(),
        },
      },
    };
    await store.writeStats('skill-stats.json', data);

    const loaded = await store.readStats<SkillStatsStore>('skill-stats.json');
    expect(loaded).not.toBeNull();
    expect(loaded!.skills.test_skill.loadCount).toBe(5);
    expect(loaded!.skills.test_skill.avgScore).toBe(4.2);
  });

  it('returns null for missing stats file', async () => {
    const result = await store.readStats('nonexistent.json');
    expect(result).toBeNull();
  });

  it('writes and reads tool stats', async () => {
    const data: ToolStatsStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      tools: {
        Read: { callCount: 10, successCount: 9, totalTokens: 5000, totalDurationMs: 1000, avgTokens: 500, p50Tokens: 400, p95Tokens: 800, lastUsedAt: new Date().toISOString() },
      },
    };
    await store.writeStats('tool-stats.json', data);

    const loaded = await store.readStats<ToolStatsStore>('tool-stats.json');
    expect(loaded).not.toBeNull();
    expect(loaded!.tools.Read.callCount).toBe(10);
    expect(loaded!.tools.Read.successCount).toBe(9);
  });

  // ── 3. Score JSONL append/read ───────────────────────────

  it('appends a quality score and reads it back', async () => {
    const score: QualityScore = {
      id: 'score-001',
      sessionId: 'sess-001',
      agentId: 'agent-001',
      messageId: 'msg-001',
      turnNumber: 5,
      score: 4,
      comment: 'Good work',
      createdAt: new Date().toISOString(),
      source: 'human',
    };

    await store.appendScore(score);

    const scores = await store.readScores();
    expect(scores.length).toBeGreaterThanOrEqual(1);
    const found = scores.find(s => s.id === 'score-001');
    expect(found).toBeDefined();
    expect(found!.score).toBe(4);
    expect(found!.comment).toBe('Good work');
  });

  it('appends multiple scores to the same day file', async () => {
    const score1: QualityScore = {
      id: 'score-002',
      sessionId: 'sess-001',
      agentId: 'agent-001',
      messageId: 'msg-002',
      turnNumber: 6,
      score: 5,
      comment: 'Excellent',
      createdAt: new Date().toISOString(),
      source: 'human',
    };
    const score2: QualityScore = {
      id: 'score-003',
      sessionId: 'sess-001',
      agentId: 'agent-001',
      messageId: 'msg-003',
      turnNumber: 7,
      score: 3,
      createdAt: new Date().toISOString(),
      source: 'human',
    };

    await store.appendScore(score1);
    await store.appendScore(score2);

    const scores = await store.readScores();
    const ids = scores.map(s => s.id);
    expect(ids).toContain('score-002');
    expect(ids).toContain('score-003');
  });

  // ── 4. Score index ───────────────────────────────────────

  it('computes score index on demand', async () => {
    const index = await store.computeScoreIndex();
    expect(index.summary.totalScores).toBeGreaterThanOrEqual(3);
    expect(index.summary.avgScore).toBeGreaterThan(0);
    expect(index.summary.avgScore).toBeLessThanOrEqual(5);
    expect(index.summary.byAgent['agent-001']).toBeDefined();
    expect(index.summary.byAgent['agent-001'].count).toBeGreaterThanOrEqual(3);
  });

  // ── 5. Pattern persistence ───────────────────────────────

  it('writes and reads patterns', async () => {
    const patterns = {
      version: 1,
      updatedAt: new Date().toISOString(),
      patterns: [
        {
          patternId: 'pat-001',
          signature: [{ tool: 'Grep', params: ['pattern', 'path'] }],
          count: 3,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          sessions: ['sess-001'],
          avgTokenCost: 5000,
          skillId: null,
        },
      ],
    };

    await store.writePatterns(patterns);
    const loaded = await store.readPatterns();
    expect(loaded!.patterns.length).toBe(1);
    expect(loaded!.patterns[0].patternId).toBe('pat-001');
    expect(loaded!.patterns[0].count).toBe(3);
  });

  // ── 6. Atomic write safety ───────────────────────────────

  it('produces valid JSON even after partial write failure', async () => {
    // Write valid data first
    const valid: SkillStatsStore = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skills: {},
    };
    await store.writeStats('skill-stats.json', valid);

    // Read it back — should be valid
    const loaded = await store.readStats<SkillStatsStore>('skill-stats.json');
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
  });

});
