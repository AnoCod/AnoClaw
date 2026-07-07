import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const TOOL_SUMMARIZE_PDF = 'pdf.summarize';

let api = null;

export async function activate(anoclaw) {
  api = anoclaw;

  await anoclaw.tools.register({
    name: TOOL_SUMMARIZE_PDF,
    description: 'Extract text from a PDF and create a markdown summary artifact with key points and page notes.',
    category: 'PDF',
    parametersSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'PDF file path to summarize.' },
        pages: { type: 'string', description: 'Optional page range such as "1-3,5". Default: first pages up to maxPages.' },
        title: { type: 'string', description: 'Optional summary title. Default: PDF filename.' },
        language: { type: 'string', description: 'Output language. Default: zh-CN if Chinese text is detected, otherwise en.' },
        maxPages: { type: 'number', description: 'Maximum pages to process when pages is omitted. Default: 50.' },
        maxChars: { type: 'number', description: 'Maximum extracted characters to keep in the artifact. Default: 60000.' },
        summaryBullets: { type: 'number', description: 'Number of key summary bullets. Default: 6.' },
      },
      required: ['filePath'],
    },
  });

  anoclaw.log.info('PDF plugin activated');
}

export async function executeTool(toolName, params = {}, ctx = null) {
  if (toolName !== TOOL_SUMMARIZE_PDF) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const result = await createPdfSummaryArtifact(params, ctx, api);
  return JSON.stringify(result, null, 2);
}

export async function createPdfSummaryArtifact(params = {}, ctx = null, anoclaw = api) {
  const sourcePath = requiredText(params.filePath || params.path || params.pdfPath, 'filePath');
  const resolvedPath = resolveInputPath(sourcePath, ctx);
  const maxPages = clampNumber(params.maxPages, 1, 200, 50);
  const maxChars = clampNumber(params.maxChars, 1000, 300000, 60000);
  const summaryBullets = clampNumber(params.summaryBullets, 3, 12, 6);
  const extraction = await extractPdfText(resolvedPath, {
    pages: optionalText(params.pages),
    maxPages,
    maxChars,
  });

  if (!extraction.text.trim()) {
    throw new Error('No extractable text was found in this PDF. An OCR image plugin is needed for scanned PDFs.');
  }

  const title = optionalText(params.title || params.topic || params.subject) || `${basenameWithoutExt(resolvedPath)} summary`;
  const language = optionalText(params.language) || (hasChinese(`${title}\n${extraction.text}`) ? 'zh-CN' : 'en');
  const summary = buildPdfSummary({
    title,
    extraction,
    language,
    summaryBullets,
  });

  const sessionId = optionalText(ctx?.sessionId) || 'standalone';
  const storageRoot = anoclaw?.context?.storagePath || path.join(process.cwd(), 'plugins', 'anoclaw-pdf', 'data');
  const outputDir = path.join(storageRoot, 'artifacts', safeSegment(sessionId));
  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `${safeSegment(title).slice(0, 60) || 'pdf-summary'}-${Date.now().toString(36)}.md`;
  const filePath = path.join(outputDir, fileName);
  const markdown = pdfSummaryToMarkdown({ title, sourcePath: resolvedPath, extraction, summary, language });
  await fs.writeFile(filePath, markdown, 'utf8');

  const stat = await fs.stat(filePath);
  let sourceStat = null;
  try {
    sourceStat = await fs.stat(resolvedPath);
  } catch {
    sourceStat = null;
  }

  let artifact = null;
  if (anoclaw?.api?.call && sessionId !== 'standalone') {
    const files = [{
      path: filePath,
      label: 'Markdown summary',
      mimeType: 'text/markdown',
      sizeBytes: stat.size,
      role: 'primary',
    }];
    if (sourceStat) {
      files.push({
        path: resolvedPath,
        label: 'Source PDF',
        mimeType: 'application/pdf',
        sizeBytes: sourceStat.size,
        role: 'source',
      });
    }

    const response = await anoclaw.api.call('POST', '/api/v1/artifacts', {
      sessionId,
      title,
      kind: 'pdf',
      status: 'done',
      capabilityId: 'pdf.summarize',
      description: language.startsWith('zh') ? 'PDF 摘要与分页笔记。' : 'PDF summary and page notes.',
      files,
      preview: {
        type: 'markdown',
        content: markdown,
        mimeType: 'text/markdown',
      },
      metadata: {
        title,
        language,
        pageCount: extraction.pageCount,
        selectedPages: extraction.selectedPages,
        extractedCharCount: extraction.text.length,
        truncatedByChars: extraction.truncatedByChars,
        truncatedByPages: extraction.truncatedByPages,
        sourcePath: resolvedPath,
        plugin: 'anoclaw-pdf',
      },
    });
    artifact = response?.body?.artifact || null;
  }

  return {
    ok: true,
    filePath,
    sourcePath: resolvedPath,
    artifactId: artifact?.id,
    artifact,
    preview: markdown,
    pageCount: extraction.pageCount,
    selectedPages: extraction.selectedPages,
    extractedCharCount: extraction.text.length,
    summaryBullets: summary.bullets,
    keyTerms: summary.keyTerms.map((term) => term.term),
    truncatedByChars: extraction.truncatedByChars,
    truncatedByPages: extraction.truncatedByPages,
  };
}

