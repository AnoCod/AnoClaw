import { describe, expect, it, vi } from 'vitest';
import { resolvePluginHttpHandler, type PluginHandlerRequest } from '../PluginHandlerResolver.js';

const request: PluginHandlerRequest = {
  body: null,
  params: {},
  query: '',
  headers: {},
  method: 'GET',
  path: '/api/fixture',
};

describe('resolvePluginHttpHandler', () => {
  it('binds a class-style handler to its active plugin instance', async () => {
    class FixturePlugin {
      readonly value = 'instance-result';
      async handleFixture(): Promise<{ status: number; body: { value: string } }> {
        return { status: 200, body: { value: this.value } };
      }
    }

    const handler = resolvePluginHttpHandler({}, new FixturePlugin(), 'handleFixture');
    await expect(handler?.(request)).resolves.toEqual({
      status: 200,
      body: { value: 'instance-result' },
    });
  });

  it('falls back to a function-style module export', async () => {
    const exported = vi.fn(async () => ({ status: 204, body: {} }));
    const handler = resolvePluginHttpHandler({ handleFixture: exported }, null, 'handleFixture');

    await expect(handler?.(request)).resolves.toEqual({ status: 204, body: {} });
    expect(exported).toHaveBeenCalledWith(request);
  });

  it('prefers an instance handler when both styles provide the same name', async () => {
    const exported = vi.fn();
    const instance = { handleFixture: vi.fn(() => 'instance') };
    const handler = resolvePluginHttpHandler({ handleFixture: exported }, instance, 'handleFixture');

    expect(await handler?.(request)).toBe('instance');
    expect(exported).not.toHaveBeenCalled();
  });

  it('returns null when neither style provides the handler', () => {
    expect(resolvePluginHttpHandler({}, {}, 'missing')).toBeNull();
  });
});
