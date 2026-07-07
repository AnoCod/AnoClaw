// WebFetchTool - fetches content from a URL and processes it
// Strips HTML tags, scripts, styles to produce readable text.
// Includes a 15-minute cache to avoid repeated fetches.
// RiskLevel: Low (network request, no filesystem effects).

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { promises as dns } from 'node:dns';
import { webFetch } from '../../../infra/network/WebFetchHelper.js';

/** Maximum content length returned from a fetch. */
const MAX_CONTENT_LENGTH = 15000;

/** Cache TTL in milliseconds (15 minutes). */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Simple in-memory cache: URL to { content, timestamp }. */
const _fetchCache = new Map<string, { content: string; timestamp: number }>();

/** Time-bucketed eviction: entries grouped by coarse 5-minute buckets for O(1) expiration. */
const _cacheBuckets = new Map<number, Set<string>>();
const BUCKET_MS = 5 * 60 * 1000; // 5-minute buckets

function _addToCache(key: string, value: { content: string; timestamp: number }): void {
  _fetchCache.set(key, value);
  const bucket = Math.floor(value.timestamp / BUCKET_MS);
  let keys = _cacheBuckets.get(bucket);
  if (!keys) {
    keys = new Set();
    _cacheBuckets.set(bucket, keys);
  }
  keys.add(key);
}

export class WebFetchTool extends Tool {

  static category = 'Search & Web';
  static toolDescription = 'Fetches content from a URL and processes it with an AI model.';
  name(): string {
    return 'WebFetch';
  }

  description(): string {
    return 'Fetch and read content from a URL. Converts HTML to readable text. Fails for authenticated or private URLs. Has a 15-minute cache.';
  }

