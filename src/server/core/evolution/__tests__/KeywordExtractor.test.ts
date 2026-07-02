/**
 * KeywordExtractor.test.ts — M2 periodic keyword extraction
 *
 * Tests cover:
 *   1. Extract keywords from user messages
 *   2. Extract keywords from LLM messages
 *   3. Respects maxKeywordsPerSide limit
 *   4. Empty input returns empty result
 *   5. Turn range tracking
 *   6. Summary generation
 */

import { describe, it, expect } from 'vitest';
import { KeywordExtractor } from '../modules/KeywordExtractor.js';

describe('KeywordExtractor', () => {

  it('extracts user keywords from messages', () => {
    const extractor = new KeywordExtractor({ interval: 10 });
    const result = extractor.extract(
      ['Fix the login button color to match the dark theme design'],
      ['I updated the CSS variables in theme.css'],
      1,
      10,
    );

    expect(result.userKeywords.length).toBeGreaterThanOrEqual(2);
    expect(result.userKeywords).toContain('login');
    expect(result.userKeywords).toContain('button');
  });

  it('extracts LLM keywords', () => {
    const extractor = new KeywordExtractor();
    const result = extractor.extract(
      ['Make the API faster'],
      ['Optimized the database query with proper indexing and caching strategy'],
      1, 10,
    );

    expect(result.llmKeywords.length).toBeGreaterThanOrEqual(3);
    expect(result.llmKeywords).toContain('optimized');
  });

  it('respects maxKeywordsPerSide limit', () => {
    const extractor = new KeywordExtractor({ maxKeywordsPerSide: 2 });
    const result = extractor.extract(
      ['login button color theme font layout spacing margin padding'],
      ['optimized database query indexing caching performance'],
      1, 10,
    );

    expect(result.userKeywords.length).toBeLessThanOrEqual(2);
    expect(result.llmKeywords.length).toBeLessThanOrEqual(2);
  });

  it('returns empty arrays for empty input', () => {
    const extractor = new KeywordExtractor();
    const result = extractor.extract([], [], 0, 0);

    expect(result.userKeywords).toEqual([]);
    expect(result.llmKeywords).toEqual([]);
    expect(result.summary).toBe('');
  });

  it('tracks turn range', () => {
    const extractor = new KeywordExtractor();
    const result = extractor.extract([], [], 21, 30);

    expect(result.turnRange.start).toBe(21);
    expect(result.turnRange.end).toBe(30);
  });

  it('generates summary with combined keywords', () => {
    const extractor = new KeywordExtractor();
    const result = extractor.extract(
      ['login authentication'],
      ['JWT token security'],
      1, 10,
    );

    expect(result.summary).toContain('login');
    expect(result.summary).toContain('authentication');
  });

  it('records multiple extraction results', () => {
    const extractor = new KeywordExtractor();

    extractor.extract(['first message'], ['response one'], 1, 10);
    extractor.extract(['second message'], ['response two'], 11, 20);

    const all = extractor.getAllResults();
    expect(all.length).toBe(2);
    expect(all[0].turnRange.start).toBe(1);
    expect(all[1].turnRange.start).toBe(11);
  });

  it('provides recent results in reverse order', () => {
    const extractor = new KeywordExtractor();

    extractor.extract(['a'], ['A'], 1, 10);
    extractor.extract(['b'], ['B'], 11, 20);
    extractor.extract(['c'], ['C'], 21, 30);

    const recent = extractor.getRecentResults(2);
    expect(recent.length).toBe(2);
    expect(recent[0].turnRange.start).toBe(21);
    expect(recent[1].turnRange.start).toBe(11);
  });

  it('filters stop words', () => {
    const extractor = new KeywordExtractor();
    const result = extractor.extract(
      ['the and this is a test for filtering'],
      ['it will be done with the code'],
      1, 10,
    );

    expect(result.userKeywords).not.toContain('the');
    expect(result.userKeywords).not.toContain('this');
    expect(result.userKeywords).toContain('filtering');
  });

});
