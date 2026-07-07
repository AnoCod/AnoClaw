import { describe, expect, it } from 'vitest';
import { normalizeUserMode, USER_MODE_OPTIONS } from '../userMode.js';

describe('frontend user mode helpers', () => {
  it('normalizes supported modes and aliases', () => {
    expect(normalizeUserMode('simple')).toBe('simple');
    expect(normalizeUserMode('office')).toBe('office');
    expect(normalizeUserMode('work')).toBe('office');
    expect(normalizeUserMode('programming')).toBe('coding');
    expect(normalizeUserMode('developer')).toBe('coding');
    expect(normalizeUserMode('child')).toBe('child');
    expect(normalizeUserMode('education')).toBe('child');
    expect(normalizeUserMode('pro')).toBe('professional');
    expect(normalizeUserMode('unknown')).toBe('simple');
  });

  it('keeps the expected built-in mode order', () => {
    expect(USER_MODE_OPTIONS.map((mode) => mode.value)).toEqual([
      'simple',
      'office',
      'coding',
      'professional',
      'child',
    ]);
  });
});
