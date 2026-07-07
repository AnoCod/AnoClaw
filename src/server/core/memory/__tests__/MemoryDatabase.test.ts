import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sql.js before importing MemoryDatabase
vi.mock('sql.js', () => {
  const mockDB = {
    run: vi.fn(),
    exec: vi.fn().mockReturnValue([]),
    prepare: vi.fn(),
    export: vi.fn().mockReturnValue(new Uint8Array()),
    close: vi.fn(),
  };
  return {
    default: vi.fn().mockResolvedValue({
      Database: vi.fn(() => mockDB),
    }),
  };
});

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
}));

import { MemoryDatabase, tokenize } from '../storage/MemoryDatabase.js';

describe('MemoryDatabase', () => {
  let db: MemoryDatabase;

  beforeEach(() => {
    MemoryDatabase.resetInstance();
    db = MemoryDatabase.getInstance({ dbPath: ':memory:', embeddingDim: 384, bm25K1: 1.2, bm25B: 0.75, maxDocuments: 100, autoSaveIntervalMs: 5000 });
  });

  // ── Singleton ────────────────────────────────────────────────

  it('getInstance returns the same instance', () => {
    const a = MemoryDatabase.getInstance();
    const b = MemoryDatabase.getInstance();
    expect(a).toBe(b);
  });

  it('resetInstance clears the singleton', () => {
    const a = MemoryDatabase.getInstance();
    MemoryDatabase.resetInstance();
    const b = MemoryDatabase.getInstance();
    expect(a).not.toBe(b);
  });

  // ── Initial state ────────────────────────────────────────────

  it('isReady is false before initialization', () => {
    expect(db.isReady).toBe(false);
  });

  it('isReady is true after initialization', async () => {
    // Trigger lazy init
    try { await db.getAllDocuments(); } catch { /* mock might fail */ }
    // After init attempt, DB should be open
    expect(db.isReady).toBe(true);
  });

  // ── Config ───────────────────────────────────────────────────

  it('BM25_K1 uses the unified value from constants (1.2)', () => {
    const cfg = (db as any)._config;
    expect(cfg.bm25K1).toBe(1.2);
  });

  it('BM25_B uses the correct value (0.75)', () => {
    const cfg = (db as any)._config;
    expect(cfg.bm25B).toBe(0.75);
  });
});

describe('tokenize', () => {
  it('returns empty array for empty input', async () => {
    const result = await tokenize('');
    expect(result).toEqual([]);
  });

  it('splits English text into lowercase tokens', async () => {
    const result = await tokenize('Hello World Testing');
    expect(result).toContain('hello');
    expect(result).toContain('world');
    expect(result).toContain('testing');
  });

  it('filters tokens shorter than 2 characters', async () => {
    const result = await tokenize('a b c ab cd');
    // 'a', 'b', 'c' should be filtered out
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
    expect(result).not.toContain('c');
    expect(result).toContain('ab');
    expect(result).toContain('cd');
  });

  it('handles punctuation correctly', async () => {
    const result = await tokenize('hello, world! test.');
    expect(result).toEqual(['hello', 'world', 'test']);
  });
});
