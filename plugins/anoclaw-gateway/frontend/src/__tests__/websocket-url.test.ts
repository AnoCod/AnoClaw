import { describe, expect, it } from 'vitest';
import { resolvePluginWebSocketUrl } from '../websocket-url.js';

describe('resolvePluginWebSocketUrl', () => {
  it('uses the plugin bundle origin instead of the srcdoc location', () => {
    expect(resolvePluginWebSocketUrl(
      'about:srcdoc',
      'http://127.0.0.1:3456/plugins/anoclaw-gateway/frontend/bundle.js',
    )).toBe('ws://127.0.0.1:3456/ws');
  });

  it('upgrades secure plugin pages to wss', () => {
    expect(resolvePluginWebSocketUrl('https://localhost:8443/plugins/gateway/index.html'))
      .toBe('wss://localhost:8443/ws');
  });

  it('rejects candidates without an HTTP origin', () => {
    expect(() => resolvePluginWebSocketUrl('about:srcdoc', 'file:///plugin/index.html'))
      .toThrow('Unable to resolve');
  });
});
