import path from 'node:path';
import { promises as fs } from 'node:fs';

const TOOL_WEB_RESEARCH = 'web.research';

let api = null;

export async function activate(anoclaw) {
  api = anoclaw;

  await anoclaw.tools.register({
    name: TOOL_WEB_RESEARCH,
    description: 'Search the web, inspect top sources, and create a cited markdown research brief artifact.',
    category: 'Web Research',
    parametersSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Research topic or question.' },
        title: { type: 'string', description: 'Optional brief title. Defaults to the query.' },
        maxSources: { type: 'number', description: 'Maximum search results to include. Default 5, maximum 10.' },
        maxFetchedSources: { type: 'number', description: 'Maximum result pages to fetch for notes. Default 2, maximum 5.' },
        fetchPages: { type: 'boolean', description: 'Fetch top source pages for notes. Default true.' },
        language: { type: 'string', description: 'Output language hint such as en or zh-CN.' },
        allowedDomains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains.' },
        blockedDomains: { type: 'array', items: { type: 'string' }, description: 'Exclude results from these domains.' },
      },
      required: ['query'],
    },
  });

  anoclaw.log.info('Web Research plugin activated');
}

export async function executeTool(toolName, params = {}, ctx = null) {
  if (toolName !== TOOL_WEB_RESEARCH) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const result = await createWebResearchArtifact(params, ctx, api);
  return JSON.stringify(result, null, 2);
}

export async function createWebResearchArtifact(params = {}, ctx = null, anoclaw = api) {
  const query = requiredText(params.query || params.topic || params.question || params.prompt, 'query');
  const title = optionalText(params.title) || `Research brief: ${query}`;
  const maxSources = clampNumber(params.maxSources, 1, 10, 5);
  const maxFetchedSources = clampNumber(params.maxFetchedSources, 0, Math.min(maxSources, 5), Math.min(maxSources, 2));
  const fetchPages = params.fetchPages !== false && maxFetchedSources > 0;
  const language = optionalText(params.language) || (hasChinese(`${title}\n${query}`) ? 'zh-CN' : 'en');

  if (!anoclaw?.tools?.execute) {
    throw new Error('The web research plugin requires anoclaw.tools.execute to call WebSearch and WebFetch.');
  }

  const searchRaw = await anoclaw.tools.execute('WebSearch', compactObject({
    query,
    allowed_domains: stringArray(params.allowedDomains || params.allowed_domains),
    blocked_domains: stringArray(params.blockedDomains || params.blocked_domains),
  }));
  const searchResults = parseSearchResults(searchRaw).slice(0, maxSources);
  if (searchResults.length === 0) {
    throw new Error(`No web search results were found for: ${query}`);
  }

  const sources = [];
  for (const [index, result] of searchResults.entries()) {
    const source = { ...result, index: index + 1, fetched: false, content: '', fetchError: '' };
    if (fetchPages && index < maxFetchedSources) {
      try {
        const fetched = await anoclaw.tools.execute('WebFetch', {
          url: result.url,
          prompt: `Extract facts relevant to this research query: ${query}`,
        });
        source.fetched = true;
        source.content = cleanFetchedContent(fetched, result.url).slice(0, 3500);
      } catch (error) {
        source.fetchError = error instanceof Error ? error.message : String(error);
      }
    }
    sources.push(source);
  }

  const findings = extractFindings(sources, query, 6);
  const markdown = researchBriefToMarkdown({
    title,
    query,
    language,
    sources,
    findings,
    fetchPages,
  });

  const sessionId = optionalText(ctx?.sessionId) || 'standalone';
  const storageRoot = anoclaw?.context?.storagePath || path.join(process.cwd(), 'plugins', 'anoclaw-web-research', 'data');
  const outputDir = path.join(storageRoot, 'artifacts', safeSegment(sessionId));
  await fs.mkdir(outputDir, { recursive: true });
  const fileName = `${safeSegment(title).slice(0, 60) || 'web-research'}-${Date.now().toString(36)}.md`;
  const filePath = path.join(outputDir, fileName);
  await fs.writeFile(filePath, markdown, 'utf8');
  const stat = await fs.stat(filePath);

  let artifact = null;
  if (anoclaw?.api?.call && sessionId !== 'standalone') {
    const response = await anoclaw.api.call('POST', '/api/v1/artifacts', {
      sessionId,
      title,
      kind: 'report',
      status: 'done',
      capabilityId: 'web.research',
      description: 'Cited web research brief.',
      files: [{
        path: filePath,
        label: 'Research brief',
        mimeType: 'text/markdown',
        sizeBytes: stat.size,
        role: 'primary',
      }],
      preview: {
        type: 'markdown',
        content: markdown,
        mimeType: 'text/markdown',
      },
      metadata: {
        query,
        language,
        sourceCount: sources.length,
        fetchedSourceCount: sources.filter((source) => source.fetched).length,
        sources: sources.map((source) => ({
          title: source.title,
          url: source.url,
          fetched: source.fetched,
          fetchError: source.fetchError,
        })),
        plugin: 'anoclaw-web-research',
      },
    });
    artifact = response?.body?.artifact || null;
  }

  return {
    ok: true,
    filePath,
    artifactId: artifact?.id,
    artifact,
    preview: markdown,
    query,
    sourceCount: sources.length,
    fetchedSourceCount: sources.filter((source) => source.fetched).length,
    sources: sources.map((source) => ({ title: source.title, url: source.url })),
    findings,
  };
}