export async function extractPdfText(filePath, options = {}) {
  const buffer = await fs.readFile(filePath);
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  try {
    const selectedPages = selectPages({
      spec: options.pages,
      pageCount: pdf.numPages,
      maxPages: options.maxPages || 50,
    });
    const pages = [];
    let totalText = '';
    let truncatedByChars = false;
    const maxChars = options.maxChars || 60000;

    for (const pageNumber of selectedPages) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = textContentToString(content);
      const remaining = maxChars - totalText.length;
      if (remaining <= 0) {
        truncatedByChars = true;
        break;
      }
      const pageText = text.length > remaining ? text.slice(0, remaining) : text;
      if (text.length > remaining) truncatedByChars = true;
      pages.push({ pageNumber, text: pageText });
      totalText += `${totalText ? '\n\n' : ''}${pageText}`;
      if (truncatedByChars) break;
    }

    return {
      pageCount: pdf.numPages,
      selectedPages: pages.map((page) => page.pageNumber),
      pages,
      text: totalText.trim(),
      truncatedByChars,
      truncatedByPages: !options.pages && pdf.numPages > selectedPages.length,
    };
  } finally {
    await pdf.destroy();
  }
}

function textContentToString(content) {
  const lines = [];
  let current = '';
  for (const item of content.items || []) {
    const text = optionalText(item?.str);
    if (!text) continue;
    current += current ? ` ${text}` : text;
    if (item.hasEOL) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function selectPages({ spec, pageCount, maxPages }) {
  if (!spec) {
    const count = Math.min(pageCount, maxPages);
    return Array.from({ length: count }, (_unused, index) => index + 1);
  }

  const selected = new Set();
  for (const part of String(spec).split(',')) {
    const value = part.trim();
    if (!value) continue;
    const range = value.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = clampNumber(Number(range[1]), 1, pageCount, 1);
      const end = clampNumber(Number(range[2]), 1, pageCount, start);
      for (let page = Math.min(start, end); page <= Math.max(start, end); page += 1) {
        selected.add(page);
      }
      continue;
    }
    const page = Number(value);
    if (Number.isInteger(page) && page >= 1 && page <= pageCount) selected.add(page);
  }

  return Array.from(selected).sort((a, b) => a - b).slice(0, maxPages);
}

function buildPdfSummary({ extraction, language, summaryBullets }) {
  const zh = language.startsWith('zh');
  const sentences = splitSentences(extraction.text, zh)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= (zh ? 8 : 24));
  const keyTerms = extractKeyTerms(extraction.text, zh, 12);
  const bullets = selectSummarySentences(sentences, keyTerms, summaryBullets);
  const pageNotes = extraction.pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: trimText(page.text, 900),
  })).filter((page) => page.text);
  return {
    bullets: bullets.length > 0 ? bullets : [trimText(extraction.text, 420)],
    keyTerms,
    pageNotes,
  };
}

function splitSentences(text, zh) {
  if (zh) {
    return String(text || '').match(/[^。！？!?]+[。！？!?]?/g) || [];
  }
  return String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
}

