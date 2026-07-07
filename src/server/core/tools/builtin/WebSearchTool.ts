// WebSearchTool - performs web searches
// DuckDuckGo Lite -> DuckDuckGo HTML -> Bing (fallback)

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { webFetch } from '../../../infra/network/WebFetchHelper.js';

const MAX_RESULTS = 10;

/** Fetch with timeout and external abort signal. Returns null on failure. */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  extSignal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof webFetch>> | null> {
  try {
    if (extSignal?.aborted) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (extSignal) {
      if (extSignal.aborted) { ctrl.abort(); clearTimeout(t); return null; }
      extSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    const resp = await webFetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return resp;
  } catch {
    return null;
  }
}

export class WebSearchTool extends Tool {

  static category = 'Search & Web';
  static toolDescription = 'Searches the web and returns results to inform responses.';

  name(): string { return 'WebSearch'; }

  description(): string {
    return 'Search the web for up-to-date information. Supports domain filtering. Uses multiple search backends. Returns up to 10 results.';
  }

  prompt(): string {
    return '## WebSearch Usage\n' +
      'Search the web for information beyond your knowledge cutoff or for current events.\n\n' +
      '**When to search:** Current events or recent data. Verifying facts you\'re unsure about. Documentation that may have changed. APIs or libraries released after your training cutoff.\n\n' +
      '**When NOT to search:** Basic programming concepts. Well-established facts. Information you\'re confident about. Things you can learn by reading project files.\n\n' +
      '**Result limit:** Returns up to ' + MAX_RESULTS + ' results per search. For more comprehensive searches, consider multiple queries with different terms.\n\n' +
      '**Domain filtering:** Use allowed_domains to restrict results (e.g. "docs.python.org"). Use blocked_domains to exclude spammy sources.\n\n' +
      'After searching, cite your sources as markdown links in your response.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to use' },
        allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' },
        blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include results from these domains' },
      },
      required: ['query'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Low; }
  isReadOnly(): boolean { return true; }
  isConcurrencySafe(): boolean { return true; }
  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Cancel; }
  isAsync(): boolean { return true; }
  defaultTimeoutMs(): number { return 15000; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const query = params.query as string;
    const allowedDomains = params.allowed_domains as string[] | undefined;
    const blockedDomains = params.blocked_domains as string[] | undefined;

    if (!query || typeof query !== 'string') return this.makeError('query is required');

    const startedAt = Date.now();
    const encoded = encodeURIComponent(query);

    // Try backends in order - bail early if interrupted between backends
    let results = await this._tryDdgLite(encoded, ctx.signal);
    if (!results && !ctx.signal?.aborted) results = await this._tryDdgHtml(encoded, ctx.signal);
    if (!results && !ctx.signal?.aborted) results = await this._tryBing(encoded, ctx.signal);

    if (!results) {
      return this.makeError(`Search failed for: ${query}. All backends unreachable. Check network/proxy.`);
    }

    // Domain filtering
    let filtered = results;
    if (allowedDomains?.length) {
      filtered = filtered.filter(r => allowedDomains.some(d => _domain(r.url).includes(d)));
    }
    if (blockedDomains?.length) {
      filtered = filtered.filter(r => !blockedDomains.some(d => _domain(r.url).includes(d)));
    }

    if (!filtered.length) return this.makeResult('(no results)', { startedAt });

    return this.makeResult(
      filtered.map(r => `${r.title}\n  ${r.url}\n  ${r.snippet}`).join('\n\n'),
      { startedAt },
    );
  }

  // ── Backend: DuckDuckGo Lite ──
  private async _tryDdgLite(encoded: string, extSignal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }> | null> {
    const resp = await fetchWithTimeout(`https://lite.duckduckgo.com/lite/?q=${encoded}`, 8000, extSignal);
    if (!resp || !resp.ok) return null;
    const html = await resp.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = rowRe.exec(html)) !== null && results.length < MAX_RESULTS) {
      const linkRe = /<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/i;
      const lm = linkRe.exec(m[1]);
      if (!lm) continue;
      let url = lm[1];
      if (url.startsWith('//')) url = 'https:' + url;
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!url.startsWith('http')) continue;
      const title = lm[2].replace(/<[^>]+>/g, '').trim();
      if (!title || title === 'Web Results') continue;
      const snipRe = /<span[^>]*class="link-text"[^>]*>([\s\S]*?)<\/span>/i;
      const sm = snipRe.exec(m[1]);
      results.push({ title, url, snippet: sm ? sm[1].replace(/<[^>]+>/g, '').trim() : '' });
    }
    return results.length > 0 ? results : null;
  }

  // ── Backend: DuckDuckGo HTML ──
  private async _tryDdgHtml(encoded: string, extSignal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }> | null> {
    const resp = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encoded}`, 8000, extSignal);
    if (!resp || !resp.ok) return null;
    const html = await resp.text();
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const linkG = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
    const links: Array<{ url: string; title: string }> = [];
    let m;
    while ((m = linkG.exec(html)) !== null && links.length < MAX_RESULTS) {
      if (!m[1].includes('duckduckgo.com')) links.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() });
    }
    const snipG = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippets: string[] = [];
    let sm;
    while ((sm = snipG.exec(html)) !== null && snippets.length < MAX_RESULTS) {
      snippets.push(sm[1].replace(/<[^>]+>/g, '').trim());
    }
    for (let i = 0; i < links.length; i++) {
      results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' });
    }
    return results.length > 0 ? results : null;
  }

  // ── Backend: Bing (fallback when DuckDuckGo is unreachable) ──
  private async _tryBing(encoded: string, extSignal?: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string }> | null> {
    const resp = await fetchWithTimeout(`https://www.bing.com/search?q=${encoded}&count=10`, 12000, extSignal);
    if (!resp || !resp.ok) return null;
    const html = await resp.text();

    // Bing structure: <li class="b_algo"> ... <a href="...">title</a> ... text ... </li>
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const blockRe = /<li\s[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = blockRe.exec(html)) !== null && results.length < MAX_RESULTS) {
      const linkRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const lm = linkRe.exec(m[1]);
      if (!lm || lm[1].includes('go.microsoft.com')) continue;
      const title = lm[2].replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      const afterLink = m[1].slice(m[1].indexOf(lm[0]) + lm[0].length);
      const snippet = afterLink.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      results.push({ title, url: lm[1], snippet });
    }
    return results.length > 0 ? results : null;
  }

  userFacingName(): string { return 'Web Search'; }
  getToolUseSummary(input?: Record<string, unknown>): string | null {
    return input?.query && typeof input.query === 'string' ? this.truncate(input.query, 50) : null;
  }
  getActivityDescription(): string | null { return 'Searching the web'; }
}

function _domain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
