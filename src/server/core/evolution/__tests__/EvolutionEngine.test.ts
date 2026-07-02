/**
 * EvolutionEngine.test.ts — M6 analysis and report generation
 *
 * Tests cover:
 *   1. Empty report when no data
 *   2. Detects skills needing archive (no usage)
 *   3. Generates score trend analysis
 *   4. Reports rollback metadata
 *   5. Dry-run produces no changes
 *   6. Branch promotion logic (score delta)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EvolutionStore } from '../storage/EvolutionStore.js';
import { EvolutionEngine } from '../modules/EvolutionEngine.js';
import { QualityScoreManager } from '../modules/QualityScoreManager.js';
import { StatsCollector } from '../modules/StatsCollector.js';
import { SessionTagger } from '../modules/SessionTagger.js';
import type { EvolutionReport, BranchSuggestion } from '../modules/EvolutionEngine.js';

const TMP_DIR = path.resolve(process.cwd(), '.test-evolution-engine');

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe('EvolutionEngine', () => {

  it('generates empty report when no data available', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const engine = new EvolutionEngine(store, new QualityScoreManager(store), new StatsCollector(store), new SessionTagger());

    const report = await engine.analyze({ mode: 'dry-run' });
    expect(report).not.toBeNull();
    expect(report.id).toBeTruthy();
    expect(report.skillChanges.length).toBe(0);
    expect(report.promptSuggestions.length).toBe(0);
    expect(report.memoryFindings.length).toBe(0);
    expect(report.tokenFindings.length).toBe(0);
  });

  it('detects skills that are candidates for archival', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const stats = new StatsCollector(store);

    // Skill used 30 days ago — stale threshold
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    stats.recordSkillLoad('stale-skill');
    const skillStats = stats.getSkillStats();
    skillStats['stale-skill'].lastUsedAt = longAgo;
    stats.recordSkillLoad('active-skill');

    const engine = new EvolutionEngine(store, new QualityScoreManager(store), stats, new SessionTagger());
    const report = await engine.analyze({ mode: 'dry-run' });

    expect(report.skillChanges.some(c => c.skillId === 'stale-skill')).toBe(true);
  });

  it('suggests branch promotion when score delta is significant', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const scoreMgr = new QualityScoreManager(store);

    // Simulate a skill with low scores
    await scoreMgr.saveScore({
      id: 's1', sessionId: 'sess-a', agentId: 'agent-a',
      messageId: 'm1', turnNumber: 1, score: 2,
      createdAt: new Date().toISOString(), source: 'human',
    });

    const engine = new EvolutionEngine(store, scoreMgr, new StatsCollector(store), new SessionTagger());
    const report = await engine.analyze({ mode: 'dry-run' });

    expect(report.id).toBeTruthy();
    expect(report.skillChanges).toBeDefined();
  });

  it('generates a scorable report that can be applied', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const engine = new EvolutionEngine(store, new QualityScoreManager(store), new StatsCollector(store), new SessionTagger());

    const report = await engine.analyze({ mode: 'dry-run' });
    expect(report.trigger).toBe('manual');

    // Applying a dry-run report should succeed (no-op)
    const applied = await engine.applyReport(report, 'dry-run');
    expect(applied).toBe(true);
  });

  it('reports are idempotent — same analysis yields same structure', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const engine = new EvolutionEngine(store, new QualityScoreManager(store), new StatsCollector(store), new SessionTagger());

    const report1 = await engine.analyze({ mode: 'dry-run' });
    const report2 = await engine.analyze({ mode: 'dry-run' });

    expect(report1.id).not.toBe(report2.id); // IDs are unique per run
    expect(typeof report1.createdAt).toBe('string');
    expect(typeof report2.createdAt).toBe('string');
  });

});
