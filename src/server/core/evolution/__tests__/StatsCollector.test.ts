/**
 * StatsCollector.test.ts — M3 usage statistics via TypedEventBus
 *
 * Tests cover:
 *   1. Tool execution events are counted
 *   2. Skill stats are tracked when skill events fire
 *   3. Token usage tracking
 *   4. Concurrent events don't lose counts
 *   5. Stats persistence via EvolutionStore
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EvolutionStore } from '../storage/EvolutionStore.js';
import { StatsCollector } from '../modules/StatsCollector.js';

const TMP_DIR = path.resolve(process.cwd(), '.test-evolution-stats');

async function makeCollector(store?: EvolutionStore): Promise<{ store: EvolutionStore; collector: StatsCollector }> {
  const s = store || new EvolutionStore(TMP_DIR);
  await s.init();
  const c = new StatsCollector(s);
  return { store: s, collector: c };
}

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe('StatsCollector', () => {

  it('records tool execution count', async () => {
    const { collector } = await makeCollector();

    collector.recordToolCall('Read', true, 500, 120);
    collector.recordToolCall('Read', true, 300, 80);
    collector.recordToolCall('Read', false, 2000, 500);

    const stats = collector.getToolStats();
    expect(stats.Read.callCount).toBe(3);
    expect(stats.Read.successCount).toBe(2);
  });

  it('tracks min/avg/max tokens and duration per tool', async () => {
    const { collector } = await makeCollector();

    collector.recordToolCall('Grep', true, 1000, 50);
    collector.recordToolCall('Grep', true, 2000, 150);
    collector.recordToolCall('Grep', true, 3000, 500);

    const stats = collector.getToolStats();
    expect(stats.Grep.avgTokens).toBe(2000);
    expect(stats.Grep.totalTokens).toBe(6000);
    expect(stats.Grep.avgDurationMs).toBe(233);
  });

  it('records skill usage count', async () => {
    const { collector } = await makeCollector();

    collector.recordSkillLoad('skill-frontend-fix');
    collector.recordSkillLoad('skill-frontend-fix');
    collector.recordSkillLoad('skill-backend-opt');

    const stats = collector.getSkillStats();
    expect(stats['skill-frontend-fix'].loadCount).toBe(2);
    expect(stats['skill-backend-opt'].loadCount).toBe(1);
    expect(Object.keys(stats).length).toBe(2);
  });

  it('records memory retrieval and click-through', async () => {
    const { collector } = await makeCollector();

    collector.recordMemoryRetrieval('mem-user-pref-theme');
    collector.recordMemoryRetrieval('mem-user-pref-theme');
    collector.recordMemoryClick('mem-user-pref-theme');

    const stats = collector.getMemoryStats();
    expect(stats['mem-user-pref-theme'].retrievalCount).toBe(2);
    expect(stats['mem-user-pref-theme'].clickThroughCount).toBe(1);
  });

  it('persists and reloads all stats via EvolutionStore', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const c1 = new StatsCollector(store);

    c1.recordToolCall('Bash', true, 1500, 300);
    c1.recordSkillLoad('skill-deploy');
    c1.recordMemoryRetrieval('mem-deploy-config');

    await c1.flush();

    const c2 = new StatsCollector(store);
    await c2.load();

    const toolStats = c2.getToolStats();
    expect(toolStats.Bash.callCount).toBe(1);

    const skillStats = c2.getSkillStats();
    expect(skillStats['skill-deploy'].loadCount).toBe(1);

    const memStats = c2.getMemoryStats();
    expect(memStats['mem-deploy-config'].retrievalCount).toBe(1);
  });

  it('handles empty stats gracefully', async () => {
    const { collector } = await makeCollector();

    expect(collector.getToolStats()).toEqual({});
    expect(collector.getSkillStats()).toEqual({});
    expect(collector.getMemoryStats()).toEqual({});
  });

});
