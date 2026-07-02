import { describe, it, expect } from 'vitest';
import {
  detectContentType,
  compressToolOutput,
  ContentType,
} from '../ContentAwareCompressor.js';

// ══════════════════════════════════════════════════════════════
// Content type detection
// ══════════════════════════════════════════════════════════════

describe('detectContentType', () => {
  it('detects JSON arrays', () => {
    const json = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i, name: `item-${i}` })));
    expect(detectContentType(json)).toBe(ContentType.JsonOutput);
  });

  it('detects JSON objects', () => {
    // Build an object big enough to pass the 100-char threshold
    const obj: Record<string, number> = {};
    for (let i = 0; i < 15; i++) obj[`prop_${i}`] = i;
    const json = JSON.stringify(obj);
    expect(json.length).toBeGreaterThan(100);
    expect(detectContentType(json)).toBe(ContentType.JsonOutput);
  });

  it('detects git diff output', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc1234..def5678 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,20 +1,25 @@',
      ' context line 1',
      ' context line 2',
      '-old line',
      '+new line',
      ' context line 3',
      ' context line 4',
      '@@ -30,10 +35,12 @@',
      ' more context',
      '-another old',
      '+another new',
      ' trailing context',
    ].join('\n');
    expect(detectContentType(diff)).toBe(ContentType.GitDiff);
  });

  it('detects search/grep output', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`src/server/core/agent/AgentLoop.ts:${100 + i}:  some matching content here for line ${i}`);
    }
    expect(detectContentType(lines.join('\n'))).toBe(ContentType.SearchResults);
  });

  it('detects build output by log levels', () => {
    const lines: string[] = [];
    lines.push('INFO: Starting compilation...');
    lines.push('INFO: Processing module A');
    lines.push('WARNING: Deprecated API used');
    lines.push('INFO: Processing module B');
    lines.push('ERROR: Compilation failed in module X');
    lines.push('INFO: Retrying...');
    lines.push('INFO: Processing module C');
    lines.push('INFO: Build completed');
    lines.push('WARNING: Bundle size exceeds limit');
    expect(detectContentType(lines.join('\n'))).toBe(ContentType.BuildOutput);
  });

  it('detects build output by timestamps', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`2025-01-15 12:00:${String(i).padStart(2, '0')} Starting task ${i}`);
    }
    expect(detectContentType(lines.join('\n'))).toBe(ContentType.BuildOutput);
  });

  it('returns PlainText for short content', () => {
    expect(detectContentType('hello world')).toBe(ContentType.PlainText);
  });

  it('returns PlainText for ambiguous content', () => {
    const text = Array.from({ length: 10 }, (_, i) => `This is line ${i} of some prose text.`).join('\n');
    expect(detectContentType(text)).toBe(ContentType.PlainText);
  });

  it('returns PlainText for very short content', () => {
    const short = 'ok\ndone';
    expect(detectContentType(short)).toBe(ContentType.PlainText);
  });
});

// ══════════════════════════════════════════════════════════════
// Build output compression
// ══════════════════════════════════════════════════════════════

describe('compressToolOutput — build output', () => {
  it('preserves ERROR lines verbatim', () => {
    const log = [
      'INFO: routine check',
      'INFO: another check',
      'ERROR: connection refused on port 5432',
      'INFO: routine check',
      'INFO: routine check',
      'INFO: routine check',
      'INFO: routine check',
      'INFO: routine check',
      'INFO: routine check',
      'INFO: routine check',
    ].join('\n');

    const { output } = compressToolOutput(log);
    expect(output).toContain('ERROR: connection refused on port 5432');
  });

  it('preserves WARNING lines up to 10', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(`WARNING: deprecated call from module-${i}`);
    }
    for (let i = 0; i < 5; i++) {
      lines.push(`INFO: heartbeat ${i}`);
    }

    const { output } = compressToolOutput(lines.join('\n'));
    const warnCount = (output.match(/WARNING/g) || []).length;
    expect(warnCount).toBe(5);
  });

  it('collapses repeated template lines', () => {
    const lines: string[] = [];
    // 3 unique lines
    lines.push('Build started at 2025-01-15');
    lines.push('Node version: v20.0.0');
    lines.push('');
    // 50 repeated heartbeat lines
    for (let i = 0; i < 50; i++) {
      lines.push(`INFO worker-${i % 4} processing job-${i * 100}`);
    }

    const { output, note } = compressToolOutput(lines.join('\n'));
    expect(output).toContain('[T ×');
    expect(output.length).toBeLessThan(lines.join('\n').length);
    expect(note.savingsPct).toBeGreaterThan(0);
  });

  it('compresses a realistic webpack build log', () => {
    const lines: string[] = [];
    lines.push('webpack 5.88.0 compiled successfully in 4523 ms');
    lines.push('');
    for (let i = 0; i < 30; i++) {
      lines.push(`asset bundle.${i}.js ${100 + i * 10} KiB [emitted]`);
    }
    lines.push('');
    for (let i = 0; i < 5; i++) {
      lines.push(`WARNING asset size limit: bundle.${i}.js exceeds 244 KiB`);
    }
    for (let i = 0; i < 10; i++) {
      lines.push(`INFO chunk ${i} compiled`);
    }

    const original = lines.join('\n');
    const { output, note } = compressToolOutput(original);
    expect(output.length).toBeLessThan(original.length);
    // WARNINGs preserved
    expect(output).toContain('WARNING');
    // Templates collapsed for the chunk lines
    expect(output).toContain('[T ×');
    expect(note.savingsPct).toBeGreaterThan(10);
  });

  it('does not collapse different unique messages', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`Unique message number ${i} with distinct content about different topics`);
    }

    const { output } = compressToolOutput(lines.join('\n'));
    // Unique messages should remain — not collapsed
    expect(output).toContain('Unique message number 0');
    expect(output).toContain('Unique message number 19');
  });
});

