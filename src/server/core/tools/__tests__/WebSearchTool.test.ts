import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const webFetchMock = vi.hoisted(() => vi.fn());

vi.mock('../../../infra/network/WebFetchHelper.js', () => ({
  webFetch: webFetchMock,
}));

import { WebSearchTool } from '../builtin/WebSearchTool.js';

const ctx: ExecutionContext = {
  sessionId: 'web-search-test-session',
  agentId: 'web-search-test-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

function fakeResponse(body: string, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText,
    headers: { get: vi.fn(() => 'text/html') },
    text: vi.fn(async () => body),
    json: vi.fn(async () => JSON.parse(body)),
  };
}

describe('WebSearchTool', () => {
  beforeEach(() => {
    vi.useRealTimers();
    webFetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns bounded results with exact/subdomain domain filtering', async () => {
    webFetchMock.mockResolvedValue(fakeResponse(`
      <tr><td><a href="https://github.com/AnoCod/AnoClaw">AnoClaw</a></td><td><span class="link-text">Project repo</span></td></tr>
      <tr><td><a href="https://notgithub.com/trap">Not GitHub</a></td><td><span class="link-text">Should not match github.com</span></td></tr>
      <tr><td><a href="https://docs.github.com/actions">GitHub Docs</a></td><td><span class="link-text">Docs result</span></td></tr>
    `));

    const result = await new WebSearchTool().execute({
      query: '  anoclaw   github  ',
      allowed_domains: ['github.com'],
      max_results: 1,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('https://github.com/AnoCod/AnoClaw');
    expect(result.content).not.toContain('notgithub.com');
    expect(result.content).not.toContain('docs.github.com');
    expect(result.structured).toMatchObject({
      query: 'anoclaw github',
      status: 'ok',
      maxResults: 1,
      resultCount: 1,
      unfilteredResultCount: 3,
      filters: { allowedDomains: ['github.com'], blockedDomains: [] },
    });
  });

  it('falls back to DuckDuckGo HTML and decodes redirect URLs', async () => {
    webFetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(fakeResponse(`
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1&amp;rut=abc">Example &amp; Docs</a>
        <a class="result__snippet">Useful &lt;docs&gt; snippet</a>
      `));

    const result = await new WebSearchTool().execute({ query: 'example docs' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Example & Docs');
    expect(result.content).toContain('https://example.com/docs?x=1');
    expect(result.content).toContain('Useful <docs> snippet');
    expect(webFetchMock).toHaveBeenCalledTimes(2);
    expect(result.structured).toMatchObject({
      status: 'ok',
      backendAttempts: [
        expect.objectContaining({ backend: 'DuckDuckGo Lite', status: 'network_error' }),
        expect.objectContaining({ backend: 'DuckDuckGo HTML', status: 'ok', resultCount: 1 }),
      ],
    });
  });

  it('returns a structured timeout instead of hanging on an unresponsive backend', async () => {
    vi.useFakeTimers();
    webFetchMock.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));

    const pending = new WebSearchTool().execute({ query: 'very slow search', timeout_ms: 1000 }, ctx);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    expect(result.structured).toMatchObject({
      query: 'very slow search',
      status: 'timeout',
      timeoutMs: 1000,
      backendAttempts: [
        expect.objectContaining({ backend: 'DuckDuckGo Lite', status: 'timeout' }),
        expect.objectContaining({ backend: 'DuckDuckGo HTML', status: 'skipped' }),
      ],
    });
  });

  it('times out when a backend response body never finishes', async () => {
    vi.useFakeTimers();
    webFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: vi.fn(() => 'text/html') },
      text: vi.fn(() => new Promise<string>(() => {})),
      json: vi.fn(),
    });

    const pending = new WebSearchTool().execute({ query: 'slow body search', timeout_ms: 1000 }, ctx);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(result.structured).toMatchObject({
      query: 'slow body search',
      status: 'timeout',
      timeoutMs: 1000,
      backendAttempts: [
        expect.objectContaining({ backend: 'DuckDuckGo Lite', status: 'timeout' }),
        expect.objectContaining({ backend: 'DuckDuckGo HTML', status: 'skipped' }),
      ],
    });
  });

  it('reports user cancellation without starting network work', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await new WebSearchTool().execute({ query: 'cancelled search' }, {
      ...ctx,
      signal: controller.signal,
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('cancelled by user');
    expect(webFetchMock).not.toHaveBeenCalled();
    expect(result.structured).toMatchObject({
      status: 'aborted',
      backendAttempts: [
        expect.objectContaining({ backend: 'DuckDuckGo Lite', status: 'aborted' }),
      ],
    });
  });

  it('validates ambiguous filters and query bounds before searching', async () => {
    const tool = new WebSearchTool();

    const badDomains = await tool.execute({ query: 'valid query', allowed_domains: 'github.com' }, ctx);
    expect(badDomains.success).toBe(false);
    expect(badDomains.errorMessage).toContain('allowed_domains must be an array');

    const badQuery = await tool.execute({ query: '  ' }, ctx);
    expect(badQuery.success).toBe(false);
    expect(badQuery.errorMessage).toContain('query must be at least');

    expect(webFetchMock).not.toHaveBeenCalled();
  });
});
