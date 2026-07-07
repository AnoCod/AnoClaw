import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerChatHandlers } from '../ChatHandlers.js';
import { WSMessageRouter } from '../../viewmodel/WSMessageRouter.js';
import { ToastManager } from '../../ToastManager.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerChatHandlers', () => {
  it('shows a toast when plugin_load_failed is received', () => {
    const router = new WSMessageRouter();
    const showSpy = vi.spyOn(ToastManager.getInstance(), 'show').mockReturnValue(1);

    registerChatHandlers(
      router,
      { getAgent: vi.fn() } as any,
      {} as any,
    );

    router.dispatch('plugin_load_failed', {
      pluginName: 'bad-plugin',
      error: 'activation failed',
    }, '*broadcast');

    expect(showSpy).toHaveBeenCalledWith(
      'error',
      'Plugin "bad-plugin" failed to load: activation failed',
      8000,
    );
  });
});
