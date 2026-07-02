/**
 * Shared network helper for web-facing tools (WebSearch, WebFetch).
 *
 * Provides a clean browser User-Agent to avoid bot detection.
 * Proxy support: Node 24+ global fetch honours HTTP_PROXY/HTTPS_PROXY env vars.
 */
import { LogManager } from '../logging/LogManager.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let _logged = false;
function logProxyOnce(): void {
  if (_logged) return;
  _logged = true;
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (p) {
    LogManager.getInstance()
      .logger('anochat.tools')
      .info('Web tools using proxy', { proxy: p.replace(/\/\/.*@/, '//***@') });
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Fetch a URL with a clean browser User-Agent. Proxy via env vars if set. */
export async function webFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  logProxyOnce();
  return fetch(url, {
    signal: opts.signal,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(opts.headers || {}),
    },
  });
}

