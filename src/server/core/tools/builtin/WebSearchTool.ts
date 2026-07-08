// WebSearchTool - performs bounded web searches.
// DuckDuckGo Lite -> DuckDuckGo HTML -> Bing (fallback)

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { webFetch } from '../../../infra/network/WebFetchHelper.js';

const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 10;
const MAX_PARSE_RESULTS = 25;
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 500;
const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const MIN_BACKEND_TIMEOUT_MS = 500;

type SearchResult = { title: string; url: string; snippet: string };
type BackendStatus = 'ok' | 'http_error' | 'no_results' | 'timeout' | 'aborted' | 'network_error' | 'skipped';

interface BackendAttempt {
  backend: string;
  status: BackendStatus;
  durationMs: number;
  timeoutMs: number;
  resultCount?: number;
  statusCode?: number;
  statusText?: string;
  error?: string;
}

interface FetchAttempt extends BackendAttempt {
  response?: Awaited<ReturnType<typeof webFetch>>;
}

/** Fetch with timeout and external abort signal. Keeps the reason for user-visible diagnostics. */
async function fetchWithTimeout(
  backend: string,
  url: string,
  timeoutMs: number,
  extSignal?: AbortSignal,
): Promise<FetchAttempt> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let removeExternalAbort: (() => void) | null = null;

  const finish = (attempt: Omit<FetchAttempt, 'backend' | 'durationMs' | 'timeoutMs'>): FetchAttempt => ({
    backend,
    durationMs: Date.now() - startedAt,
    timeoutMs,
    ...attempt,
  });

  try {
    if (extSignal?.aborted) return finish({ status: 'aborted', error: 'Search cancelled before request started' });

    timeout = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    if (extSignal) {
      const onAbort = () => ctrl.abort();
      extSignal.addEventListener('abort', onAbort, { once: true });
      removeExternalAbort = () => extSignal.removeEventListener('abort', onAbort);
    }

    const resp = await webFetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      return finish({
        status: 'http_error',
        statusCode: resp.status,
        statusText: resp.statusText,
        error: `HTTP ${resp.status} ${resp.statusText}`,
      });
    }
    return finish({ status: 'ok', response: resp });
  } catch (err: unknown) {
    if (extSignal?.aborted) {
      return finish({ status: 'aborted', error: 'Search cancelled by user' });
    }
    if (timedOut || (err instanceof DOMException && err.name === 'AbortError')) {
      return finish({ status: 'timeout', error: `Timed out after ${timeoutMs}ms` });
    }
    return finish({ status: 'network_error', error: errorMessage(err) });
  } finally {
    if (timeout) clearTimeout(timeout);
    removeExternalAbort?.();
  }
}

export class WebSearchTool extends Tool {

  static category = 'Search & Web';
  static toolDescription = 'Searches the web and returns results to inform responses.';

  name(): string { return 'WebSearch'; }

  description(): string {
    return 'Search the web for up-to-date information. Supports domain filtering, bounded timeouts, and multiple search backends. Returns up to 10 results.';
  }

