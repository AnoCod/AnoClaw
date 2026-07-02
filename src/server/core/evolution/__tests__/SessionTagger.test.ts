/**
 * SessionTagger.test.ts — M4 auto session tagging
 *
 * Tests cover:
 *   1. Tag a session with auto labels
 *   2. Add user tag
 *   3. Remove tag
 *   4. Get tags for session
 *   5. Tag merging (auto + user)
 *   6. Tag deduplication
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionTagger } from '../modules/SessionTagger.js';

describe('SessionTagger', () => {

  let tagger: SessionTagger;

  beforeEach(() => {
    tagger = new SessionTagger();
  });

  it('adds an auto tag to a session', () => {
    tagger.addTag('sess-001', 'frontend', 'auto');
    const tags = tagger.getTags('sess-001');
    expect(tags.length).toBe(1);
    expect(tags[0].label).toBe('frontend');
    expect(tags[0].category).toBe('auto');
    expect(tags[0].confidence).toBeGreaterThan(0);
  });

  it('adds a user tag to a session', () => {
    tagger.addTag('sess-001', 'bug-fix', 'user');
    const tags = tagger.getTags('sess-001');
    expect(tags[0].category).toBe('user');
  });

  it('does not duplicate identical tags', () => {
    tagger.addTag('sess-001', 'frontend', 'auto');
    tagger.addTag('sess-001', 'frontend', 'auto');
    const tags = tagger.getTags('sess-001');
    expect(tags.length).toBe(1);
  });

  it('removes a tag from a session', () => {
    tagger.addTag('sess-001', 'frontend', 'auto');
    tagger.addTag('sess-001', 'backend', 'auto');

    tagger.removeTag('sess-001', 'frontend');
    const tags = tagger.getTags('sess-001');
    expect(tags.length).toBe(1);
    expect(tags[0].label).toBe('backend');
  });

  it('returns empty array for unknown session', () => {
    expect(tagger.getTags('nonexistent')).toEqual([]);
  });

  it('merges auto + user tags together', () => {
    tagger.addTag('sess-001', 'frontend', 'auto');
    tagger.addTag('sess-001', 'bug-fix', 'user');

    const tags = tagger.getTags('sess-001');
    expect(tags.length).toBe(2);
    const userTags = tags.filter(t => t.category === 'user');
    const autoTags = tags.filter(t => t.category === 'auto');
    expect(userTags.length).toBe(1);
    expect(autoTags.length).toBe(1);
  });

  it('replaces auto tag with user tag when same label', () => {
    tagger.addTag('sess-001', 'frontend', 'auto');
    tagger.addTag('sess-001', 'frontend', 'user');

    const tags = tagger.getTags('sess-001');
    expect(tags.length).toBe(1);
    expect(tags[0].category).toBe('user');
  });

  it('returns all sessions having a specific tag', () => {
    tagger.addTag('sess-A', 'frontend', 'auto');
    tagger.addTag('sess-B', 'frontend', 'auto');
    tagger.addTag('sess-A', 'backend', 'auto');

    const frontendSessions = tagger.getSessionsByTag('frontend');
    expect(frontendSessions.sort()).toEqual(['sess-A', 'sess-B']);

    const backendSessions = tagger.getSessionsByTag('backend');
    expect(backendSessions).toEqual(['sess-A']);
  });

  it('produces serializable tag data for a session', () => {
    tagger.addTag('sess-001', 'frontend', 'auto');
    tagger.addTag('sess-001', 'refactor', 'user');

    const data = tagger.toJSON('sess-001');
    expect(data.length).toBe(2);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

});
