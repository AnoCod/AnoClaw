import { describe, expect, it } from 'vitest';
import { resolvePluginWebSocketUrl } from '../websocket-url.js';

describe('resolvePluginWebSocketUrl', () => {
  it('uses the plugin bundle origin instead of the srcdoc location', () => {
    expect(resolvePluginWebSocketUrl(
      'about:srcdoc',
      'http://localhost:3456/plugins/anoclaw-mcp/frontend/bundle.js',
    )).toBe('ws://localhost:3456/ws');
  });

  it('upgrades secure plugin pages to wss', () => {
    expect(resolvePluginWebSocketUrl('https://127.0.0.1:8443/plugins/mcp/index.html'))
      .toBe('wss://127.0.0.1:8443/ws');
  });

  it('rejects candidates without an HTTP origin', () => {
    expect(() => resolvePluginWebSocketUrl('about:srcdoc', 'file:///plugin/index.html'))
      .toThrow('Unable to resolve');
  });
});
