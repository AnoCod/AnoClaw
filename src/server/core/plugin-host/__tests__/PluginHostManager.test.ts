import { afterEach, describe, expect, it } from 'vitest';
import { PluginHostManager } from '../PluginHostManager.js';
import type { PluginState } from '../PluginRPC.js';

describe('PluginHostManager activation wait', () => {
  afterEach(() => {
    PluginHostManager.resetInstance();
  });

  it('rejects immediately when the target plugin reports an activation error', async () => {
    const manager = PluginHostManager.getInstance();
    const waiting = waitForPluginReady(manager, pluginState('bad-plugin'), 1000, 'timed out');

    manager.emit('plugin-error', 'bad-plugin', new Error('missing dependency'));

    await expect(waiting).rejects.toThrow('missing dependency');
  });

  it('ignores readiness and errors from other plugins while waiting', async () => {
    const manager = PluginHostManager.getInstance();
    const waiting = waitForPluginReady(manager, pluginState('target-plugin'), 1000, 'timed out');

    manager.emit('plugin-error', 'other-plugin', new Error('other failed'));
    manager.emit('plugin-ready', 'other-plugin');
    manager.emit('plugin-ready', 'target-plugin');

    await expect(waiting).resolves.toMatchObject({
      status: 'activated',
      manifest: { name: 'target-plugin' },
    });
  });
});

function pluginState(name: string): PluginState {
  return {
    manifest: {
      name,
      displayName: name,
      version: '0.0.0',
      main: 'extension.js',
      activationEvents: [],
    },
    pluginPath: '',
    status: 'loaded',
  };
}

function waitForPluginReady(
  manager: PluginHostManager,
  state: PluginState,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<PluginState> {
  return (manager as unknown as {
    _waitForPluginReady(name: string, state: PluginState, timeoutMs: number, timeoutMessage: string): Promise<PluginState>;
  })._waitForPluginReady(state.manifest.name, state, timeoutMs, timeoutMessage);
}