// ══════════════════════════════════════════════════════════════
// Search results compression
// ══════════════════════════════════════════════════════════════

describe('compressToolOutput — search results', () => {
  it('groups matches by file', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(`src/server/core/agent/AgentLoop.ts:${100 + i}:  AgentLoop iteration ${i}`);
    }
    for (let i = 0; i < 5; i++) {
      lines.push(`src/server/core/tools/ToolRegistry.ts:${50 + i}:  tool registry entry ${i}`);
    }

    const { output } = compressToolOutput(lines.join('\n'));
    expect(output).toContain('src/server/core/agent/AgentLoop.ts');
    expect(output).toContain('src/server/core/tools/ToolRegistry.ts');
  });

  it('limits to 3 matches per file', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`src/lib/utils.ts:${i + 1}:  match on line ${i + 1}`);
    }

    const { output } = compressToolOutput(lines.join('\n'));
    const matchLines = output.split('\n').filter(l => l.startsWith('src/'));
    expect(matchLines.length).toBeLessThanOrEqual(3 + 1); // 3 shown + possibly summary line
    expect(output).toContain('more matches');
  });

  it('handles large multi-file grep output', () => {
    const lines: string[] = [];
    const files = 30;
    for (let f = 0; f < files; f++) {
      for (let i = 0; i < 8; i++) {
        lines.push(`src/module-${f}/file.ts:${i + 1}:  TODO: fix this later`);
      }
    }

    const original = lines.join('\n');
    const { output, note } = compressToolOutput(original);
    expect(output.length).toBeLessThan(original.length);
    // First 20 files shown, rest summarized
    expect(output).toContain('more files');
    expect(note.savingsPct).toBeGreaterThan(30);
  });

  it('passes through unparseable search format', () => {
    const text = 'This is not grep output\nJust some random text\nWith multiple lines\n';
    const repeated = text.repeat(5);
    const { output } = compressToolOutput(repeated);
    // Falls back — just checks it doesn't crash
    expect(output.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Git diff compression
// ══════════════════════════════════════════════════════════════

describe('compressToolOutput — git diff', () => {
  it('preserves all +/- change lines', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index abc1234..def5678 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,10 +1,12 @@',
      ' unchanged context 1',
      ' unchanged context 2',
      '-removed line',
      '+added line',
      ' unchanged context 3',
      ' unchanged context 4',
      ' unchanged context 5',
      ' unchanged context 6',
      ' unchanged context 7',
      ' unchanged context 8',
      ' unchanged context 9',
      ' unchanged context 10',
      '+another added line',
      ' final context',
    ].join('\n');

    const { output } = compressToolOutput(diff);
    expect(output).toContain('-removed line');
    expect(output).toContain('+added line');
    expect(output).toContain('+another added line');
  });

  it('drops large blocks of unchanged context', () => {
    const lines: string[] = [];
    lines.push('diff --git a/src/big.ts b/src/big.ts');
    lines.push('--- a/src/big.ts');
    lines.push('+++ b/src/big.ts');
    lines.push('@@ -1,100 +1,100 @@');
    // 50 context lines
    for (let i = 0; i < 50; i++) lines.push(` context line ${i}`);
    lines.push('-removed important line');
    lines.push('+added important line');
    // 50 more context lines
    for (let i = 0; i < 50; i++) lines.push(` trailing context ${i}`);

    const original = lines.join('\n');
    const { output, note } = compressToolOutput(original);

    expect(output).toContain('-removed important line');
    expect(output).toContain('+added important line');
    expect(output).toContain('context lines dropped');
    expect(output.length).toBeLessThan(original.length);
    expect(note.savingsPct).toBeGreaterThan(0);
  });

  it('preserves hunk headers', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -10,6 +10,8 @@ function foo() {',
      ' context',
      '+new line',
      ' context',
      '@@ -30,4 +32,5 @@ function bar() {',
      ' context',
      '-old stuff',
      '+new stuff',
      ' context',
    ].join('\n');

    const { output } = compressToolOutput(diff);
    expect(output).toContain('@@ -10,6 +10,8 @@');
    expect(output).toContain('@@ -30,4 +32,5 @@');
  });
});