  prompt(): string {
    return '## WebSearch Usage\n' +
      'Search the web for information beyond your knowledge cutoff or for current events.\n\n' +
      '**When to search:** Current events or recent data. Verifying facts you\'re unsure about. Documentation that may have changed. APIs or libraries released after your training cutoff.\n\n' +
      '**When NOT to search:** Basic programming concepts. Well-established facts. Information you\'re confident about. Things you can learn by reading project files.\n\n' +
      '**Result limit:** Returns up to ' + MAX_RESULTS + ' results per search. Use `max_results` for shorter output. For more comprehensive searches, consider multiple queries with different terms.\n\n' +
      '**Timeouts:** The tool has its own total timeout budget and returns clear backend diagnostics instead of hanging indefinitely. Use `timeout_ms` only when a search is expected to be slow.\n\n' +
      '**Domain filtering:** Use allowed_domains to restrict results (e.g. "docs.python.org"). Use blocked_domains to exclude spammy sources.\n\n' +
      'After searching, cite your sources as markdown links in your response.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: MIN_QUERY_CHARS, maxLength: MAX_QUERY_CHARS, pattern: '\\S', description: `The search query to use (${MIN_QUERY_CHARS}-${MAX_QUERY_CHARS} chars after trimming)` },
        allowed_domains: { type: 'array', items: { type: 'string', minLength: 1, pattern: '\\S' }, description: 'Only include results from these domains or their subdomains' },
        blocked_domains: { type: 'array', items: { type: 'string', minLength: 1, pattern: '\\S' }, description: 'Never include results from these domains or their subdomains' },
        max_results: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: `Maximum results to return. Default ${DEFAULT_RESULTS}, max ${MAX_RESULTS}.` },
        timeout_ms: { type: 'integer', minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS, description: `Total search timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
      },
      required: ['query'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Low; }
  isReadOnly(): boolean { return true; }
  isConcurrencySafe(): boolean { return true; }
  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }
  isAsync(): boolean { return true; }
  defaultTimeoutMs(): number { return MAX_TIMEOUT_MS + 5000; }
  maxRetries(): number { return 0; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const queryResult = normalizeQuery(params.query);
    if (queryResult.error) return this.makeError(queryResult.error);
    const query = queryResult.value as string;

    const maxResultsResult = normalizeInteger(params.max_results, 'max_results', DEFAULT_RESULTS, 1, MAX_RESULTS);
    if (maxResultsResult.error) return this.makeError(maxResultsResult.error);
    const maxResults = maxResultsResult.value as number;

    const timeoutResult = normalizeInteger(params.timeout_ms, 'timeout_ms', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (timeoutResult.error) return this.makeError(timeoutResult.error);
    const timeoutMs = timeoutResult.value as number;

    const allowedResult = normalizeDomains(params.allowed_domains, 'allowed_domains');
    if (allowedResult.error) return this.makeError(allowedResult.error);
    const allowedDomains = allowedResult.value as string[];

    const blockedResult = normalizeDomains(params.blocked_domains, 'blocked_domains');
    if (blockedResult.error) return this.makeError(blockedResult.error);
    const blockedDomains = blockedResult.value as string[];

    const startedAt = Date.now();
    const encoded = encodeURIComponent(query);
    const deadline = startedAt + timeoutMs;
    const attempts: BackendAttempt[] = [];

    const backends: Array<{
      name: string;
      maxTimeoutMs: number;
      run: (encodedQuery: string, backendTimeoutMs: number, signal?: AbortSignal) => Promise<{ results: SearchResult[] | null; attempt: BackendAttempt }>;
    }> = [
      { name: 'DuckDuckGo Lite', maxTimeoutMs: 8000, run: (q, t, s) => this._tryDdgLite(q, t, s) },
      { name: 'DuckDuckGo HTML', maxTimeoutMs: 8000, run: (q, t, s) => this._tryDdgHtml(q, t, s) },
      { name: 'Bing', maxTimeoutMs: 12000, run: (q, t, s) => this._tryBing(q, t, s) },
    ];

    let results: SearchResult[] | null = null;
    for (const backend of backends) {
      if (ctx.signal?.aborted) {
        attempts.push({
          backend: backend.name,
          status: 'aborted',
          durationMs: 0,
          timeoutMs: 0,
          error: 'Search cancelled before this backend started',
        });
        break;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs < MIN_BACKEND_TIMEOUT_MS) {
        attempts.push({
          backend: backend.name,
          status: 'skipped',
          durationMs: 0,
          timeoutMs: Math.max(0, remainingMs),
          error: 'Skipped because the total search timeout budget was exhausted',
        });
        break;
      }

      const backendTimeoutMs = Math.min(backend.maxTimeoutMs, remainingMs);
      const attemptResult = await backend.run(encoded, backendTimeoutMs, ctx.signal);
      attempts.push(attemptResult.attempt);
      if (attemptResult.results?.length) {
        results = attemptResult.results;
        break;
      }
      if (attemptResult.attempt.status === 'aborted') break;
    }

    const durationMs = Date.now() - startedAt;
    const terminalStatus = classifyTerminalStatus(attempts, results);

    if (!results) {
      const message = terminalStatus === 'aborted'
        ? `Search cancelled by user for: ${query}`
        : terminalStatus === 'timeout'
          ? `Search timed out after ${timeoutMs}ms for: ${query}. ${summarizeAttempts(attempts)}`
          : `Search failed for: ${query}. ${summarizeAttempts(attempts)} Check network/proxy or try a narrower query.`;
      return this.makeError(message, {
        startedAt,
        finishedAt: Date.now(),
        durationMs,
        structured: {
          query,
          status: terminalStatus,
          timeoutMs,
          durationMs,
          backendAttempts: attempts,
        },
      });
    }

    const unfilteredResultCount = results.length;

    // Domain filtering
    let filtered = results;
    if (allowedDomains.length) {
      filtered = filtered.filter(r => allowedDomains.some(d => domainMatches(_domain(r.url), d)));
    }
    if (blockedDomains.length) {
      filtered = filtered.filter(r => !blockedDomains.some(d => domainMatches(_domain(r.url), d)));
    }

    filtered = filtered.slice(0, maxResults);
    const structured = {
      query,
      status: filtered.length ? 'ok' : 'no_results',
      timeoutMs,
      durationMs,
      maxResults,
      resultCount: filtered.length,
      unfilteredResultCount,
      filters: {
        allowedDomains,
        blockedDomains,
      },
      backendAttempts: attempts,
      results: filtered,
    };

    if (!filtered.length) {
      return this.makeResult(
        `(no results after filtering)\nSearched for: ${query}\n${summarizeAttempts(attempts)}`,
        { startedAt, finishedAt: Date.now(), durationMs, structured },
      );
    }

    return this.makeResult(
      filtered.map(r => `${r.title}\n  ${r.url}\n  ${r.snippet}`).join('\n\n'),
      { startedAt, finishedAt: Date.now(), durationMs, structured },
    );
  }

  // ── Backend: DuckDuckGo Lite ──
  private async _tryDdgLite(encoded: string, timeoutMs: number, extSignal?: AbortSignal): Promise<{ results: SearchResult[] | null; attempt: BackendAttempt }> {
    const fetchAttempt = await fetchWithTimeout('DuckDuckGo Lite', `https://lite.duckduckgo.com/lite/?q=${encoded}`, timeoutMs, extSignal);
    if (fetchAttempt.status !== 'ok' || !fetchAttempt.response) return { results: null, attempt: stripResponse(fetchAttempt) };
    const resp = fetchAttempt.response;
    const html = await resp.text();
    const results: SearchResult[] = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(html)) !== null && results.length < MAX_PARSE_RESULTS) {
      const linkRe = /<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/i;
      const lm = linkRe.exec(m[1]);
      if (!lm) continue;
      const url = normalizeSearchUrl(lm[1]);
      if (!url) continue;
      const title = htmlToText(lm[2]);
      if (!title || title === 'Web Results') continue;
      const snipRe = /<span[^>]*class="link-text"[^>]*>([\s\S]*?)<\/span>/i;
      const sm = snipRe.exec(m[1]);
      results.push({ title, url, snippet: sm ? htmlToText(sm[1]).slice(0, 300) : '' });
    }
    return {
      results: results.length > 0 ? results : null,
      attempt: {
        ...stripResponse(fetchAttempt),
        status: results.length > 0 ? 'ok' : 'no_results',
        resultCount: results.length,
      },
    };
  }

  // ── Backend: DuckDuckGo HTML ──
  private async _tryDdgHtml(encoded: string, timeoutMs: number, extSignal?: AbortSignal): Promise<{ results: SearchResult[] | null; attempt: BackendAttempt }> {
    const fetchAttempt = await fetchWithTimeout('DuckDuckGo HTML', `https://html.duckduckgo.com/html/?q=${encoded}`, timeoutMs, extSignal);
    if (fetchAttempt.status !== 'ok' || !fetchAttempt.response) return { results: null, attempt: stripResponse(fetchAttempt) };
    const resp = fetchAttempt.response;
    const html = await resp.text();
    const results: SearchResult[] = [];
    const linkG = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
    const links: Array<{ url: string; title: string }> = [];
    let m;
    while ((m = linkG.exec(html)) !== null && links.length < MAX_PARSE_RESULTS) {
      const url = normalizeSearchUrl(m[1]);
      const title = htmlToText(m[2]);
      if (url && title) links.push({ url, title });
    }
    const snipG = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippets: string[] = [];
    let sm;
    while ((sm = snipG.exec(html)) !== null && snippets.length < MAX_PARSE_RESULTS) {
      snippets.push(htmlToText(sm[1]).slice(0, 300));
    }
    for (let i = 0; i < links.length; i++) {
      results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' });
    }
    return {
      results: results.length > 0 ? results : null,
      attempt: {
        ...stripResponse(fetchAttempt),
        status: results.length > 0 ? 'ok' : 'no_results',
        resultCount: results.length,
      },
    };
  }

  // ── Backend: Bing (fallback when DuckDuckGo is unreachable) ──
  private async _tryBing(encoded: string, timeoutMs: number, extSignal?: AbortSignal): Promise<{ results: SearchResult[] | null; attempt: BackendAttempt }> {
    const fetchAttempt = await fetchWithTimeout('Bing', `https://www.bing.com/search?q=${encoded}&count=${MAX_PARSE_RESULTS}`, timeoutMs, extSignal);
    if (fetchAttempt.status !== 'ok' || !fetchAttempt.response) return { results: null, attempt: stripResponse(fetchAttempt) };
    const resp = fetchAttempt.response;
    const html = await resp.text();

    // Bing structure: <li class="b_algo"> ... <a href="...">title</a> ... text ... </li>
    const results: SearchResult[] = [];
    const blockRe = /<li\s[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = blockRe.exec(html)) !== null && results.length < MAX_PARSE_RESULTS) {
      const linkRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const lm = linkRe.exec(m[1]);
      if (!lm || lm[1].includes('go.microsoft.com')) continue;
      const title = htmlToText(lm[2]);
      if (!title) continue;
      const afterLink = m[1].slice(m[1].indexOf(lm[0]) + lm[0].length);
      const snippet = htmlToText(afterLink).slice(0, 300);
      results.push({ title, url: lm[1], snippet });
    }
    return {
      results: results.length > 0 ? results : null,
      attempt: {
        ...stripResponse(fetchAttempt),
        status: results.length > 0 ? 'ok' : 'no_results',
        resultCount: results.length,
      },
    };
  }

  userFacingName(): string { return 'Web Search'; }
  getToolUseSummary(input?: Record<string, unknown>): string | null {
    return input?.query && typeof input.query === 'string' ? this.truncate(input.query, 50) : null;
  }
  getActivityDescription(): string | null { return 'Searching the web'; }
}

