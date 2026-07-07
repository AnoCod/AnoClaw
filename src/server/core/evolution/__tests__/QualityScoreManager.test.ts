/**
 * QualityScoreManager.test.ts — M5 quality scoring backend
 *
 * Tests cover:
 *   1. Save a score and verify it persists
 *   2. Compute average score for an agent
 *   3. Update existing score on same messageId
 *   4. Retrieve scores for a session
 *   5. Evict old scores beyond max count
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EvolutionStore } from '../storage/EvolutionStore.js';
import { QualityScoreManager } from '../modules/QualityScoreManager.js';
import type { QualityScore } from '../../../../shared/types/evolution.js';

const TMP_DIR = path.resolve(process.cwd(), '.test-evolution-score');
let store: EvolutionStore;
let manager: QualityScoreManager;

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
  store = new EvolutionStore(TMP_DIR);
  await store.init();
  manager = new QualityScoreManager(store);
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  // Clean scores between tests
  const scoresDir = path.join(TMP_DIR, 'scores');
  await fs.rm(scoresDir, { recursive: true, force: true });
  await fs.mkdir(scoresDir, { recursive: true });
  manager = new QualityScoreManager(store);
});

function makeScore(overrides: Partial<QualityScore> = {}): QualityScore {
  return {
    id: `score-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: 'sess-001',
    agentId: 'agent-001',
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    turnNumber: 1,
    score: 4,
    createdAt: new Date().toISOString(),
    source: 'human',
    ...overrides,
  };
}

describe('QualityScoreManager', () => {

  it('saves a score and retrieves it', async () => {
    const saved = await manager.saveScore(makeScore({ score: 5 }));
    expect(saved.id).toBeTruthy();

    const all = await manager.getRecentScores();
    expect(all.length).toBe(1);
    expect(all[0].score).toBe(5);
  });

  it('computes average score for an agent', async () => {
    await manager.saveScore(makeScore({ agentId: 'agent-001', score: 4 }));
    await manager.saveScore(makeScore({ agentId: 'agent-001', score: 5 }));
    await manager.saveScore(makeScore({ agentId: 'agent-001', score: 3 }));

    const avg = await manager.getAgentAverage('agent-001');
    expect(avg).toBeCloseTo(4.0, 1);
  });

  it('computes average for a specific session', async () => {
    await manager.saveScore(makeScore({ sessionId: 'sess-X', score: 5 }));
    await manager.saveScore(makeScore({ sessionId: 'sess-X', score: 3 }));
    await manager.saveScore(makeScore({ sessionId: 'sess-Y', score: 1 }));

    const avg = await manager.getSessionAverage('sess-X');
    expect(avg).toBeCloseTo(4.0, 1);
  });

  it('update an existing score (same messageId, agentId, sessionId)', async () => {
    const msgId = `msg-update-${Date.now()}`;
    const saved = await manager.saveScore(makeScore({
      messageId: msgId, sessionId: 'sess-U', agentId: 'agent-U', score: 2,
    }));

    const updated = await manager.saveScore(makeScore({
      id: saved.id, messageId: msgId, sessionId: 'sess-U', agentId: 'agent-U', score: 5,
    }));

    const all = await manager.getSessionScores('sess-U');
    expect(all.length).toBe(1);
    expect(all[0].score).toBe(5);
  });

  it('gets all scores for a session', async () => {
    await manager.saveScore(makeScore({ sessionId: 'sess-L', turnNumber: 1 }));
    await manager.saveScore(makeScore({ sessionId: 'sess-L', turnNumber: 2 }));
    await manager.saveScore(makeScore({ sessionId: 'sess-OTHER', turnNumber: 1 }));

    const sessScores = await manager.getSessionScores('sess-L');
    expect(sessScores.length).toBe(2);
  });

  it('returns empty array when no scores exist', async () => {
    const all = await manager.getSessionScores('nonexistent');
    expect(all).toEqual([]);
  });

  it('provides score stats summary', async () => {
    await manager.saveScore(makeScore({
      agentId: 'agent-A', sessionId: 'sess-A', score: 5,
    }));
    await manager.saveScore(makeScore({
      agentId: 'agent-A', sessionId: 'sess-A', score: 3,
    }));
    await manager.saveScore(makeScore({
      agentId: 'agent-B', sessionId: 'sess-B', score: 4,
    }));

    const stats = await manager.getStats();
    expect(stats.totalScores).toBe(3);
    expect(stats.globalAvg).toBeCloseTo(4.0, 1);
    expect(stats.byAgent['agent-A'].avg).toBeCloseTo(4.0, 1);
    expect(stats.byAgent['agent-B'].avg).toBeCloseTo(4.0, 1);
  });

});