// ══════════════════════════════════════════════════════════════
// JSON output compression
// ══════════════════════════════════════════════════════════════

describe('compressToolOutput — JSON output', () => {
  it('compresses large uniform JSON arrays', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      status: i % 2 === 0 ? 'active' : 'inactive',
      value: Math.random(),
    }));
    const original = JSON.stringify(arr);

    const { output, note } = compressToolOutput(original);

    expect(output.length).toBeLessThan(original.length);
    expect(output).toContain('_rows_omitted');
    expect(output).toContain('_keys');
    expect(note.savingsPct).toBeGreaterThan(50);
  });

  it('compresses large uniform JSON arrays with few keys', () => {
    const arr = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      status: 'ok',
    }));
    const original = JSON.stringify(arr);

    const { output, note } = compressToolOutput(original);

    expect(output.length).toBeLessThan(original.length);
    expect(note.savingsPct).toBeGreaterThan(70);
  });

  it('compresses arrays of primitives', () => {
    const arr = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const original = JSON.stringify(arr);

    const { output, note } = compressToolOutput(original);

    expect(output.length).toBeLessThan(original.length);
    expect(output).toContain('items omitted');
    expect(note.savingsPct).toBeGreaterThan(20);
  });

  it('passes through small JSON arrays', () => {
    const arr = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const original = JSON.stringify(arr);

    const { output } = compressToolOutput(original);

    expect(output).toBe(original);
  });

  it('handles non-uniform object arrays by sampling', () => {
    const arr = Array.from({ length: 30 }, (_, i) => {
      const item: Record<string, unknown> = { id: i };
      if (i % 3 === 0) item.extra = `field-${i}`;
      if (i % 2 === 0) item.another = i * 2;
      return item;
    });
    const original = JSON.stringify(arr);

    const { output, note } = compressToolOutput(original);

    expect(output.length).toBeLessThan(original.length);
    expect(output).toContain('_rows_omitted');
    expect(note.savingsPct).toBeGreaterThan(0);
  });

  it('compresses large JSON objects with many keys', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 50; i++) {
      obj[`key_${i.toString().padStart(3, '0')}`] = i;
    }
    const original = JSON.stringify(obj);

    const { output, note } = compressToolOutput(original);

    expect(output.length).toBeLessThan(original.length);
    expect(output).toContain('_keys_count');
  });

  it('handles invalid JSON gracefully', () => {
    const broken = '{not valid json at all';
    const { output } = compressToolOutput(broken);
    expect(output).toBe(broken);
  });
});

// ══════════════════════════════════════════════════════════════
// Plain text fallback
// ══════════════════════════════════════════════════════════════

describe('compressToolOutput — plain text fallback', () => {
  it('passes through short generic text unchanged', () => {
    const text = 'This is just some normal text that does not match any special format.';
    const { output, note } = compressToolOutput(text.repeat(10));
    expect(output).toBe(text.repeat(10));
    expect(note.savingsPct).toBe(0);
  });

  it('handles empty content gracefully', () => {
    const { output, note } = compressToolOutput('');
    expect(output).toBe('');
    expect(note.savingsPct).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Edge cases & safety
// ══════════════════════════════════════════════════════════════

describe('compressToolOutput — safety', () => {
  it('never returns more content than the original', () => {
    const content = 'short content with no compression possible';
    const { output } = compressToolOutput(content);
    expect(output.length).toBeLessThanOrEqual(content.length);
  });

  it('never throws on any input', () => {
    const inputs = [
      '',
      '\n'.repeat(100),
      Array(100).fill('a').join(''),
      '\x00\x00\x00',
      '😀'.repeat(500),
      '{"broken": json',
    ];

    for (const input of inputs) {
      expect(() => compressToolOutput(input)).not.toThrow();
    }
  });

  it('handles very short content without crashing', () => {
    const { output, note } = compressToolOutput('ok');
    expect(output).toBe('ok');
    expect(note.savingsPct).toBe(0);
  });

  it('runs fast on large inputs', () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`2025-01-15 12:00:${String(i % 60).padStart(2, '0')} INFO worker-${i % 8} processing job-${i}`);
    }
    const content = lines.join('\n');

    const start = Date.now();
    const { output } = compressToolOutput(content);
    const elapsed = Date.now() - start;

    expect(output.length).toBeLessThan(content.length);
    // Should complete in under 30ms for 1000 lines
    expect(elapsed).toBeLessThan(30);
  });
});
