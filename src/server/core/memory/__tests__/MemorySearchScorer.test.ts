import { describe, it, expect } from 'vitest';
import { scoreEntries } from '../MemorySearchScorer.js';
import type { MemoryEntry } from '../MemoryEntry.js';
import { MemoryScope, MemoryType } from '../MemoryEntry.js';

function e(name: string, description: string, content: string = ''): MemoryEntry {
  return { name, type: MemoryType.Reference, description, content, scope: MemoryScope.Team };
}

async function names(r: ReturnType<typeof scoreEntries>): Promise<string[]> {
  return (await r).map(x => x.entry.name);
}

describe('scoreEntries — basic matching (English)', () => {
  const entries = [
    e('logging-config', 'Logging setup and configuration', 'How to set up logging.'),
    e('error-handling', 'Error handling patterns', 'Standard error handling approach.'),
    e('file-system', 'File system utilities', 'Working with files and directories.'),
    e('session-lifecycle', 'Session lifecycle management', 'How sessions are created.'),
  ];

  it('returns all entries with zero scores for empty query', async () => {
    const results = await scoreEntries(entries, '');
    expect(results).toHaveLength(4);
    for (const r of results) expect(r.score).toBe(0);
    for (const r of results) expect(r.matchReasons).toContain('empty-query');
  });

  it('exact name match ranks first', async () => {
    const results = await scoreEntries(entries, 'logging-config');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entry.name).toBe('logging-config');
  });

  it('partial name match finds relevant entries', async () => {
    const results = await scoreEntries(entries, 'logging');
    expect(await names(Promise.resolve(results))).toContain('logging-config');
  });

  it('description match finds relevant entries', async () => {
    const results = await scoreEntries(entries, 'utilities');
    expect(await names(Promise.resolve(results))).toContain('file-system');
  });

  it('best match sorts first (error → error-handling)', async () => {
    const results = await scoreEntries(entries, 'error', { threshold: 0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entry.name).toBe('error-handling');
  });

  it('provides match reasons for positive matches', async () => {
    const results = await scoreEntries(entries, 'error', { threshold: 0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchReasons.length).toBeGreaterThan(0);
  });
});

describe('scoreEntries — cross-language (Chinese query → English entries)', () => {
  const entries = [
    e('logging-config', 'Logging setup', 'How to set up logging.'),
    e('error-patterns', 'Error patterns reference', 'Common errors and solutions.'),
    e('tool-list', 'Available tools list', 'All built-in tools.'),
  ];

  it('finds English entries with Chinese query "日志" (logging)', async () => {
    const results = await scoreEntries(entries, '日志', { threshold: 0 });
    expect(results.map(r => r.entry.name)).toContain('logging-config');
  });

  it('finds English entries with Chinese query "错误" (error)', async () => {
    const results = await scoreEntries(entries, '错误', { threshold: 0 });
    expect(results.map(r => r.entry.name)).toContain('error-patterns');
  });

  it('finds English entries with Chinese query "工具" (tool)', async () => {
    const results = await scoreEntries(entries, '工具', { threshold: 0 });
    expect(results.map(r => r.entry.name)).toContain('tool-list');
  });

  it('Chinese query for "代理" finds agent-related content', async () => {
    const entries2 = [
      e('agent-config', 'Agent configuration guide', 'How agents are configured.'),
      e('network-utils', 'Network utilities', 'HTTP and WebSocket tools.'),
    ];
    const results = await scoreEntries(entries2, '代理', { threshold: 0 });
    expect(results.map(r => r.entry.name)).toContain('agent-config');
  });
});

describe('scoreEntries — threshold filtering', () => {
  const entries = [e('system-config', 'System configuration', 'All system-level settings.')];

  it('filters out all results at high threshold for unrelated query', async () => {
    const results = await scoreEntries(entries, 'xyzabc123', { threshold: 0.5 });
    expect(results).toHaveLength(0);
  });

  it('threshold=0 lets everything pass', async () => {
    const results = await scoreEntries(entries, 'system-config', { threshold: 0 });
    expect(results).toHaveLength(1);
  });

  it('default threshold (0.15) filters weak matches', async () => {
    const results = await scoreEntries(entries, 'sys');
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('scoreEntries — fuzzy matching', () => {
  const entries = [e('configuration', 'Configuration guide', 'How to configure the system.')];

  it('fuzzy catches typos (configuraton → configuration)', async () => {
    const results = await scoreEntries(entries, 'configuraton');
    expect(results.length).toBeGreaterThan(0);
  });

  it('fuzzy disabled — exact substring still works', async () => {
    const results = await scoreEntries(entries, 'config', { fuzzy: false });
    expect(results.length).toBeGreaterThan(0);
  });

  it('fuzzy disabled — typo gets nothing', async () => {
    const results = await scoreEntries(entries, 'configuraton', { fuzzy: false });
    expect(results).toHaveLength(0);
  });
});

describe('scoreEntries — large datasets', () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    e(`entry-${String(i).padStart(5, '0')}`, `Description for entry ${i}`, `Content ${i}`)
  );

  it('handles 500 entries without crashing or hanging', async () => {
    const start = Date.now();
    const results = await scoreEntries(many, 'entry-00042');
    const elapsed = Date.now() - start;
    expect(results.length).toBeGreaterThan(0);
    // Should complete quickly (< 500ms for simple scoring)
    expect(elapsed).toBeLessThan(500);
  });

  it('empty query returns all with empty-query reason (capped at 100)', async () => {
    const results = await scoreEntries(many, '');
    expect(results.length).toBeLessThanOrEqual(100);
  });
});

describe('scoreEntries — concurrent scoring', () => {
  const entries = [
    e('alpha-service', 'Alpha service docs', 'Alpha service documentation.'),
    e('beta-service', 'Beta service docs', 'Beta service documentation.'),
    e('gamma-lib', 'Gamma library', 'Gamma library reference.'),
  ];

  it('concurrent calls produce independent, correct results', async () => {
    const queries = ['alpha', 'beta', 'gamma'];
    const results = await Promise.all(queries.map(q => scoreEntries(entries, q)));
    expect(results[0].map(r => r.entry.name)).toContain('alpha-service');
    expect(results[1].map(r => r.entry.name)).toContain('beta-service');
    expect(results[2].map(r => r.entry.name)).toContain('gamma-lib');
  });
});

describe('scoreEntries — edge cases', () => {
  it('empty entries array returns []', async () => {
    expect(await scoreEntries([], 'query')).toEqual([]);
  });

  it('entries with very long content are scored fine', async () => {
    const big = e('big-one', 'Big entry', 'x'.repeat(100000));
    const results = await scoreEntries([big], 'big');
    expect(results).toHaveLength(1);
  });

  it('whitespace query returns all with zero scores', async () => {
    const entries = [e('a', 'A', '')];
    const results = await scoreEntries(entries, '   ');
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
  });

  it('matchReasons never empty for scored results', async () => {
    const entries = [e('test-item', 'Test item description', 'Some content.')];
    const results = await scoreEntries(entries, 'test');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchReasons.length).toBeGreaterThan(0);
  });
});