function extractKeyTerms(text, zh, limit) {
  const tokens = zh
    ? extractChineseTerms(text)
    : String(text || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const stopwords = zh ? CHINESE_STOPWORDS : ENGLISH_STOPWORDS;
  const counts = new Map();
  for (const token of tokens) {
    const normalized = token.trim().toLowerCase();
    if (!normalized || stopwords.has(normalized) || normalized.length < 2) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit);
}

function extractChineseTerms(text) {
  const terms = [];
  const chunks = String(text || '').match(/[\u3400-\u9FFF]{2,}/g) || [];
  for (const chunk of chunks) {
    if (chunk.length <= 4) {
      terms.push(chunk);
      continue;
    }
    for (let index = 0; index < chunk.length - 1; index += 2) {
      terms.push(chunk.slice(index, Math.min(index + 4, chunk.length)));
    }
  }
  return terms;
}

function selectSummarySentences(sentences, keyTerms, limit) {
  if (sentences.length <= limit) return sentences;
  const terms = keyTerms.map((item) => item.term);
  const scored = sentences.map((sentence, index) => {
    const normalized = sentence.toLowerCase();
    const termScore = terms.reduce((score, term) => score + (normalized.includes(term) ? 2 : 0), 0);
    const lengthScore = sentence.length > 80 && sentence.length < 260 ? 2 : 0;
    const positionScore = index < 3 ? 2 : index < 10 ? 1 : 0;
    return { sentence, index, score: termScore + lengthScore + positionScore };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
}

function pdfSummaryToMarkdown({ title, sourcePath, extraction, summary, language }) {
  const zh = language.startsWith('zh');
  const lines = [
    `# ${title}`,
    '',
    zh ? `- 来源: ${sourcePath}` : `- Source: ${sourcePath}`,
    zh ? `- 总页数: ${extraction.pageCount}` : `- Total pages: ${extraction.pageCount}`,
    zh ? `- 已处理页码: ${formatPageList(extraction.selectedPages)}` : `- Processed pages: ${formatPageList(extraction.selectedPages)}`,
    zh ? `- 提取字符数: ${extraction.text.length}` : `- Extracted characters: ${extraction.text.length}`,
    '',
    zh ? '## 摘要' : '## Summary',
  ];

  if (extraction.truncatedByPages) {
    lines.push(zh ? '- 由于页数较多，本次只处理了前几页；可指定 pages 参数继续处理其他页。' : '- Only the first pages were processed because the PDF is long; pass pages to process another range.');
  }
  if (extraction.truncatedByChars) {
    lines.push(zh ? '- 文本较长，已按字符上限截断。' : '- Text was truncated at the configured character limit.');
  }
  for (const bullet of summary.bullets) lines.push(`- ${bullet}`);

  lines.push('', zh ? '## 关键词' : '## Key Terms');
  lines.push(summary.keyTerms.length > 0
    ? summary.keyTerms.map((term) => `- ${term.term} (${term.count})`).join('\n')
    : (zh ? '- 暂无明显关键词' : '- No strong key terms detected'));

  lines.push('', zh ? '## 分页笔记' : '## Page Notes');
  for (const page of summary.pageNotes) {
    lines.push('', zh ? `### 第 ${page.pageNumber} 页` : `### Page ${page.pageNumber}`, '', page.text);
  }

  return lines.join('\n').trim();
}

function formatPageList(pages) {
  return pages.join(', ');
}

function resolveInputPath(inputPath, ctx) {
  if (path.isAbsolute(inputPath)) return inputPath;
  const base = optionalText(ctx?.workspace) || process.cwd();
  return path.resolve(base, inputPath);
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function basenameWithoutExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function trimText(value, maxLength) {
  const text = String(value || '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}

function hasChinese(value) {
  return /[\u3400-\u9FFF]/.test(String(value || ''));
}

function safeSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'with', 'that', 'this', 'from', 'have', 'has',
  'into', 'their', 'there', 'these', 'those', 'will', 'would', 'could', 'should',
  'about', 'which', 'when', 'where', 'while', 'than', 'then', 'been', 'being',
  'your', 'our', 'you', 'they', 'them', 'its', 'can', 'not',
]);

const CHINESE_STOPWORDS = new Set([
  '这个', '一个', '以及', '我们', '你们', '他们', '进行', '通过', '可以', '需要',
  '因此', '因为', '如果', '为了', '没有', '已经', '主要', '相关', '中的', '对于',
]);
