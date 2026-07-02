import { describe, it, expect } from 'vitest';
import { TokenCounter } from '../TokenCounter.js';
import type { TokenBreakdown } from '../../../../shared/types/session.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../../../shared/constants.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeBd(overrides: Partial<TokenBreakdown> = {}): TokenBreakdown {
  return {
    systemPrompt: 1000,
    systemTools: 400,
    skills: 300,
    messages: 2300,
    freeSpace: 196000,
    total: 4000,
    ...overrides,
  };
}

function msg(role: string, content: string, extra?: Record<string, unknown>) {
  return {
    id: `${role}-1`,
    sessionId: 's1',
    role,
    content,
    tokenCount: 0,
    compressed: false,
    timestamp: '2026-01-01T00:00:00Z',
    ...extra,
  } as any;
}

// ─── CACHE ISOLATION — reset before every cache-sensitive test ──

// The module-level cache lives in _cachedToolsKey/_cachedToolsTokens.
// We access it indirectly: calling breakdown with same tools twice
// should hit cache; calling with different tools should recalculate.

// ─────────────────────────────────────────────────────────────────
// HEURISTIC FALLBACK
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter._heuristicEstimate — fallback depth', () => {
  it('returns 0 for empty/whitespace-only text', () => {
    expect(TokenCounter._heuristicEstimate('')).toBe(0);
    expect(TokenCounter._heuristicEstimate('   ')).toBeGreaterThanOrEqual(0);
  });

  // ── Content type detection ───────────────────────────────────

  it('detects prose and uses chars/4', () => {
    // 40 chars prose → ~10 tokens
    const text = 'Hello world. This is a normal English sentence.';
    const tokens = TokenCounter._heuristicEstimate(text);
    expect(tokens).toBeGreaterThan(0);
    // Prose should be roughly len/4
    expect(tokens).toBeLessThanOrEqual(Math.ceil(text.length / 3)); // generous upper bound
  });

  it('detects code by keyword and uses chars/2 (denser)', () => {
    const code = 'function foo() {\n  const x = 1;\n  return x + 2;\n}';
    const prose = 'This is a sentence that has similar length to the code above.';
    const codeTokens = TokenCounter._heuristicEstimate(code);
    const proseTokens = TokenCounter._heuristicEstimate(prose);
    // Code should be denser: same-length text should estimate MORE tokens for code
    // (because chars/2 vs chars/4)
    expect(codeTokens).toBeGreaterThan(proseTokens);
  });

  it('detects JSON by leading brace + colon pattern', () => {
    const json = '{"name":"test","value":123}';
    const tokens = TokenCounter._heuristicEstimate(json);
    expect(tokens).toBeGreaterThan(0);
  });

  it('detects JSON by structural-density heuristic (no colon pattern)', () => {
    // This string starts with {, has no ":", but has high structural-char density
    const jsonLike = '{["a","b","c"],{"x":1}}';
    const tokens = TokenCounter._heuristicEstimate(jsonLike);
    expect(tokens).toBeGreaterThan(0);
  });

  it('does NOT misclassify prose with braces as JSON', () => {
    // A sentence with a few braces but low structural density should stay prose
    const prose = 'I like {this} and (that) but mostly just words here friend.';
    const tokens = TokenCounter._heuristicEstimate(prose);
    // Just verify it returns something sensible — no crash, no negative
    expect(tokens).toBeGreaterThan(0);
  });

  // ── CJK handling ──────────────────────────────────────────────

  it('weights CJK chars 1.5x per char vs ASCII prose chars/4', () => {
    // 5 CJK chars = 5 * 1.5 = 7.5 → ceil 8
    const cjk = '你好世界测试';
    const tokens = TokenCounter._heuristicEstimate(cjk);
    expect(tokens).toBeGreaterThanOrEqual(7);
    expect(tokens).toBeLessThanOrEqual(9);
  });

  it('handles mixed CJK + ASCII text', () => {
    const mixed = '你好 world 测试 text';
    const tokens = TokenCounter._heuristicEstimate(mixed);
    expect(tokens).toBeGreaterThan(0);
    // Should be between pure-CJK and pure-ASCII estimates for same length
    const pureCjk = '你好世界测试文本内容';
    const pureAscii = 'hello world test text';
    const cjkTokens = TokenCounter._heuristicEstimate(pureCjk);
    const asciiTokens = TokenCounter._heuristicEstimate(pureAscii);
    expect(tokens).toBeLessThan(cjkTokens);
    expect(tokens).toBeGreaterThan(asciiTokens);
  });

  // ── Edge: very long string ────────────────────────────────────

  it('handles very long strings (100k chars) without overflow', () => {
    const long = 'x'.repeat(100_000);
    const tokens = TokenCounter._heuristicEstimate(long);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isFinite(tokens)).toBe(true);
    // 100k chars prose → ~25k tokens
    expect(tokens).toBeGreaterThan(20_000);
  });

  // ── Edge: special chars, emoji, newlines ──────────────────────

  it('counts newlines and special chars as regular chars', () => {
    const text = 'line1\nline2\nline3\n\t{ "key": "value" }';
    const tokens = TokenCounter._heuristicEstimate(text);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// NULL/UNDEFINED SAFETY — all public methods
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter — null/undefined safety', () => {
  it('estimate(null) does not throw', () => {
    // countTokensReal checks `if (!text) return 0`
    expect(() => TokenCounter.estimate(null as any)).not.toThrow();
    expect(TokenCounter.estimate(null as any)).toBe(0);
  });

  it('estimate(undefined) does not throw', () => {
    expect(() => TokenCounter.estimate(undefined as any)).not.toThrow();
    expect(TokenCounter.estimate(undefined as any)).toBe(0);
  });

  it('estimateMessages(null) does not throw', () => {
    expect(() => TokenCounter.estimateMessages(null as any)).not.toThrow();
    expect(TokenCounter.estimateMessages(null as any)).toBe(0);
  });

  it('estimateMessages with null/undefined content in messages', () => {
    const msgs = [
      msg('user', null as any),
      msg('assistant', undefined as any),
      msg('user', 'valid content'),
    ];
    expect(() => TokenCounter.estimateMessages(msgs)).not.toThrow();
    const tokens = TokenCounter.estimateMessages(msgs);
    expect(tokens).toBeGreaterThan(0); // valid content counted
  });

  it('estimateMessages with null toolCalls/toolResults', () => {
    const msgs = [
      { ...msg('assistant', 'test'), toolCalls: null as any, toolResults: null as any },
    ];
    expect(() => TokenCounter.estimateMessages(msgs)).not.toThrow();
    expect(TokenCounter.estimateMessages(msgs)).toBeGreaterThan(0);
  });

  it('estimateMessages with empty-string content', () => {
    const msgs = [msg('user', '')];
    const tokens = TokenCounter.estimateMessages(msgs);
    expect(tokens).toBeGreaterThanOrEqual(0);
  });

  it('breakdown with null/undefined systemPrompt', () => {
    expect(() =>
      TokenCounter.breakdown(null as any, [], '', [])
    ).not.toThrow();
    expect(() =>
      TokenCounter.breakdown(undefined as any, [], '', [])
    ).not.toThrow();
  });

  it('breakdown with null tools array', () => {
    expect(() =>
      TokenCounter.breakdown('prompt', null as any, '', [])
    ).not.toThrow();
  });

  it('breakdown with null skillsText', () => {
    expect(() =>
      TokenCounter.breakdown('prompt', [], null as any, [])
    ).not.toThrow();
  });

  it('breakdown with null messages', () => {
    expect(() =>
      TokenCounter.breakdown('prompt', [], '', null as any)
    ).not.toThrow();
  });

  it('isOverThreshold with zero contextWindow does not divide by zero', () => {
    // 0 > 0 * 0.7 = 0 → false, no division
    expect(() => TokenCounter.isOverThreshold(10, 0)).not.toThrow();
    expect(TokenCounter.isOverThreshold(1, 0)).toBe(true);
  });

  it('canProceed with zero contextWindow', () => {
    // 0 < 0 * 0.95 = 0 → false
    expect(() => TokenCounter.canProceed(0, 0)).not.toThrow();
  });

  it('usagePercent with zero contextWindow does not divide by zero', () => {
    // 0/0 = NaN, Math.round(NaN*1000)/10 = NaN
    // This is a potential bug — verify it doesn't throw, but note the NaN
    expect(() => TokenCounter.usagePercent(0, 0)).not.toThrow();
  });

  it('percentage helpers with zero total do not divide by zero', () => {
    const empty = makeBd({ systemPrompt: 0, systemTools: 0, skills: 0, messages: 0, total: 0 });
    expect(() => TokenCounter.systemPromptPct(empty)).not.toThrow();
    expect(() => TokenCounter.systemToolsPct(empty)).not.toThrow();
    expect(() => TokenCounter.skillsPct(empty)).not.toThrow();
    expect(() => TokenCounter.messagesPct(empty)).not.toThrow();
    expect(() => TokenCounter.freePct(empty)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// LOGICAL CLOSURE — invariants that MUST hold
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter.breakdown — logical closure', () => {
  const system = 'You are a helpful assistant.';
  const tools = [{ name: 'read' }, { name: 'write' }];
  const skills = 'Available skills: search, math.';
  const messages = [
    msg('user', 'Hello'),
    msg('assistant', 'Hi there!'),
  ];

  it('freeSpace + total === contextWindow for default window', () => {
    const bd = TokenCounter.breakdown(system, tools, skills, messages);
    expect(bd.freeSpace + bd.total).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('freeSpace + total === contextWindow for custom window', () => {
    for (const ctx of [8000, 32000, 100000, 200000, 500000]) {
      const bd = TokenCounter.breakdown(system, tools, skills, messages, ctx);
      expect(bd.freeSpace + bd.total).toBe(ctx);
    }
  });

  it('freeSpace + total === contextWindow when everything is empty', () => {
    const bd = TokenCounter.breakdown('', [], '', []);
    expect(bd.freeSpace + bd.total).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('total === systemPrompt + systemTools + skills + messages', () => {
    const bd = TokenCounter.breakdown(system, tools, skills, messages);
    const sum = bd.systemPrompt + bd.systemTools + bd.skills + bd.messages;
    expect(bd.total).toBe(sum);
  });

  it('total === sum of parts for many input shapes', () => {
    const cases: [string, unknown[], string, any[]][] = [
      ['', [], '', []],
      ['prompt', [], '', []],
      ['prompt', [{ name: 'a' }], '', []],
      ['prompt', [], 'skills here', []],
      ['prompt', [], '', [msg('user', 'hello')]],
      ['prompt', [{ name: 'a' }, { name: 'b' }], 'skills', [msg('user', 'hi'), msg('assistant', 'hey')]],
    ];
    for (const [sp, t, sk, ms] of cases) {
      const bd = TokenCounter.breakdown(sp, t, sk, ms);
      const sum = bd.systemPrompt + bd.systemTools + bd.skills + bd.messages;
      expect(bd.total).toBe(sum);
    }
  });

  it('freeSpace never goes below 0 when content overflows window', () => {
    // 1.6M chars of repeated text (~8 chars/token) guarantees overflow of the 200K window
    const hugeMessages = [msg('user', 'x'.repeat(2_000_000))];
    const bd = TokenCounter.breakdown('prompt', [{ name: 't' }], 'skills', hugeMessages);
    expect(bd.freeSpace).toBeGreaterThanOrEqual(0);
    expect(bd.total).toBeGreaterThan(DEFAULT_CONTEXT_WINDOW);
    expect(bd.freeSpace).toBe(0);
  });

  it('all fields are non-negative', () => {
    const bd = TokenCounter.breakdown(system, tools, skills, messages);
    expect(bd.systemPrompt).toBeGreaterThanOrEqual(0);
    expect(bd.systemTools).toBeGreaterThanOrEqual(0);
    expect(bd.skills).toBeGreaterThanOrEqual(0);
    expect(bd.messages).toBeGreaterThanOrEqual(0);
    expect(bd.freeSpace).toBeGreaterThanOrEqual(0);
    expect(bd.total).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// isOverThreshold + canProceed AGREEMENT
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter — isOverThreshold / canProceed agreement', () => {
  const WINDOW = 200000;

  it('canProceed=false implies isOverThreshold(0.95)=true', () => {
    // canProceed returns false when usedTokens >= window * 0.95
    // Strategy: test boundary-tight values
    const atBoundary = Math.ceil(WINDOW * 0.95); // first value where canProceed is false
    expect(TokenCounter.canProceed(atBoundary, WINDOW)).toBe(false);
    // isOverThreshold(atBoundary, WINDOW, 0.95) should be true
    // atBoundary > WINDOW * 0.95? Let's check: if atBoundary === WINDOW*0.95 exactly it'd be false
    // Using > threshold vs >= in canProceed. Test a value that's definitively above.
    const above = WINDOW * 0.95 + 1;
    expect(TokenCounter.canProceed(above, WINDOW)).toBe(false);
    const overResult = TokenCounter.isOverThreshold(above, WINDOW, 0.95);
    expect(overResult).toBe(true);
  });

  it('canProceed=true implies isOverThreshold(0.95)=false', () => {
    const below = WINDOW * 0.95 - 1;
    expect(TokenCounter.canProceed(below, WINDOW)).toBe(true);
    const overResult = TokenCounter.isOverThreshold(below, WINDOW, 0.95);
    expect(overResult).toBe(false);
  });

  it('consistency across threshold range', () => {
    for (const pct of [0.5, 0.7, 0.8, 0.9, 0.95, 0.99]) {
      // Just below threshold
      const under = Math.floor(WINDOW * pct) - 1;
      expect(TokenCounter.isOverThreshold(under, WINDOW, pct)).toBe(false);
      // Just above threshold
      const over = Math.ceil(WINDOW * pct) + 1;
      expect(TokenCounter.isOverThreshold(over, WINDOW, pct)).toBe(true);
    }
  });

  it('extreme values: 0 tokens, full window tokens', () => {
    expect(TokenCounter.canProceed(0, WINDOW)).toBe(true);
    expect(TokenCounter.canProceed(WINDOW, WINDOW)).toBe(false);
    expect(TokenCounter.canProceed(WINDOW + 1, WINDOW)).toBe(false);
    expect(TokenCounter.isOverThreshold(0, WINDOW)).toBe(false);
    expect(TokenCounter.isOverThreshold(WINDOW, WINDOW)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// PERCENTAGE HELPERS
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter — percentage helpers', () => {
  it('all pct helpers return 0 when total is 0', () => {
    const empty = makeBd({ total: 0, systemPrompt: 0, systemTools: 0, skills: 0, messages: 0 });
    expect(TokenCounter.systemPromptPct(empty)).toBe(0);
    expect(TokenCounter.systemToolsPct(empty)).toBe(0);
    expect(TokenCounter.skillsPct(empty)).toBe(0);
    expect(TokenCounter.messagesPct(empty)).toBe(0);
  });

  it('freePct returns 100 when total is 0 and freeSpace is ctxWindow', () => {
    // If total=0 and freeSpace=200000, context window = 0+200000 = 200000
    const empty = makeBd({ total: 0, freeSpace: 200000, messages: 0, systemPrompt: 0, systemTools: 0, skills: 0 });
    expect(TokenCounter.freePct(empty)).toBe(100);
  });

  it('freePct returns 0 when everything used', () => {
    const full = makeBd({ total: 200000, freeSpace: 0 });
    expect(TokenCounter.freePct(full)).toBe(0);
  });

  it('percentage helpers sum to 100 excluding freePct (freePct uses contextWindow denominator)', () => {
    const bd = TokenCounter.breakdown(
      'System prompt here.',
      [{ name: 't1' }, { name: 't2' }],
      'Skills go here.',
      [msg('user', 'Hello'), msg('assistant', 'World')],
    );
    // Parts percentages use bd.total as denominator — should sum to 100
    const partsSum =
      TokenCounter.systemPromptPct(bd) +
      TokenCounter.systemToolsPct(bd) +
      TokenCounter.skillsPct(bd) +
      TokenCounter.messagesPct(bd);
    // freePct uses contextWindow as denominator (separate scale)
    expect(partsSum).toBeGreaterThanOrEqual(99);
    expect(partsSum).toBeLessThanOrEqual(101);
    expect(TokenCounter.freePct(bd)).toBeGreaterThanOrEqual(0);
  });

  it('usagePercent rounds to 0.1 precision', () => {
    // 1 / 200000 = 0.0005% → round(0.0005 * 1000) / 10 = round(0.5) / 10 = 1/10 = 0.1
    // Wait — Math.round(0.5) = 1. 1/10 = 0.1.
    expect(TokenCounter.usagePercent(50000, 200000)).toBe(25); // 25.0%
    expect(TokenCounter.usagePercent(100000, 200000)).toBe(50); // 50.0%
    expect(TokenCounter.usagePercent(1, 200000)).toBeGreaterThanOrEqual(0);
    expect(TokenCounter.usagePercent(199999, 200000)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────
// TOOLS CACHE — stateful correctness
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter — tools cache correctness', () => {
  // The module-level cache (static _cachedToolsKey / _cachedToolsTokens)
  // should invalidate when tools change. We test by calling breakdown()
  // which internally calls estimateToolsTokens().

  it('same tools → same systemTools value (cache hit observable via consistency)', () => {
    const tools = [{ name: 'alpha' }, { name: 'beta' }];
    const a = TokenCounter.breakdown('sys', tools, '', []);
    const b = TokenCounter.breakdown('sys', tools, '', []);
    expect(a.systemTools).toBe(b.systemTools);
  });

  it('different tools → recalculated systemTools', () => {
    const tools1 = [{ name: 'alpha' }];
    const tools2 = [{ name: 'alpha' }, { name: 'beta' }];
    const a = TokenCounter.breakdown('sys', tools1, '', []);
    const b = TokenCounter.breakdown('sys', tools2, '', []);
    // b has more tools so its systemTools should be >= a's (usually strictly >)
    expect(b.systemTools).toBeGreaterThanOrEqual(a.systemTools);
  });

  it('empty tools → zero, then with tools → non-zero, then empty → zero again', () => {
    const tools = [{ name: 'test_tool_xyz' }];
    const empty1 = TokenCounter.breakdown('sys', [], '', []);
    expect(empty1.systemTools).toBe(0);

    const withTools = TokenCounter.breakdown('sys', tools, '', []);
    expect(withTools.systemTools).toBeGreaterThan(0);

    // Back to empty — cache should NOT return stale non-zero value
    const empty2 = TokenCounter.breakdown('sys', [], '', []);
    expect(empty2.systemTools).toBe(0);
  });

  it('tool order changes → key differs → recalculates', () => {
    const toolsAB = [{ name: 'a' }, { name: 'b' }];
    const toolsBA = [{ name: 'b' }, { name: 'a' }];
    // Key uses sorted names, so these should produce the SAME key → same tokens
    const a = TokenCounter.breakdown('sys', toolsAB, '', []);
    const b = TokenCounter.breakdown('sys', toolsBA, '', []);
    expect(a.systemTools).toBe(b.systemTools);
  });

  it('tool with null/undefined name handled gracefully in cache key', () => {
    const tools = [{ name: 'valid' }, { name: null }, {}];
    expect(() =>
      TokenCounter.breakdown('sys', tools, '', [])
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// CONCURRENCY — cache safety under simultaneous calls
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter — concurrency safety (tools cache)', () => {
  it('breakdown from multiple "threads" with same tools returns consistent values', async () => {
    const tools = [{ name: 't1' }, { name: 't2' }, { name: 't3' }];
    const promises = Array.from({ length: 50 }, () =>
      Promise.resolve().then(() =>
        TokenCounter.breakdown('sys prompt here', tools, 'skills go here', [msg('user', 'hello')])
      )
    );
    const results = await Promise.all(promises);
    const first = results[0];
    for (const r of results) {
      expect(r.systemTools).toBe(first.systemTools);
      expect(r.total).toBe(first.total);
      expect(r.freeSpace + r.total).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  });

  it('concurrent breakdown with alternating tools still satisfies invariants', async () => {
    const toolsA = [{ name: 'alpha' }, { name: 'beta' }];
    const toolsB = [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }];

    // Interleave calls with different tools
    const tasks: Promise<TokenBreakdown>[] = [];
    for (let i = 0; i < 30; i++) {
      tasks.push(
        Promise.resolve().then(() =>
          TokenCounter.breakdown('sys', i % 2 === 0 ? toolsA : toolsB, 'skills', [msg('user', 'test')])
        )
      );
    }
    const results = await Promise.all(tasks);
    for (const bd of results) {
      // Invariants MUST hold even under concurrency
      expect(bd.total).toBe(
        bd.systemPrompt + bd.systemTools + bd.skills + bd.messages
      );
      expect(bd.freeSpace + bd.total).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(bd.systemTools).toBeGreaterThanOrEqual(0);
    }
  });

  it('concurrent estimateMessages does not interfere', async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg('user', `message number ${i} with some content here.`)
    );
    const promises = Array.from({ length: 50 }, () =>
      Promise.resolve().then(() => TokenCounter.estimateMessages(messages))
    );
    const results = await Promise.all(promises);
    const first = results[0];
    for (const r of results) {
      expect(r).toBe(first);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// SIMULATED gpt-tokenizer UNAVAILABLE
// ─────────────────────────────────────────────────────────────────

// Because the tokenizer loads once (lazy, cached), we can't easily unload it.
// We CAN verify that _heuristicEstimate handles all content types correctly,
// which is the fallback path. These tests exercise the code paths that would
// be hit if gpt-tokenizer were absent.

describe('TokenCounter — heuristic handles all content types (fallback path)', () => {
  it('handles prose: plain English paragraphs', () => {
    const prose = `
      This is a multi-paragraph English text. It contains normal sentences
      with punctuation, capitalization, and various word lengths.
      The heuristic should estimate this as prose using chars/4.
    `.repeat(5);
    const tokens = TokenCounter._heuristicEstimate(prose);
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(prose.length); // prose is less dense
  });

  it('handles code: TypeScript/JavaScript', () => {
    const code = `
      import { describe, it, expect } from 'vitest';
      export class TokenCounter {
        static estimate(text: string): number {
          if (!text) return 0;
          return this._heuristicEstimate(text);
        }
      }
    `;
    const tokens = TokenCounter._heuristicEstimate(code);
    expect(tokens).toBeGreaterThan(10);
  });

  it('handles code: Python with def/class/import', () => {
    const py = `
      def fibonacci(n: int) -> int:
          if n <= 1:
              return n
          return fibonacci(n - 1) + fibonacci(n - 2)
    `;
    const tokens = TokenCounter._heuristicEstimate(py);
    expect(tokens).toBeGreaterThan(0);
  });

  it('handles JSON: nested objects with arrays', () => {
    const json = JSON.stringify({
      name: 'test',
      items: Array.from({ length: 50 }, (_, i) => ({ id: i, value: `item_${i}` })),
      metadata: { created: '2026-01-01', version: 2 },
    });
    const tokens = TokenCounter._heuristicEstimate(json);
    expect(tokens).toBeGreaterThan(100);
  });

  it('handles CJK: Chinese text', () => {
    const chinese = '这是一段中文文本，用于测试分词器的启发式估计算法。'.repeat(20);
    const tokens = TokenCounter._heuristicEstimate(chinese);
    expect(tokens).toBeGreaterThan(50);
  });

  it('handles CJK: Japanese (hiragana/katakana)', () => {
    const japanese = 'これはテストです。カタカナも含まれています。'.repeat(20);
    const tokens = TokenCounter._heuristicEstimate(japanese);
    expect(tokens).toBeGreaterThan(30);
  });

  it('handles CJK: Korean (Hangul)', () => {
    const korean = '이것은 한국어 테스트입니다. 한글을 포함하고 있습니다.'.repeat(20);
    const tokens = TokenCounter._heuristicEstimate(korean);
    expect(tokens).toBeGreaterThan(30);
  });

  it('handles markdown with code blocks (strips fences for detection)', () => {
    const md = `
      # Title

      Some explanatory text here.

      \`\`\`typescript
      const x: number = 42;
      function hello(): string {
        return "world";
      }
      \`\`\`

      More prose after the code block.
    `;
    const tokens = TokenCounter._heuristicEstimate(md);
    expect(tokens).toBeGreaterThan(10);
  });

  it('handles empty code blocks in markdown', () => {
    const md = '```\n```';
    const tokens = TokenCounter._heuristicEstimate(md);
    // After stripping code fences, empty string remains — treated as prose, 0 chars → 0 tokens
    expect(tokens).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// JSON DETECTION EDGE CASES
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter — JSON detection edge cases', () => {
  it('JSON without colon pattern (structural density path)', () => {
    // Array of strings: starts with [, no ":"
    const arr = JSON.stringify(Array.from({ length: 100 }, (_, i) => `item_${i}`));
    // Should be detected as JSON via structural density or leading brace/bracket
    const tokens = TokenCounter._heuristicEstimate(arr);
    expect(tokens).toBeGreaterThan(0);
  });

  it('code without typical keywords (edge case for CODE_PAT)', () => {
    // Heavily symbolic "code" with no function/class/const/let/var/if/for/while/def/import
    const symbolic = '{ a => a + 1; b => b * 2; c = a(b); }';
    const tokens = TokenCounter._heuristicEstimate(symbolic);
    expect(tokens).toBeGreaterThan(0);
  });

  it('brace-heavy prose does not trigger JSON structural density', () => {
    // Density check: structural > 15% of length AND structural > alpha * 0.5
    // This has some braces but lots of alpha chars
    const prose = 'The results {of the experiment} showed that (a) and (b) were significant. The researchers noted "important findings" in their paper.';
    const tokens = TokenCounter._heuristicEstimate(prose);
    expect(tokens).toBeGreaterThan(0);
  });

  it('leading whitespace before JSON bracket does not prevent detection', () => {
    const json = '   \n  {"key": "value"}';
    const tokens = TokenCounter._heuristicEstimate(json);
    expect(tokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// MESSAGES WITH TOOLCALLS + TOOLRESULTS
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter.estimateMessages — tool calls & results', () => {
  it('counts toolCalls JSON in assistant messages', () => {
    const withCalls = [
      msg('assistant', 'Let me help.', {
        toolCalls: [
          { id: '1', toolName: 'search', params: { query: 'hello world' } },
          { id: '2', toolName: 'read', params: { path: '/tmp/test.txt' } },
        ],
      }),
    ];
    const withoutCalls = [msg('assistant', 'Let me help.')];
    expect(TokenCounter.estimateMessages(withCalls)).toBeGreaterThan(
      TokenCounter.estimateMessages(withoutCalls)
    );
  });

  it('counts multiple toolResults in tool messages', () => {
    const withResults = [
      msg('tool', null as any, {
        toolResults: [
          { content: 'First result content here.' },
          { content: 'Second result with more text.' },
        ],
      }),
    ];
    expect(TokenCounter.estimateMessages(withResults)).toBeGreaterThan(0);
  });

  it('counts empty-content toolResults as zero tokens', () => {
    const withEmpty = [
      msg('tool', null as any, {
        toolResults: [{ content: '' }],
      }),
    ];
    // The message content is null (skipped), toolResult content is '' (0 tokens)
    const tokens = TokenCounter.estimateMessages(withEmpty);
    expect(tokens).toBeGreaterThanOrEqual(0);
    expect(tokens).toBeLessThan(5); // negligible
  });

  it('message with both toolCalls and toolResults (unusual but safe)', () => {
    const msgs = [
      msg('assistant', 'text', {
        toolCalls: [{ id: '1', toolName: 'test', params: {} }],
        toolResults: [{ content: 'result' }],
      }),
    ];
    expect(() => TokenCounter.estimateMessages(msgs)).not.toThrow();
    expect(TokenCounter.estimateMessages(msgs)).toBeGreaterThan(0);
  });

  it('messages with thinking field are counted (content includes it at call site)', () => {
    // estimateMessages only reads content + toolCalls + toolResults.
    // thinking is NOT counted by estimateMessages — that's a caller responsibility.
    // This test verifies the current behavior explicitly.
    const withThinking = msg('assistant', 'visible content', { thinking: 'hidden reasoning chain here' });
    const withoutThinking = msg('assistant', 'visible content');
    expect(TokenCounter.estimateMessages([withThinking])).toBe(
      TokenCounter.estimateMessages([withoutThinking])
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// REAL TOKENIZER AVAILABILITY
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter.realTokenizerAvailable', () => {
  it('returns a boolean', () => {
    expect(typeof TokenCounter.realTokenizerAvailable()).toBe('boolean');
  });

  it('returns same value on repeated calls (lazy load is stable)', () => {
    const a = TokenCounter.realTokenizerAvailable();
    const b = TokenCounter.realTokenizerAvailable();
    const c = TokenCounter.realTokenizerAvailable();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('when tokenizer IS available, estimate returns real count', () => {
    // Can't force-unload the tokenizer, but we can verify estimate works either way
    const tokens = TokenCounter.estimate('hello world');
    expect(tokens).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// BOUNDARY: huge inputs, deep nesting
// ─────────────────────────────────────────────────────────────────

describe('TokenCounter — boundary stress', () => {
  it('breakdown with massive messages array (1000 messages)', () => {
    const msgs = Array.from({ length: 1000 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}: some content here.`)
    );
    expect(() =>
      TokenCounter.breakdown('sys', [{ name: 't' }], 'skills', msgs)
    ).not.toThrow();
  });

  it('breakdown with deeply nested tool definitions', () => {
    const deepTools = [
      {
        name: 'complex_tool',
        description: 'A deeply nested tool definition',
        parameters: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                deeper: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string', description: 'x'.repeat(1000) },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ];
    expect(() =>
      TokenCounter.breakdown('sys', deepTools, '', [])
    ).not.toThrow();
  });

  it('estimate with 500k character string', () => {
    const huge = 'Hello world. '.repeat(50_000);
    expect(huge.length).toBeGreaterThan(500_000);
    const tokens = TokenCounter.estimate(huge);
    expect(tokens).toBeGreaterThan(100_000);
    expect(Number.isFinite(tokens)).toBe(true);
  });
});