  prompt(): string {
    return '## WebFetch Usage\n' +
      'Fetch and read a web page. HTML is converted to markdown for readability.\n\n' +
      '**Caching:** Results are cached for 15 minutes. Repeated fetches of the same URL within that window return instantly.\n\n' +
      '**Limitations:** Authenticated URLs (Google Docs, Confluence, GitHub private repos) WILL FAIL. Use specialized MCP tools for authenticated services instead. HTTP is auto-upgraded to HTTPS.\n\n' +
      '**Use the `prompt` parameter** to extract specific information from the page - don\'t just dump the raw content.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch content from',
          format: 'uri',
        },
        prompt: {
          type: 'string',
          description: 'The prompt describing what information to extract from the page',
        },
      },
      required: ['url'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Low;
  }

  isReadOnly(): boolean {
    return true;
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  isAsync(): boolean {
    return true; // Network request
  }

  defaultTimeoutMs(): number {
    return 90000;
  }

  maxRetries(): number {
    return 0;
  }

  outputLimit(): number {
    return 15000; // WebFetch results can be large
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const urlStr = params.url as string;
    const prompt = params.prompt as string | undefined;

    if (!urlStr || typeof urlStr !== 'string') {
      return this.makeError('url is required');
    }

    // Validate URL
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return this.makeError(`Invalid URL: ${urlStr}`);
    }

    // Upgrade HTTP to HTTPS
    if (url.protocol === 'http:') {
      url = new URL(url.href.replace('http://', 'https://'));
    }

    if (url.protocol !== 'https:') {
      return this.makeError(`Unsupported protocol: ${url.protocol}. Only HTTPS is supported.`);
    }

    // SSRF protection: block internal/private IP ranges
    if (await isInternalHostname(url.hostname)) {
      return this.makeError(`SSRF blocked: ${url.hostname} resolves to an internal/private IP address`);
    }

    const startedAt = Date.now();

    // Check cache
    const cached = _fetchCache.get(url.href);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return this.makeResult(
        `[Cached] ${url.href}\n\n${cached.content}`,
        { startedAt },
      );
    }

    // Clean stale cache entries
    cleanCache();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      // Also abort when user interjects (external signal from InterruptController)
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          controller.abort();
        } else {
          ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }

      const response = await fetchWithRetry(url.href, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return this.makeError(
          `HTTP ${response.status} ${response.statusText} for ${url.href}`
        );
      }

      const contentType = response.headers.get('content-type') || '';
      let text: string;

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        const html = await response.text();
        text = stripHtml(html);
      } else if (contentType.includes('text/')) {
        text = await response.text();
      } else if (contentType.includes('application/json')) {
        const json = await response.json();
        text = JSON.stringify(json, null, 2);
      } else {
        // Try text anyway
        text = await response.text();
      }

      const wasTruncated = text.length > MAX_CONTENT_LENGTH;

      // Cache the result
      _addToCache(url.href, { content: text, timestamp: Date.now() });

      return this.makeResult(
        `[${url.href}]\n\n${text}`,
        { startedAt, wasTruncated },
      );
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Distinguish user interrupt from timeout
        if (ctx.signal?.aborted) {
          return this.makeError(`Request cancelled by user for ${url.href}`);
        }
        return this.makeError(`Request timed out for ${url.href}`);
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Fetch failed: ${errMsg}`);
    }
  }

  // ── UI helpers ──

  userFacingName(_input?: Record<string, unknown>): string {
    return 'Fetch';
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (input?.url && typeof input.url === 'string') {
      return this.truncate(input.url, 50);
    }
    return null;
  }

  getActivityDescription(_input?: Record<string, unknown>): string | null {
    return 'Fetching web page';
  }
}

/** Retry wrapper: up to 3 attempts with exponential backoff. */
async function fetchWithRetry(
  url: string,
  opts: { signal: AbortSignal },
): ReturnType<typeof webFetch> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (opts.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return await webFetch(url, opts);
    } catch (err: unknown) {
      lastErr = err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err; // Don't retry user-initiated cancels
      }
      if (attempt < 2) {
        // Exponential backoff: 1s, 2s
        await new Promise((r) => setTimeout(r, 1000 * (1 << attempt)));
      }
    }
  }
  throw lastErr;
}

/** Strip HTML tags, scripts, styles, and common noisy elements. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove stale cache entries using time-bucketed eviction (O(buckets) not O(entries)). */
function cleanCache(): void {
  const now = Date.now();
  const expireBefore = now - CACHE_TTL_MS;
  const expireBucket = Math.floor(expireBefore / BUCKET_MS);
  for (const [bucket, keys] of _cacheBuckets) {
    if (bucket <= expireBucket) {
      for (const key of keys) {
        _fetchCache.delete(key);
      }
      _cacheBuckets.delete(bucket);
    }
  }
}

// ── SSRF protection ──

/** Internal/private IP ranges blocked for SSRF prevention. */
const BLOCKED_IP_RANGES: Array<{ network: Uint8Array; prefix: number; family: 4 | 6 }> = [
  // IPv4
  { network: ip4ToBytes('127.0.0.0'), prefix: 8, family: 4 },     // loopback
  { network: ip4ToBytes('10.0.0.0'), prefix: 8, family: 4 },       // private
  { network: ip4ToBytes('172.16.0.0'), prefix: 12, family: 4 },    // private
  { network: ip4ToBytes('192.168.0.0'), prefix: 16, family: 4 },   // private
  { network: ip4ToBytes('169.254.0.0'), prefix: 16, family: 4 },   // link-local
  { network: ip4ToBytes('0.0.0.0'), prefix: 8, family: 4 },        // current network
  // IPv6
  { network: ip6ToBytes('::1'), prefix: 128, family: 6 },          // loopback
  { network: ip6ToBytes('fc00::'), prefix: 7, family: 6 },         // unique local
  { network: ip6ToBytes('fe80::'), prefix: 10, family: 6 },        // link-local
];

function ip4ToBytes(ip: string): Uint8Array {
  const parts = ip.split('.').map(Number);
  return new Uint8Array(parts);
}

function ip6ToBytes(ip: string): Uint8Array {
  const bytes = new Uint8Array(16);
  const parts = ip.split(':');
  // Handle :: abbreviation by expanding
  let expanded: string[];
  if (ip.includes('::')) {
    const idx = parts.indexOf('');
    const left = parts.slice(0, idx).filter(Boolean);
    const right = parts.slice(idx + 1).filter(Boolean);
    const missing = 8 - left.length - right.length;
    expanded = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    expanded = parts;
  }
  for (let i = 0; i < 8; i++) {
    const val = parseInt(expanded[i] || '0', 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function ipMatchesRange(ipBytes: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const fullBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== network[i]) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((ipBytes[fullBytes] & mask) !== (network[fullBytes] & mask)) return false;
  }
  return true;
}

function isInternalIP(ip: string): boolean {
  if (ip.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 address
    const ip4 = ip.slice(7);
    return isInternalIPv4(ip4);
  }
  if (ip.includes(':')) {
    return isInternalIPv6(ip);
  }
  return isInternalIPv4(ip);
}

function isInternalIPv4(ip: string): boolean {
  const bytes = ip4ToBytes(ip);
  for (const range of BLOCKED_IP_RANGES) {
    if (range.family === 4 && ipMatchesRange(bytes, range.network, range.prefix)) {
      return true;
    }
  }
  return false;
}

function isInternalIPv6(ip: string): boolean {
  const bytes = ip6ToBytes(ip);
  for (const range of BLOCKED_IP_RANGES) {
    if (range.family === 6 && ipMatchesRange(bytes, range.network, range.prefix)) {
      return true;
    }
  }
  return false;
}

/** Resolve hostname and check if any resolved IP is internal. */
async function isInternalHostname(hostname: string): Promise<boolean> {
  // Check raw IPv4/IPv6 literals directly
  if (isIPLiteral(hostname)) {
    return isInternalIP(hostname);
  }
  try {
    const records = await dns.resolve(hostname);
    const ips: string[] = [];
    if (Array.isArray(records)) {
      ips.push(...records);
    }
    for (const ip of ips) {
      if (isInternalIP(ip)) return true;
    }
    return false;
  } catch {
    // DNS resolution failed - allow the fetch (may still fail downstream)
    return false;
  }
}

function isIPLiteral(hostname: string): boolean {
  // Simple check: if it looks like an IP address
  return /^[\d.]+$/.test(hostname) || hostname.includes(':');
}
