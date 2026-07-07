import { afterEach, describe, expect, it } from 'vitest';
import { PluginHostManager } from '../PluginHostManager.js';
import type { PluginState } from '../PluginRPC.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { Tool, type ExecutionContext, type ToolResult } from '../../tools/Tool.js';
import { PromptAssembler } from '../../prompt/PromptAssembler.js';
import { ApiServer } from '../../../gateway/ApiServer.js';

describe('PluginHostManager activation wait', () => {
  afterEach(() => {
    PluginHostManager.resetInstance();
    ToolRegistry.resetInstance();
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

  it('cleans up tools, routes, prompt sections, and event subscriptions for a plugin without a running worker', async () => {
    const manager = PluginHostManager.getInstance();
    const api = ApiServer.getInstance();
    const assembler = PromptAssembler.getInstance();
    const registry = ToolRegistry.getInstance();

    registry.registerTool(new FixtureTool('plugin.tool'), 'Plugin', { source: 'plugin', pluginName: 'cleanup-plugin' });
    (manager as unknown as { _installedTools: Map<string, string> })._installedTools.set('plugin.tool', 'cleanup-plugin');
    (manager as unknown as { _eventSubs: Map<string, Set<string>> })._eventSubs.set('session:created', new Set(['cleanup-plugin']));
    api.registerPluginRoutes('cleanup-plugin', [{ method: 'GET', path: '/api/v1/plugins/cleanup-plugin/test', handler: 'handleTest' }]);
    assembler.registerSection({ name: 'plugin:cleanup-plugin:test', cacheBreak: false, compute: () => 'stale plugin prompt' }, 'dynamic');

    expect(registry.hasTool('plugin.tool')).toBe(true);
    expect(assembler.sectionNames).toContain('plugin:cleanup-plugin:test');

    await expect(manager.deactivatePlugin('cleanup-plugin')).resolves.toEqual({ deactivated: false });

    expect(registry.hasTool('plugin.tool')).toBe(false);
    expect((manager as unknown as { _installedTools: Map<string, string> })._installedTools.has('plugin.tool')).toBe(false);
    expect((manager as unknown as { _eventSubs: Map<string, Set<string>> })._eventSubs.has('session:created')).toBe(false);
    expect(assembler.sectionNames).not.toContain('plugin:cleanup-plugin:test');
    expect(api.unregisterPluginRoutes('cleanup-plugin')).toBe(0);
  });
});

class FixtureTool extends Tool {
  constructor(private readonly toolName: string) {
    super();
  }

  name(): string { return this.toolName; }
  description(): string { return `${this.toolName} fixture`; }
  parametersSchema(): Record<string, unknown> { return { type: 'object', properties: {} }; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}

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
