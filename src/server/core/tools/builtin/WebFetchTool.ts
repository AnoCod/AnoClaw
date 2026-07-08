// WebFetchTool - fetches bounded URL content with cache, timeout, and diagnostics.
// Strips HTML tags, scripts, styles to produce readable text.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { promises as dns } from 'node:dns';
import { webFetch } from '../../../infra/network/WebFetchHelper.js';

const DEFAULT_MAX_CONTENT_CHARS = 15000;
const MIN_MAX_CONTENT_CHARS = 100;
const MAX_MAX_CONTENT_CHARS = 80000;
const DEFAULT_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 90000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_PROMPT_CHARS = 1000;
const MAX_CACHE_CONTENT_CHARS = 200000;
const DNS_TIMEOUT_MS = 5000;

/** Cache TTL in milliseconds (15 minutes). */
const CACHE_TTL_MS = 15 * 60 * 1000;

type FetchStatus = 'ok' | 'cached' | 'http_error' | 'timeout' | 'aborted' | 'failed';
type FetchAttemptStatus = 'ok' | 'network_error' | 'aborted';

interface CacheEntry {
  text: string;
  timestamp: number;
  contentType: string;
  sourceChars: number;
}

interface FetchAttempt {
  attempt: number;
  status: FetchAttemptStatus;
  durationMs: number;
  error?: string;
}

class FetchAttemptError extends Error {
  constructor(
    message: string,
    readonly attempts: FetchAttempt[],
    readonly causeError?: unknown,
  ) {
    super(message);
    this.name = 'FetchAttemptError';
  }
}

/** Simple in-memory cache: normalized URL to fetched readable text. */
const _fetchCache = new Map<string, CacheEntry>();

/** Time-bucketed eviction: entries grouped by coarse 5-minute buckets for O(1) expiration. */
const _cacheBuckets = new Map<number, Set<string>>();
const BUCKET_MS = 5 * 60 * 1000; // 5-minute buckets

