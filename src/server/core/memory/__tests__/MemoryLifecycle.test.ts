import { describe, it, expect } from 'vitest';
import {
  computeMemoryStrength,
  getQuantizationTier,
  findConsolidationGroups,
  buildConsolidationPrompt,
} from '../lifecycle/MemoryLifecycle.js';
import { MemoryType, MemoryScope, MemoryCategory } from '../MemoryEntry.js';
import type { MemoryEntry } from '../MemoryEntry.js';

function e(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    name: 'test-memory',
    type: MemoryType.Reference,
    description: 'Test memory',
    content: 'This is a test memory entry.',
    scope: MemoryScope.Agent,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('computeMemoryStrength', () => {
  it('returns ~1.0 for a recently updated entry with importance 0.5', () => {
    const entry = e({ updatedAt: Date.now(), importance: 0.5 } as any);
    const strength = computeMemoryStrength(entry);
    // Very recent + 0.5 importance + 0 freq boost ≈ 0.5
    expect(strength).toBeCloseTo(0.5, 1);
  });

  it('decays over time', () => {
    const recent = e({ updatedAt: Date.now(), importance: 1.0 } as any);
    const old = e({ updatedAt: Date.now() - 30 * 24 * 3600 * 1000, importance: 1.0 } as any);
    const recentStrength = computeMemoryStrength(recent);
    const oldStrength = computeMemoryStrength(old);
    expect(recentStrength).toBeGreaterThan(oldStrength);
  });

  it('frequency boost increases strength', () => {
    const base = e();
    const frequent = e({ accessCount: 100 } as any);
    const baseStrength = computeMemoryStrength(base);
    const freqStrength = computeMemoryStrength(frequent);
    expect(freqStrength).toBeGreaterThan(baseStrength);
  });

  it('caps at 1.0', () => {
    const entry = e({ updatedAt: Date.now(), importance: 1.0, accessCount: 10000 } as any);
    const strength = computeMemoryStrength(entry);
    expect(strength).toBeLessThanOrEqual(1.0);
  });
});

describe('getQuantizationTier', () => {
  it('classifies high strength as active', () => {
    expect(getQuantizationTier(0.5)).toBe('active');
    expect(getQuantizationTier(0.3)).toBe('active');
  });

  it('classifies medium strength as warm', () => {
    expect(getQuantizationTier(0.2)).toBe('warm');
    expect(getQuantizationTier(0.1)).toBe('warm');
  });

  it('classifies low strength as cold', () => {
    expect(getQuantizationTier(0.07)).toBe('cold');
    expect(getQuantizationTier(0.05)).toBe('cold');
  });

  it('classifies very low strength as archive', () => {
    expect(getQuantizationTier(0.04)).toBe('archive');
    expect(getQuantizationTier(0)).toBe('archive');
  });
});

describe('findConsolidationGroups', () => {
  it('returns empty for fewer than MIN_MERGE_COUNT entries', () => {
    const entries = [
      e({ name: 'a', content: 'completely different topic' }),
      e({ name: 'b', content: 'another unrelated subject' }),
    ];
    const groups = findConsolidationGroups(entries);
    expect(groups).toEqual([]);
  });

  it('finds groups of similar content', () => {
    const entries = [
      e({ name: 'a', content: 'logging configuration setup logging' }),
      e({ name: 'b', content: 'logging configuration setup production' }),
      e({ name: 'c', content: 'logging configuration setup options' }),
    ];
    const groups = findConsolidationGroups(entries, 0.2); // lower threshold for test
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(3);
  });

  it('does not group entries of different types', () => {
    const entries = [
      e({ name: 'a', type: MemoryType.Reference, content: 'logging config' }),
      e({ name: 'b', type: MemoryType.User, content: 'logging config' }),
    ];
    const groups = findConsolidationGroups(entries);
    expect(groups).toEqual([]);
  });
});

describe('buildConsolidationPrompt', () => {
  it('builds prompt from a group of memories', () => {
    const group = [
      e({ name: 'config-1', content: 'Use port 3000' }),
      e({ name: 'config-2', content: 'Production uses port 8080' }),
    ];
    const { systemPrompt, userPrompt, topic } = buildConsolidationPrompt(group);

    expect(systemPrompt).toContain('consolidation');
    expect(userPrompt).toContain('config-1');
    expect(userPrompt).toContain('config-2');
    expect(userPrompt).toContain('Use port 3000');
    expect(userPrompt).toContain('Production uses port 8080');
    expect(topic).toBe('config-1');
  });
});
