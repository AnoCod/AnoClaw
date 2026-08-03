import { describe, expect, it } from 'vitest';
import { isNearConversationBottom } from '../SessionsPageUtils.js';

describe('SessionsPage scroll position', () => {
  it('treats the threshold boundary as the live conversation tail', () => {
    expect(isNearConversationBottom(1_000, 650, 300, 50)).toBe(true);
    expect(isNearConversationBottom(1_000, 649, 300, 50)).toBe(false);
  });

  it('accepts exact-bottom and browser overscroll positions', () => {
    expect(isNearConversationBottom(1_000, 700, 300)).toBe(true);
    expect(isNearConversationBottom(1_000, 720, 300)).toBe(true);
  });
});
