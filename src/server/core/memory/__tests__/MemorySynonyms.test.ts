import { describe, it, expect } from 'vitest';
import { expand } from '../MemorySynonyms.js';

describe('expand — Chinese -> English (cross-language working)', () => {
  it('expands "日志" with English equivalents', async () => {
    const result = await expand('日志');
    expect(result).toContain('log');
    expect(result).toContain('logging');
    expect(result).toContain('journal');
  });

  it('expands "错误" with English equivalents', async () => {
    const result = await expand('错误');
    expect(result).toContain('error');
    expect(result).toContain('bug');
  });

  it('expands "代理" and "工具" in same query', async () => {
    const result = await expand('代理 工具');
    expect(result).toContain('agent');
    expect(result).toContain('tool');
  });

  it('keeps original Chinese query text', async () => {
    const result = await expand('日志');
    expect(result.startsWith('日志 ')).toBe(true);
  });
});

describe('expand — English -> English synonyms only (NO CJK contamination)', () => {
  it('expands "error" with English synonyms but NOT Chinese', async () => {
    const result = await expand('error');
    expect(result).toContain('bug');
    expect(result).toContain('crash');
    // BUG REGRESSION: English queries must NOT get CJK chars (breaks Fuse.js v7)
    expect(result).not.toMatch(/[一-鿿]/);
  });

  it('expands "session" without CJK contamination', async () => {
    const result = await expand('session');
    expect(result).toContain('conversation');
    expect(result).not.toMatch(/[一-鿿]/);
  });

  it('expands "memory" without CJK contamination', async () => {
    const result = await expand('memory');
    expect(result).toContain('remember');
    expect(result).not.toMatch(/[一-鿿]/);
  });

  it('expands "logging" with "log" but NOT Chinese', async () => {
    const result = await expand('logging');
    expect(result).toContain('log');
    expect(result).not.toMatch(/[一-鿿]/);
  });

  it('multiple English tokens expanded without CJK', async () => {
    const result = await expand('error session');
    expect(result).toContain('bug');
    expect(result).toContain('conversation');
    expect(result).not.toMatch(/[一-鿿]/);
  });
});

describe('expand — edge cases', () => {
  it('returns empty string unchanged', async () => {
    expect(await expand('')).toBe('');
  });

  it('returns whitespace-only unchanged', async () => {
    expect(await expand('   ')).toBe('   ');
  });

  it('unknown word returned as-is', async () => {
    expect(await expand('xyznonexistent123')).toBe('xyznonexistent123');
  });

  it('handles single-char token (Jieba may split differently)', async () => {
    // 'a' gets tokenized; if Jieba returns ['a'], it goes through
    // the loop but SYNONYM_MAP['a'] is undefined, so query returned as-is
    const result = await expand('a');
    // After Jieba: tokens=['a'], no synonym match, returned as-is
    expect(typeof result).toBe('string');
  });

  it('case-insensitive token lookup', async () => {
    const result = await expand('ERROR');
    expect(result).toContain('bug');
    expect(result).not.toMatch(/[一-鿿]/);
  });

  it('handles very long query without blowing up', async () => {
    const long = 'error session memory agent tool '.repeat(50);
    const result = await expand(long);
    expect(result.length).toBeGreaterThan(long.length);
  });

  it('handles query with mixed CJK+ASCII — CJK expansions allowed', async () => {
    const result = await expand('错误 error');
    expect(result).toContain('bug');
    // CJK from the '错误' expansion is allowed because query has CJK
    // (it's the query itself that has CJK, expansions can include anything)
  });

  it('Jieba tokenizes compound Chinese words correctly', async () => {
    // "配置" should be found as a single token by Jieba, not split
    const result = await expand('配置');
    expect(result).toContain('config');
    expect(result).toContain('settings');
  });
});

describe('expand — concurrent calls', () => {
  it('concurrent expansions are independent (no shared mutable state)', async () => {
    const results = await Promise.all(['error', 'session', 'memory', 'agent'].map(q => expand(q)));
    for (const r of results) {
      expect(r).not.toMatch(/[一-鿿]/);
    }
  });

  it('concurrent mixed CJK+ASCII expansions produce correct results', async () => {
    const [r1, r2, r3] = await Promise.all([expand('会话'), expand('session'), expand('tcp')]);
    // r1 (CJK) should get English, r2 (English) should NOT get CJK, r3 unchanged
    expect(r1).toContain('conversation');
    expect(r2).not.toMatch(/[一-鿿]/);
    expect(r3).toBe('tcp');
  });
});

describe('expand — Jieba-specific tokenization', () => {
  it('Jieba correctly splits mixed CJK+ASCII query', async () => {
    // Jieba should tokenize "日志配置nginx" → ["日志", "配置", "nginx"]
    // and expand both "日志" and "配置"
    const result = await expand('日志配置nginx');
    expect(result).toContain('logging');
    expect(result).toContain('config');
  });

  it('Jieba preserves original Chinese tokens in query', async () => {
    const result = await expand('前端');
    expect(result).toContain('frontend');
    expect(result).toContain('ui');
    expect(result).toContain('browser');
  });
});
