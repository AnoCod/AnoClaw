import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerChatHandlers } from '../ChatHandlers.js';
import { WSMessageRouter } from '../../viewmodel/WSMessageRouter.js';
import { ToastManager } from '../../ToastManager.js';
import { slotRegistry } from '../../SlotRegistry.js';
import { ToolConfirmationQueue } from '../../viewmodel/ToolConfirmationQueue.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ToolConfirmationQueue.resetInstance();
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

  it('removes all slot content for a deactivated plugin', () => {
    const router = new WSMessageRouter();
    const removeSpy = vi.spyOn(slotRegistry, 'removeByPlugin').mockImplementation(() => {});

    registerChatHandlers(
      router,
      { getAgent: vi.fn() } as any,
      {} as any,
    );

    router.dispatch('plugin:ui:removeByPlugin', {
      pluginName: 'cleanup-plugin',
    }, '*broadcast');

    expect(removeSpy).toHaveBeenCalledWith('cleanup-plugin');
  });

  it('forwards tool confirmations with the explicit backend session without auto-approval', () => {
    const router = new WSMessageRouter();
    const queue = ToolConfirmationQueue.getInstance();
    const enqueueSpy = vi.spyOn(queue, 'enqueue').mockImplementation(() => {});

    registerChatHandlers(
      router,
      { getAgent: vi.fn() } as any,
      {} as any,
    );

    router.dispatch('tool_confirm_request', {
      sessionId: 'goal-root-session',
      toolCallId: 'tc-bash',
      toolName: 'Bash',
      displayName: 'Bash',
      riskLevel: 'High',
      params: { command: 'npm test' },
      autoApprove: true,
    }, 'routed-session');

    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'goal-root-session',
      toolCallId: 'tc-bash',
    }));
    expect(enqueueSpy).not.toHaveBeenCalledWith(expect.objectContaining({ autoApprove: true }));
  });

  it('correlates compact completion with its session and success state', () => {
    const router = new WSMessageRouter();
    const loadHistory = vi.fn(async () => true);
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', class {
      type: string;
      detail: unknown;
      constructor(type: string, options: { detail: unknown }) {
        this.type = type;
        this.detail = options.detail;
      }
    });
    vi.spyOn(ToastManager.getInstance(), 'success').mockReturnValue(1);
    vi.spyOn(ToastManager.getInstance(), 'error').mockReturnValue(2);

    registerChatHandlers(
      router,
      { getAgent: vi.fn(() => ({ loadHistory })) } as any,
      {} as any,
    );

    router.dispatch('command_result', {
      command: 'compact',
      success: true,
      output: 'Compacted',
    }, 'session-compact');
    router.dispatch('command_result', {
      command: 'compact',
      success: false,
      output: 'Failed',
    }, 'session-compact');

    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'compaction-completed',
      detail: expect.objectContaining({ sessionId: 'session-compact', success: true }),
    }));
    expect(dispatchEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'compaction-completed',
      detail: expect.objectContaining({ sessionId: 'session-compact', success: false }),
    }));
  });
});