function _domain(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return url.toLowerCase(); }
}

function normalizeQuery(value: unknown): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: 'query is required' };
  const query = value.replace(/\s+/g, ' ').trim();
  if (query.length < MIN_QUERY_CHARS) return { error: `query must be at least ${MIN_QUERY_CHARS} characters after trimming` };
  if (query.length > MAX_QUERY_CHARS) return { error: `query must be ${MAX_QUERY_CHARS} characters or less` };
  return { value: query };
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

function normalizeDomains(value: unknown, name: string): { value: string[]; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: `${name} must be an array of domain strings` };
  const domains: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return { error: `${name} must contain only strings` };
    const domain = item.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  return { value: domains };
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeSearchUrl(raw: string): string | null {
  let url = htmlDecode(raw.trim());
  if (url.startsWith('//')) url = 'https:' + url;
  const uddg = url.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      url = decodeURIComponent(uddg[1]);
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function htmlToText(value: string): string {
  return htmlDecode(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlDecode(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripResponse(attempt: FetchAttempt): BackendAttempt {
  const { response: _response, ...rest } = attempt;
  return rest;
}

function classifyTerminalStatus(attempts: BackendAttempt[], results: SearchResult[] | null): 'failed' | 'timeout' | 'aborted' {
  if (results) return 'failed';
  if (attempts.some(a => a.status === 'aborted')) return 'aborted';
  if (attempts.length && attempts.every(a => a.status === 'timeout' || a.status === 'skipped')) return 'timeout';
  if (attempts.some(a => a.status === 'timeout') && attempts[attempts.length - 1]?.status === 'skipped') return 'timeout';
  return 'failed';
}

function summarizeAttempts(attempts: BackendAttempt[]): string {
  if (!attempts.length) return 'No search backend was attempted.';
  return 'Backends: ' + attempts.map(a => {
    const details = a.statusCode ? ` HTTP ${a.statusCode}` : a.error ? ` ${a.error}` : '';
    return `${a.backend}=${a.status}${details}`;
  }).join('; ') + '.';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
