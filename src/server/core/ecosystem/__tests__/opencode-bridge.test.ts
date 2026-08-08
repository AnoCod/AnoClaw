import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { OpenCodePluginBridge } from '../importers/opencode-bridge.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { TypedEventBus, TypedEventBusImpl } from '../../events/TypedEventBus.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode-sample.mjs');

beforeEach(() => {
  ToolRegistry.resetInstance();
  TypedEventBusImpl.resetInstance();
});

afterAll(() => {
  ToolRegistry.resetInstance();
  TypedEventBusImpl.resetInstance();
});

describe('OpenCodePluginBridge (in-process mode)', () => {
  it('loads a plugin, registers tools, maps hooks, and invokes them', async () => {
    const bridge = new OpenCodePluginBridge(FIXTURE, path.dirname(FIXTURE), { worker: false });
    const handle = await bridge.start();

    expect(handle.toolNames).toContain('opencode_fixtures_myGreeter');
    expect(handle.mappedHooks).toBe(1);
    expect(handle.unmappedHooks).toEqual([]);

    const registry = ToolRegistry.getInstance();
    expect(registry.hasTool('opencode_fixtures_myGreeter')).toBe(true);

    await expect(bridge.invoke('myGreeter', { name: 'codex' })).resolves.toBe('hello codex');
    await expect(bridge.invoke('session.created', { sessionId: 's1' })).resolves.toBe('session hook ran');

    // Hook mapping subscribes to the AnoClaw event bus.
    expect(TypedEventBus.handlerCount).toBeGreaterThan(0);

    await handle.dispose();
    expect(registry.hasTool('opencode_fixtures_myGreeter')).toBe(false);
  });
});