function _addToCache(key: string, value: CacheEntry): void {
  for (const keys of _cacheBuckets.values()) {
    keys.delete(key);
  }

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
  static toolDescription = 'Fetches bounded readable content from a URL with cache, timeout, and diagnostics.';
  name(): string {
    return 'WebFetch';
  }

  description(): string {
    return 'Fetch and read content from a URL. Converts HTML/JSON/text to bounded readable text, supports cache, focused excerpts, timeout controls, and structured failure feedback.';
  }

  prompt(): string {
    return '## WebFetch Usage\n' +
      'Fetch and read a web page. HTML is converted to markdown for readability.\n\n' +
      '**Caching:** Results are cached for 15 minutes by default. Set `use_cache: false` when freshness matters more than speed.\n\n' +
      '**Bound output:** Use `max_content_chars` when you only need a preview. Oversized pages are truncated with metadata instead of flooding the context.\n\n' +
      '**Timeouts:** Use `timeout_ms` for slow sites. Timeouts and user interrupts return clear failure states.\n\n' +
      '**Limitations:** Authenticated URLs (Google Docs, Confluence, GitHub private repos) WILL FAIL. Use specialized MCP tools for authenticated services instead. HTTP is auto-upgraded to HTTPS.\n\n' +
      '**Use the `prompt` parameter** to focus the returned excerpts on relevant terms instead of dumping the full page.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'The URL to fetch content from',
          format: 'uri',
        },
        prompt: {
          type: 'string',
          maxLength: MAX_PROMPT_CHARS,
          description: `Optional prompt describing what information to extract or focus on (max ${MAX_PROMPT_CHARS} chars)`,
        },
        max_content_chars: {
          type: 'integer',
          minimum: MIN_MAX_CONTENT_CHARS,
          maximum: MAX_MAX_CONTENT_CHARS,
          description: `Maximum content characters returned. Default ${DEFAULT_MAX_CONTENT_CHARS}, max ${MAX_MAX_CONTENT_CHARS}.`,
        },
        timeout_ms: {
          type: 'integer',
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          description: `Total fetch timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
        },
        retry_attempts: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RETRY_ATTEMPTS,
          description: `Number of network attempts. Default ${DEFAULT_RETRY_ATTEMPTS}, max ${MAX_RETRY_ATTEMPTS}.`,
        },
        use_cache: {
          type: 'boolean',
          description: 'Use the 15-minute in-memory cache when available. Default true.',
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
    return MAX_TIMEOUT_MS + 5000;
  }

  maxRetries(): number {
    return 0;
  }

  outputLimit(): number {
    return MAX_MAX_CONTENT_CHARS + 5000; // WebFetch results can be large but bounded by params.
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();

    const urlResult = normalizeUrl(params.url);
    if (urlResult.error) return this.makeError(urlResult.error);
    const url = urlResult.value as URL;

    const promptResult = normalizeOptionalString(params.prompt, 'prompt', MAX_PROMPT_CHARS);
    if (promptResult.error) return this.makeError(promptResult.error);
    const prompt = promptResult.value;

    const maxContentResult = normalizeInteger(params.max_content_chars, 'max_content_chars', DEFAULT_MAX_CONTENT_CHARS, MIN_MAX_CONTENT_CHARS, MAX_MAX_CONTENT_CHARS);
    if (maxContentResult.error) return this.makeError(maxContentResult.error);
    const maxContentChars = maxContentResult.value as number;

    const timeoutResult = normalizeInteger(params.timeout_ms, 'timeout_ms', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (timeoutResult.error) return this.makeError(timeoutResult.error);
    const timeoutMs = timeoutResult.value as number;

    const retryResult = normalizeInteger(params.retry_attempts, 'retry_attempts', DEFAULT_RETRY_ATTEMPTS, 1, MAX_RETRY_ATTEMPTS);
    if (retryResult.error) return this.makeError(retryResult.error);
    const retryAttempts = retryResult.value as number;

    const cacheResult = normalizeBoolean(params.use_cache, 'use_cache', true);
    if (cacheResult.error) return this.makeError(cacheResult.error);
    const useCache = cacheResult.value as boolean;

    // SSRF protection: block internal/private IP ranges before any network fetch.
    if (await isInternalHostname(url.hostname)) {
      return this.makeError(`SSRF blocked: ${url.hostname} resolves to an internal/private IP address`, {
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        structured: {
          url: url.href,
          status: 'failed',
          reason: 'ssrf_blocked',
          hostname: url.hostname,
        },
      });
    }

    // Check cache
    const cached = useCache ? _fetchCache.get(url.href) : undefined;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const rendered = renderFetchedContent({
        url: url.href,
        text: cached.text,
        sourceChars: cached.sourceChars,
        contentType: cached.contentType,
        maxContentChars,
        prompt,
        cached: true,
      });
      return this.makeResult(rendered.content, {
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        wasTruncated: rendered.wasTruncated,
        structured: {
          url: url.href,
          status: 'cached' satisfies FetchStatus,
          cached: true,
          cacheAgeMs: Date.now() - cached.timestamp,
          contentType: cached.contentType,
          timeoutMs,
          retryAttempts,
          maxContentChars,
          sourceChars: cached.sourceChars,
          returnedChars: rendered.returnedChars,
          wasTruncated: rendered.wasTruncated,
          promptUsed: Boolean(prompt),
          focusApplied: rendered.focusApplied,
          focusTerms: rendered.focusTerms,
          attempts: [],
        },
      });
    }

    // Clean stale cache entries
    cleanCache();

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let removeExternalAbort: (() => void) | null = null;
    const controller = new AbortController();

    try {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      // Also abort when user interjects (external signal from InterruptController)
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          controller.abort();
        } else {
          const onAbort = () => controller.abort();
          ctx.signal.addEventListener('abort', onAbort, { once: true });
          removeExternalAbort = () => ctx.signal?.removeEventListener('abort', onAbort);
        }
      }

      const { response, attempts } = await fetchWithRetry(url.href, { signal: controller.signal }, retryAttempts);

      if (!response.ok) {
        return this.makeError(`HTTP ${response.status} ${response.statusText} for ${url.href}`, {
          startedAt,
          finishedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          structured: {
            url: url.href,
            status: 'http_error' satisfies FetchStatus,
            cached: false,
            statusCode: response.status,
            statusText: response.statusText,
            timeoutMs,
            retryAttempts,
            attempts,
          },
        });
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const text = await responseToReadableText(response, contentType);
      const sourceChars = text.length;
      const cacheText = text.length > MAX_CACHE_CONTENT_CHARS ? text.slice(0, MAX_CACHE_CONTENT_CHARS) : text;

      // Cache the result
      if (useCache) {
        _addToCache(url.href, {
          text: cacheText,
          timestamp: Date.now(),
          contentType,
          sourceChars,
        });
      }

      const rendered = renderFetchedContent({
        url: url.href,
        text,
        sourceChars,
        contentType,
        maxContentChars,
        prompt,
        cached: false,
      });

      return this.makeResult(rendered.content, {
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        wasTruncated: rendered.wasTruncated,
        structured: {
          url: url.href,
          status: 'ok' satisfies FetchStatus,
          cached: false,
          contentType,
          timeoutMs,
          retryAttempts,
          maxContentChars,
          sourceChars,
          returnedChars: rendered.returnedChars,
          wasTruncated: rendered.wasTruncated,
          promptUsed: Boolean(prompt),
          focusApplied: rendered.focusApplied,
          focusTerms: rendered.focusTerms,
          attempts,
        },
      });
    } catch (err: unknown) {
      const attempts = err instanceof FetchAttemptError ? err.attempts : [];
      const status: FetchStatus = ctx.signal?.aborted ? 'aborted' : timedOut ? 'timeout' : 'failed';
      const errMsg = errorMessage(err instanceof FetchAttemptError && err.causeError ? err.causeError : err);
      const message = status === 'aborted'
        ? `Request cancelled by user for ${url.href}`
        : status === 'timeout'
          ? `Request timed out after ${timeoutMs}ms for ${url.href}`
          : `Fetch failed for ${url.href}: ${errMsg}`;
      return this.makeError(message, {
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        structured: {
          url: url.href,
          status,
          cached: false,
          timeoutMs,
          retryAttempts,
          attempts,
          error: errMsg,
        },
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      removeExternalAbort?.();
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
  maxAttempts: number,
): Promise<{ response: Awaited<ReturnType<typeof webFetch>>; attempts: FetchAttempt[] }> {
  let lastErr: unknown;
  const attempts: FetchAttempt[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      if (opts.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const response = await webFetch(url, opts);
      attempts.push({ attempt, status: 'ok', durationMs: Date.now() - startedAt });
      return { response, attempts };
    } catch (err: unknown) {
      lastErr = err;
      if (err instanceof DOMException && err.name === 'AbortError') {
        attempts.push({ attempt, status: 'aborted', durationMs: Date.now() - startedAt, error: 'Aborted' });
        throw new FetchAttemptError('Fetch aborted', attempts, err);
      }
      attempts.push({ attempt, status: 'network_error', durationMs: Date.now() - startedAt, error: errorMessage(err) });
      if (attempt < maxAttempts) {
        // Exponential backoff: 1s, 2s
        try {
          await abortableDelay(1000 * (1 << (attempt - 1)), opts.signal);
        } catch (abortErr) {
          throw new FetchAttemptError('Fetch aborted during retry backoff', attempts, abortErr);
        }
      }
    }
  }
  throw new FetchAttemptError(errorMessage(lastErr), attempts, lastErr);
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function responseToReadableText(
  response: Awaited<ReturnType<typeof webFetch>>,
  contentType: string,
): Promise<string> {
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    return stripHtml(await response.text());
  }

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.stringify(await response.json(), null, 2);
    } catch {
      return await response.text();
    }
  }

  return await response.text();
}

interface RenderInput {
  url: string;
  text: string;
  sourceChars: number;
  contentType: string;
  maxContentChars: number;
  prompt?: string;
  cached: boolean;
}

interface RenderedContent {
  content: string;
  returnedChars: number;
  wasTruncated: boolean;
  focusApplied: boolean;
  focusTerms: string[];
}

function renderFetchedContent(input: RenderInput): RenderedContent {
  const focused = input.prompt ? focusContent(input.text, input.prompt, input.maxContentChars) : null;
  const selected = focused ?? truncateContent(input.text, input.maxContentChars);
  const sourceLabel = input.cached ? '[Cached]' : '[Fetched]';
  const contentType = input.contentType || 'unknown';
  const meta = [
    `${sourceLabel} ${input.url}`,
    `Content-Type: ${contentType}`,
    `Characters: ${selected.content.length}/${input.sourceChars}${selected.wasTruncated ? ' (truncated)' : ''}`,
  ];
  if (focused?.focusApplied) {
    meta.push(`Focused terms: ${focused.focusTerms.join(', ')}`);
  }

  return {
    content: `${meta.join('\n')}\n\n${selected.content}`,
    returnedChars: selected.content.length,
    wasTruncated: selected.wasTruncated,
    focusApplied: Boolean(focused?.focusApplied),
    focusTerms: focused?.focusTerms ?? [],
  };
}

function truncateContent(text: string, maxChars: number): { content: string; wasTruncated: boolean } {
  if (text.length <= maxChars) return { content: text, wasTruncated: false };
  return { content: text.slice(0, maxChars).trimEnd(), wasTruncated: true };
}

function focusContent(
  text: string,
  prompt: string,
  maxChars: number,
): { content: string; wasTruncated: boolean; focusApplied: boolean; focusTerms: string[] } {
  const terms = extractFocusTerms(prompt);
  if (!terms.length) {
    const truncated = truncateContent(text, maxChars);
    return { ...truncated, focusApplied: false, focusTerms: [] };
  }

  const chunks = splitIntoChunks(text);
  const scored = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: scoreChunk(chunk, terms),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!scored.length) {
    const truncated = truncateContent(text, maxChars);
    return { ...truncated, focusApplied: false, focusTerms: terms };
  }

  const selected = scored.slice(0, 12).sort((a, b) => a.index - b.index);
  const excerpts: string[] = [];
  let used = 0;
  for (const item of selected) {
    const prefix = excerpts.length ? '\n\n...\n\n' : '';
    const remaining = maxChars - used - prefix.length;
    if (remaining <= 0) break;
    const chunk = item.chunk.length > remaining ? item.chunk.slice(0, remaining).trimEnd() : item.chunk;
    excerpts.push(prefix + chunk);
    used += prefix.length + chunk.length;
  }

  const content = excerpts.join('');
  return {
    content,
    wasTruncated: content.length < text.length,
    focusApplied: true,
    focusTerms: terms,
  };
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'because', 'before', 'being',
  'between', 'could', 'describe', 'extract', 'find', 'from', 'have', 'into',
  'more', 'only', 'page', 'please', 'should', 'show', 'that', 'their', 'there',
  'these', 'thing', 'this', 'what', 'when', 'where', 'which', 'with', 'would',
]);

function extractFocusTerms(prompt: string): string[] {
  const terms: string[] = [];
  for (const match of prompt.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    const term = match[0];
    if (!STOPWORDS.has(term) && !terms.includes(term)) terms.push(term);
    if (terms.length >= 20) break;
  }
  return terms;
}

function splitIntoChunks(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const chunks = normalized
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map(chunk => chunk.trim())
    .filter(Boolean);
  if (chunks.length > 1) return chunks;

  const windows: string[] = [];
  for (let i = 0; i < normalized.length; i += 700) {
    windows.push(normalized.slice(i, i + 700).trim());
  }
  return windows.filter(Boolean);
}

function scoreChunk(chunk: string, terms: string[]): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const occurrences = lower.split(term).length - 1;
    score += occurrences * Math.min(term.length, 12);
  }
  return score;
}

function normalizeUrl(value: unknown): { value: URL; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'url is required' };
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: `Invalid URL: ${value}` };
  }

  if (url.protocol === 'http:') {
    url = new URL(url.href.replace(/^http:\/\//i, 'https://'));
  }

  if (url.protocol !== 'https:') {
    return { error: `Unsupported protocol: ${url.protocol}. Only HTTPS is supported.` };
  }

  return { value: url };
}

function normalizeOptionalString(
  value: unknown,
  name: string,
  maxChars: number,
): { value?: string; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return { value: undefined };
  if (normalized.length > maxChars) return { error: `${name} must be ${maxChars} characters or less` };
  return { value: normalized };
}

function normalizeInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
  const integer = Math.trunc(value);
  if (integer < min) return { error: `${name} must be at least ${min}` };
  if (integer > max) return { error: `${name} must be ${max} or less` };
  return { value: integer };
}

function normalizeBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'boolean') return { error: `${name} must be a boolean` };
  return { value };
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
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove stale cache entries using time-bucketed eviction (O(buckets) not O(entries)). */
function cleanCache(): void {
  const now = Date.now();
  for (const [bucket, keys] of _cacheBuckets) {
    for (const key of Array.from(keys)) {
      const entry = _fetchCache.get(key);
      if (!entry || now - entry.timestamp >= CACHE_TTL_MS) {
        _fetchCache.delete(key);
        keys.delete(key);
      }
    }
    if (!keys.size) {
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
  const normalizedHostname = normalizeHostname(hostname);
  // Check raw IPv4/IPv6 literals directly
  if (isIPLiteral(normalizedHostname)) {
    return isInternalIP(normalizedHostname);
  }

  try {
    const records = await withTimeout(
      dns.lookup(normalizedHostname, { all: true, verbatim: true }),
      DNS_TIMEOUT_MS,
    );
    for (const record of records) {
      if (isInternalIP(record.address)) return true;
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

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`DNS lookup timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