export function parseSearchResults(raw) {
  const blocks = String(raw || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const results = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const urlIndex = lines.findIndex((line) => /^https?:\/\//i.test(line) || /\bhttps?:\/\/\S+/i.test(line));
    if (urlIndex < 0) continue;
    const urlMatch = lines[urlIndex].match(/\bhttps?:\/\/\S+/i);
    const url = trimUrl(urlMatch ? urlMatch[0] : lines[urlIndex]);
    if (!url) continue;
    const title = stripMarkdown(lines.slice(0, urlIndex).join(' ') || lines[0]).slice(0, 180) || url;
    const snippet = stripMarkdown(lines.filter((_line, index) => index !== urlIndex && index !== 0).join(' ')).slice(0, 500);
    if (!results.some((result) => result.url === url)) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function researchBriefToMarkdown({ title, query, language, sources, findings, fetchPages }) {
  const labels = labelsFor(language);
  const lines = [
    `# ${title}`,
    '',
    `- ${labels.query}: ${query}`,
    `- ${labels.generatedAt}: ${new Date().toISOString()}`,
    `- ${labels.sources}: ${sources.length}`,
    `- ${labels.pageFetch}: ${fetchPages ? labels.enabled : labels.disabled}`,
    '',
    `## ${labels.keyFindings}`,
    '',
  ];

  for (const finding of findings) {
    lines.push(`- ${finding}`);
  }
  if (findings.length === 0) {
    lines.push(`- ${labels.noFindings}`);
  }

  lines.push('', `## ${labels.sources}`, '', `| # | ${labels.title} | URL | ${labels.note} |`, '|---:|---|---|---|');
  for (const source of sources) {
    const note = source.snippet || source.content.slice(0, 180) || source.fetchError || '';
    lines.push(`| ${source.index} | ${escapeTable(source.title)} | ${escapeTable(source.url)} | ${escapeTable(note)} |`);
  }

  lines.push('', `## ${labels.sourceNotes}`, '');
  for (const source of sources) {
    lines.push(`### [${source.index}] ${source.title}`, '', source.url, '');
    if (source.snippet) lines.push(`Snippet: ${source.snippet}`, '');
    if (source.content) {
      lines.push(source.content.slice(0, 1200), '');
    } else if (source.fetchError) {
      lines.push(`Fetch note: ${source.fetchError}`, '');
    }
  }

  lines.push(
    `## ${labels.nextSteps}`,
    '',
    `- ${labels.verify}`,
    `- ${labels.expand}`,
    `- ${labels.update}`,
    '',
    `## ${labels.limitations}`,
    '',
    `- ${labels.limitationSearch}`,
    `- ${labels.limitationFetch}`,
    '',
  );

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

function extractFindings(sources, query, maxFindings) {
  const queryTerms = new Set(tokenize(query));
  const candidates = [];
  for (const source of sources) {
    const text = `${source.snippet || ''}. ${source.content || ''}`;
    for (const sentence of splitSentences(text)) {
      if (sentence.length < 30 || sentence.length > 260) continue;
      const score = tokenize(sentence).reduce((total, term) => total + (queryTerms.has(term) ? 2 : 1), 0);
      candidates.push({ sentence, score, sourceIndex: source.index });
    }
  }
  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((candidate) => {
      const key = candidate.sentence.toLowerCase().slice(0, 90);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxFindings)
    .map((candidate) => `${candidate.sentence} [${candidate.sourceIndex}]`);
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9\u4e00-\u9fff]{2,}/g) || [];
}

function cleanFetchedContent(raw, url) {
  return String(raw || '')
    .replace(new RegExp(`^\\[Cached\\]\\s*${escapeRegExp(url)}\\s*`, 'i'), '')
    .replace(new RegExp(`^\\[${escapeRegExp(url)}\\]\\s*`, 'i'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function labelsFor(language) {
  if (String(language || '').toLowerCase().startsWith('zh')) {
    return {
      query: 'Query',
      generatedAt: 'Generated at',
      sources: 'Sources',
      pageFetch: 'Page fetch',
      enabled: 'enabled',
      disabled: 'disabled',
      keyFindings: 'Key findings',
      noFindings: 'No source-backed findings could be extracted automatically.',
      title: 'Title',
      note: 'Note',
      sourceNotes: 'Source notes',
      nextSteps: 'Next steps',
      verify: 'Verify important claims against the linked sources before final use.',
      expand: 'Ask AnoClaw to deepen any source or turn this brief into a report, PPT, or document.',
      update: 'Re-run research when current facts may have changed.',
      limitations: 'Limitations',
      limitationSearch: 'Search results depend on reachable public web pages and current network access.',
      limitationFetch: 'Some pages may block automated fetches, require login, or contain incomplete text.',
    };
  }
  return {
    query: 'Query',
    generatedAt: 'Generated at',
    sources: 'Sources',
    pageFetch: 'Page fetch',
    enabled: 'enabled',
    disabled: 'disabled',
    keyFindings: 'Key findings',
    noFindings: 'No source-backed findings could be extracted automatically.',
    title: 'Title',
    note: 'Note',
    sourceNotes: 'Source notes',
    nextSteps: 'Next steps',
    verify: 'Verify important claims against the linked sources before final use.',
    expand: 'Ask AnoClaw to deepen any source or turn this brief into a report, PPT, or document.',
    update: 'Re-run research when current facts may have changed.',
    limitations: 'Limitations',
    limitationSearch: 'Search results depend on reachable public web pages and current network access.',
    limitationFetch: 'Some pages may block automated fetches, require login, or contain incomplete text.',
  };
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => optionalText(entry)).filter(Boolean)
    : undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function hasChinese(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ''));
}

function safeSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeTable(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function trimUrl(value) {
  return String(value || '').replace(/[),.;\]]+$/g, '').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
