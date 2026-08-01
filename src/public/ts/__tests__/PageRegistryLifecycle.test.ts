import { describe, expect, it, vi } from 'vitest';
import { pageRegistry } from '../PageRegistry.js';
import type { Page } from '../types.js';

function makePage(name: string): { page: Page; dispose: ReturnType<typeof vi.fn<() => void>> } {
  const container = {
    style: { display: '' },
    setAttribute: vi.fn(),
    remove: vi.fn(),
  } as unknown as HTMLElement;
  const dispose = vi.fn<() => void>();
  return { page: {
    name,
    container,
    onEnter: vi.fn(),
    onExit: vi.fn(),
    dispose,
  }, dispose };
}

describe('PageRegistry plugin lifecycle', () => {
  it('disposes an old same-name page before replacing it', () => {
    const name = `plugin-lifecycle-${Date.now()}`;
    const oldPage = makePage(name);
    const replacement = makePage(name);

    pageRegistry.register(oldPage.page);
    pageRegistry.register(replacement.page);

    expect(oldPage.dispose).toHaveBeenCalledOnce();
    expect(pageRegistry.getPage(name)).toBe(replacement.page);
    pageRegistry.unregister(name);
    expect(replacement.dispose).toHaveBeenCalledOnce();
    expect(pageRegistry.getPage(name)).toBeUndefined();
  });
});
