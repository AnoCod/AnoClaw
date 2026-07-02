/**
 * PatternDetector.test.ts — M1 repetitive pattern detection
 *
 * Tests cover:
 *   1. Detect repeated tool call sequences
 *   2. Doesn't trigger on single occurrences
 *   3. Merges across multiple sessions
 *   4. Updates existing pattern count
 *   5. Persistence round-trip
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EvolutionStore } from '../storage/EvolutionStore.js';
import { PatternDetector } from '../modules/PatternDetector.js';

const TMP_DIR = path.resolve(process.cwd(), '.test-evolution-pattern');

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe('PatternDetector', () => {

  it('creates a pattern record from tool calls', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const detector = new PatternDetector(store);

    const pattern = await detector.recordToolSequence(
      'sess-001',
      [
        { tool: 'Grep', params: ['pattern:string', 'path:string'] },
        { tool: 'Read', params: ['file_path:string'] },
      ],
      5000,
    );

    expect(pattern).not.toBeNull();
    expect(pattern!.count).toBe(1);
    expect(pattern!.sessions).toContain('sess-001');
  });

  it('increments count on repeated identical sequences', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const detector = new PatternDetector(store);

    const seq = [
      { tool: 'Read', params: ['file_path:string'] },
      { tool: 'Edit', params: ['old_string:string'] },
    ];

    await detector.recordToolSequence('sess-001', seq, 1000);
    const p2 = await detector.recordToolSequence('sess-001', seq, 1200);

    expect(p2!.count).toBe(2);
  });

  it('does not merge different sequences', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const detector = new PatternDetector(store);

    await detector.recordToolSequence('sess-001', [
      { tool: 'Read', params: ['file_path:string'] },
    ], 500);

    const p2 = await detector.recordToolSequence('sess-001', [
      { tool: 'Write', params: ['file_path:string'] },
    ], 500);

    const all = detector.getAllPatterns();
    expect(all.length).toBe(2);
  });

  it('tracks the sessions a pattern appeared in', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const detector = new PatternDetector(store);

    const seq = [{ tool: 'Bash', params: ['command:string'] }];

    await detector.recordToolSequence('sess-A', seq, 500);
    await detector.recordToolSequence('sess-B', seq, 500);

    const patterns = detector.getAllPatterns();
    expect(patterns.length).toBe(1);
    expect(patterns[0].sessions.length).toBe(2);
    expect(patterns[0].sessions).toContain('sess-A');
    expect(patterns[0].sessions).toContain('sess-B');
  });

  it('matches patterns ignoring parameter name order', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();
    const detector = new PatternDetector(store);

    await detector.recordToolSequence('sess-001', [
      { tool: 'Read', params: ['file_path:string'] },
      { tool: 'Edit', params: ['new_string:string', 'old_string:string'] },
    ], 500);

    // Same tools, different param order — should still match
    const p2 = await detector.recordToolSequence('sess-001', [
      { tool: 'Read', params: ['file_path:string'] },
      { tool: 'Edit', params: ['old_string:string', 'new_string:string'] },
    ], 600);

    expect(p2!.count).toBe(2);
  });

  it('persists and reloads patterns', async () => {
    const store = new EvolutionStore(TMP_DIR);
    await store.init();

    const d1 = new PatternDetector(store);
    const seq = [{ tool: 'Glob', params: ['pattern:string'] }];
    await d1.recordToolSequence('sess-P', seq, 300);
    await d1.flush();

    const d2 = new PatternDetector(store);
    await d2.load();
    const patterns = d2.getAllPatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns.some(p => p.signature[0].tool === 'Glob')).toBe(true);
  });

});
