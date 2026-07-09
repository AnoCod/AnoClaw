import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerChatHandlers } from '../ChatHandlers.js';
import { WSMessageRouter } from '../../viewmodel/WSMessageRouter.js';
import { ToastManager } from '../../ToastManager.js';
import { slotRegistry } from '../../SlotRegistry.js';
import { ToolConfirmationQueue } from '../../viewmodel/ToolConfirmationQueue.js';

afterEach(() => {
  vi.restoreAllMocks();
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

  it('routes artifact events to the owning session agent', () => {
    const router = new WSMessageRouter();
    const onServerEvent = vi.fn();
    const getAgent = vi.fn(() => ({ onServerEvent }));

    registerChatHandlers(
      router,
      { getAgent } as any,
      {} as any,
    );

    router.dispatch('artifact_done', {
      sessionId: 'artifact-session',
      artifactId: 'art-1',
      artifact: { id: 'art-1', sessionId: 'artifact-session' },
    }, 'root-session');

    expect(getAgent).toHaveBeenCalledWith('artifact-session');
    expect(onServerEvent).toHaveBeenCalledWith('artifact_done', expect.objectContaining({
      sessionId: 'artifact-session',
      artifactId: 'art-1',
    }));
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

  it('forwards tool confirmations with the explicit backend session and auto-approve flag', () => {
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
      autoApprove: true,
    }));
  });
});
