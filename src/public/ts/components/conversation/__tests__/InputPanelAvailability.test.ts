import { describe, expect, it } from 'vitest';
import { hasSendableComposerContent } from '../InputPanelUtils.js';

describe('InputPanel send availability', () => {
  it('requires a non-empty message or at least one attachment', () => {
    expect(hasSendableComposerContent('', 0)).toBe(false);
    expect(hasSendableComposerContent('   ', 0)).toBe(false);
    expect(hasSendableComposerContent('hello', 0)).toBe(true);
    expect(hasSendableComposerContent('', 1)).toBe(true);
  });
});
