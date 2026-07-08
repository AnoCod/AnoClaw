import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const webFetchMock = vi.hoisted(() => vi.fn());
const dnsLookupMock = vi.hoisted(() => vi.fn());

vi.mock('../../../infra/network/WebFetchHelper.js', () => ({
  webFetch: webFetchMock,
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: dnsLookupMock,
  },
}));

import { WebFetchTool } from '../builtin/WebFetchTool.js';

const ctx: ExecutionContext = {
  sessionId: 'web-fetch-test-session',
  agentId: 'web-fetch-test-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

function fakeResponse(body: string, contentType = 'text/plain', status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText,
    headers: { get: vi.fn(() => contentType) },
    text: vi.fn(async () => body),
    json: vi.fn(async () => JSON.parse(body)),
  };
}

describe('WebFetchTool', () => {
  beforeEach(() => {
    vi.useRealTimers();
    webFetchMock.mockReset();
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('converts HTML to readable bounded output with structured truncation metadata', async () => {
    webFetchMock.mockResolvedValue(fakeResponse(`
      <html>
        <head><style>.hidden{}</style><script>alert(1)</script></head>
        <body><header>Navigation</header><main>Alpha beta gamma delta epsilon zeta eta theta iota kappa. Long content repeats useful details many times. Long content repeats useful details many times.</main></body>
      </html>
    `, 'text/html; charset=utf-8'));

    const result = await new WebFetchTool().execute({
      url: 'http://example.test/page',
      max_content_chars: 120,
      use_cache: false,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('[Fetched] https://example.test/page');
    expect(result.content).toContain('Alpha beta gamma');
    expect(result.content).not.toContain('alert');
    expect(result.wasTruncated).toBe(true);
    expect(result.structured).toMatchObject({
      url: 'https://example.test/page',
      status: 'ok',
      cached: false,
      contentType: 'text/html; charset=utf-8',
      maxContentChars: 120,
      wasTruncated: true,
      attempts: [expect.objectContaining({ attempt: 1, status: 'ok' })],
    });
  });

  it('uses cached raw content while still applying prompt-focused excerpts', async () => {
    webFetchMock.mockResolvedValue(fakeResponse(
      'Alpha irrelevant paragraph. Billing policy says invoices are due monthly. Zebra unrelated paragraph.',
      'text/plain',
    ));
    const tool = new WebFetchTool();

    const first = await tool.execute({ url: 'https://cache-focus.test/page' }, ctx);
    expect(first.success).toBe(true);

    const second = await tool.execute({
      url: 'https://cache-focus.test/page',
      prompt: 'extract billing invoices policy',
      max_content_chars: 200,
    }, ctx);

    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(second.success).toBe(true);
    expect(second.content).toContain('[Cached] https://cache-focus.test/page');
    expect(second.content).toContain('Billing policy says invoices are due monthly.');
    expect(second.content).not.toContain('Alpha irrelevant paragraph');
    expect(second.structured).toMatchObject({
      status: 'cached',
      cached: true,
      promptUsed: true,
      focusApplied: true,
      focusTerms: expect.arrayContaining(['billing', 'invoices', 'policy']),
    });
  });

  it('returns a timeout failure instead of hanging on an unresponsive fetch', async () => {
    vi.useFakeTimers();
    webFetchMock.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));

    const pending = new WebFetchTool().execute({
      url: 'https://timeout-fetch.test/page',
      timeout_ms: 1000,
      retry_attempts: 3,
      use_cache: false,
    }, ctx);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out after 1000ms');
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(result.structured).toMatchObject({
      url: 'https://timeout-fetch.test/page',
      status: 'timeout',
      timeoutMs: 1000,
      attempts: [expect.objectContaining({ attempt: 1, status: 'aborted' })],
    });
  });

  it('returns a timeout failure when the fetch layer ignores abort', async () => {
    vi.useFakeTimers();
    webFetchMock.mockImplementation(() => new Promise(() => {}));

    const pending = new WebFetchTool().execute({
      url: 'https://ignored-abort-fetch.test/page',
      timeout_ms: 1000,
      retry_attempts: 3,
      use_cache: false,
    }, ctx);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out after 1000ms');
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(result.structured).toMatchObject({
      url: 'https://ignored-abort-fetch.test/page',
      status: 'timeout',
      timeoutMs: 1000,
      attempts: [expect.objectContaining({ attempt: 1, status: 'aborted' })],
    });
  });

  it('returns a timeout failure when the response body never finishes', async () => {
    vi.useFakeTimers();
    webFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: vi.fn(() => 'text/plain') },
      text: vi.fn(() => new Promise<string>(() => {})),
      json: vi.fn(),
    });

    const pending = new WebFetchTool().execute({
      url: 'https://timeout-body.test/page',
      timeout_ms: 1000,
      retry_attempts: 1,
      use_cache: false,
    }, ctx);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out after 1000ms');
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(result.structured).toMatchObject({
      url: 'https://timeout-body.test/page',
      status: 'timeout',
      timeoutMs: 1000,
      attempts: [expect.objectContaining({ attempt: 1, status: 'ok' })],
    });
  });

  it('blocks hostnames that resolve to private or loopback addresses before fetching', async () => {
    dnsLookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);

    const result = await new WebFetchTool().execute({ url: 'https://internal.test/' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('SSRF blocked');
    expect(webFetchMock).not.toHaveBeenCalled();
    expect(result.structured).toMatchObject({
      status: 'failed',
      reason: 'ssrf_blocked',
      hostname: 'internal.test',
    });
  });

  it('returns structured HTTP errors without reading the body', async () => {
    const response = fakeResponse('not found', 'text/plain', 404, 'Not Found');
    webFetchMock.mockResolvedValue(response);

    const result = await new WebFetchTool().execute({
      url: 'https://http-error.test/missing',
      use_cache: false,
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('HTTP 404 Not Found');
    expect(response.text).not.toHaveBeenCalled();
    expect(result.structured).toMatchObject({
      status: 'http_error',
      statusCode: 404,
      statusText: 'Not Found',
      attempts: [expect.objectContaining({ attempt: 1, status: 'ok' })],
    });
  });

  it('validates bounds and parameter types before fetching', async () => {
    const tool = new WebFetchTool();

    const badTimeout = await tool.execute({ url: 'https://valid.test/', timeout_ms: 10 }, ctx);
    expect(badTimeout.success).toBe(false);
    expect(badTimeout.errorMessage).toContain('timeout_ms must be at least');

    const badCache = await tool.execute({ url: 'https://valid.test/', use_cache: 'yes' }, ctx);
    expect(badCache.success).toBe(false);
    expect(badCache.errorMessage).toContain('use_cache must be a boolean');

    const fractionalTimeout = await tool.execute({ url: 'https://valid.test/', timeout_ms: 1000.5 }, ctx);
    expect(fractionalTimeout.success).toBe(false);
    expect(fractionalTimeout.errorMessage).toContain('timeout_ms must be an integer');

    const unexpectedParam = await tool.execute({ url: 'https://valid.test/', unused: true }, ctx);
    expect(unexpectedParam.success).toBe(false);
    expect(unexpectedParam.errorMessage).toContain('Unexpected parameter: "unused"');

    expect(webFetchMock).not.toHaveBeenCalled();
  });
});
