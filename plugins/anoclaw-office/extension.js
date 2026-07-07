import path from 'node:path';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';

const TOOL_CREATE_PPTX = 'office.create_pptx';
const TOOL_CREATE_DOCX = 'office.create_docx';
const TOOL_ANALYZE_SPREADSHEET = 'office.analyze_spreadsheet';

let api = null;

export async function activate(anoclaw) {
  api = anoclaw;
  await anoclaw.tools.register({
    name: TOOL_CREATE_PPTX,
    description: 'Create a PowerPoint .pptx deck from a topic, optional audience, style, and slide outline. Registers the result as an AnoClaw artifact when session context is available.',
    category: 'Office',
    parametersSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Presentation topic. Example: Solar system for elementary students.' },
        audience: { type: 'string', description: 'Target audience. Default: general audience.' },
        slideCount: { type: 'number', description: 'Approximate slide count. Default: 8.' },
        style: { type: 'string', description: 'Visual/content style. Default: clean business.' },
        language: { type: 'string', description: 'Output language. Default: zh-CN if Chinese topic is detected, otherwise en.' },
        slides: {
          type: 'array',
          description: 'Optional slide outline. Each item can include title, bullets, and notes.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
            },
          },
        },
      },
      required: ['topic'],
    },
  });

  await anoclaw.tools.register({
    name: TOOL_CREATE_DOCX,
    description: 'Create a Word .docx document from a title, document type, optional audience, content, and sections. Registers the result as an AnoClaw artifact when session context is available.',
    category: 'Office',
    parametersSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title. Example: Company year-end summary.' },
        documentType: { type: 'string', description: 'Document type. Example: report, proposal, contract draft, letter.' },
        audience: { type: 'string', description: 'Target audience. Default: general audience.' },
        style: { type: 'string', description: 'Writing style. Default: clear and professional.' },
        language: { type: 'string', description: 'Output language. Default: zh-CN if Chinese title/content is detected, otherwise en.' },
        content: { type: 'string', description: 'Optional source material or free-form content to include.' },
        sections: {
          type: 'array',
          description: 'Optional document sections. Each item can include heading and paragraphs.',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string' },
              paragraphs: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      required: ['title'],
    },
  });

  await anoclaw.tools.register({
    name: TOOL_ANALYZE_SPREADSHEET,
    description: 'Analyze CSV, TSV, XLSX, or row data and create an Excel .xlsx workbook with a markdown summary preview. Registers the result as an AnoClaw artifact when session context is available.',
    category: 'Office',
    parametersSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Analysis title. Default: Spreadsheet analysis.' },
        filePath: { type: 'string', description: 'Optional CSV, TSV, or XLSX file path to analyze.' },
        csv: { type: 'string', description: 'Optional CSV/TSV text to analyze.' },
        rows: {
          type: 'array',
          description: 'Optional table rows. Accepts an array of objects or an array of arrays.',
          items: { type: 'object' },
        },
        delimiter: { type: 'string', description: 'CSV delimiter. Auto-detected when omitted.' },
        language: { type: 'string', description: 'Output language. Default: zh-CN if Chinese text is detected, otherwise en.' },
        maxRows: { type: 'number', description: 'Maximum source rows to include in the workbook. Default: 5000.' },
      },
    },
  });

  anoclaw.log.info('Office plugin activated');
}

export async function executeTool(toolName, params = {}, ctx = null) {
  let result;
  if (toolName === TOOL_CREATE_PPTX) {
    result = await createPresentationArtifact(params, ctx, api);
  } else if (toolName === TOOL_CREATE_DOCX) {
    result = await createDocumentArtifact(params, ctx, api);
  } else if (toolName === TOOL_ANALYZE_SPREADSHEET) {
    result = await createSpreadsheetAnalysisArtifact(params, ctx, api);
  } else {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return JSON.stringify(result, null, 2);
}

export async function createPresentationArtifact(params = {}, ctx = null, anoclaw = api) {
  const topic = requiredText(params.topic, 'topic');
  const audience = optionalText(params.audience) || 'general audience';
  const slideCount = clampNumber(params.slideCount, 3, 20, 8);
  const language = optionalText(params.language) || (hasChinese(topic) ? 'zh-CN' : 'en');
  const style = optionalText(params.style) || (language.startsWith('zh') ? '简洁商务' : 'clean business');
  const slides = normalizeSlides(params.slides, { topic, audience, slideCount, language });
  const sessionId = optionalText(ctx?.sessionId) || 'standalone';
  const storageRoot = anoclaw?.context?.storagePath || path.join(process.cwd(), 'plugins', 'anoclaw-office', 'data');
  const outputDir = path.join(storageRoot, 'artifacts', safeSegment(sessionId));
  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `${safeSegment(topic).slice(0, 60) || 'presentation'}-${Date.now().toString(36)}.pptx`;
  const filePath = path.join(outputDir, fileName);
  await writePresentation({ topic, audience, style, language, slides, filePath });

  const stat = await fs.stat(filePath);
  const preview = slidesToMarkdown({ topic, audience, style, language, slides });
  let artifact = null;
  if (anoclaw?.api?.call && sessionId !== 'standalone') {
    const response = await anoclaw.api.call('POST', '/api/v1/artifacts', {
      sessionId,
      title: `${topic} PPT`,
      kind: 'presentation',
      status: 'done',
      capabilityId: 'presentation.create',
      description: `PowerPoint deck for ${audience}.`,
      files: [{
        path: filePath,
        label: 'PowerPoint deck',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        sizeBytes: stat.size,
        role: 'primary',
      }],
      preview: {
        type: 'markdown',
        content: preview,
        mimeType: 'text/markdown',
      },
      metadata: {
        topic,
        audience,
        style,
        language,
        slideCount: slides.length,
        plugin: 'anoclaw-office',
      },
    });
    artifact = response?.body?.artifact || null;
  }

  return {
    ok: true,
    filePath,
    artifactId: artifact?.id,
    artifact,
    preview,
    slideCount: slides.length,
  };
}

export async function createDocumentArtifact(params = {}, ctx = null, anoclaw = api) {
  const title = requiredText(params.title || params.topic, 'title');
  const documentType = optionalText(params.documentType) || (hasChinese(title) ? '文档' : 'document');
  const audience = optionalText(params.audience) || (hasChinese(title) ? '通用读者' : 'general audience');
  const content = optionalText(params.content);
  const language = optionalText(params.language) || (hasChinese(`${title}\n${content}`) ? 'zh-CN' : 'en');
  const style = optionalText(params.style) || (language.startsWith('zh') ? '清晰专业' : 'clear and professional');
  const sections = normalizeDocumentSections(params.sections, { title, documentType, audience, content, language });
  const sessionId = optionalText(ctx?.sessionId) || 'standalone';
  const storageRoot = anoclaw?.context?.storagePath || path.join(process.cwd(), 'plugins', 'anoclaw-office', 'data');
  const outputDir = path.join(storageRoot, 'artifacts', safeSegment(sessionId));
  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `${safeSegment(title).slice(0, 60) || 'document'}-${Date.now().toString(36)}.docx`;
  const filePath = path.join(outputDir, fileName);
  await writeDocument({ title, documentType, audience, style, language, sections, filePath });

  const stat = await fs.stat(filePath);
  const preview = documentToMarkdown({ title, documentType, audience, style, language, sections });
  let artifact = null;
  if (anoclaw?.api?.call && sessionId !== 'standalone') {
    const response = await anoclaw.api.call('POST', '/api/v1/artifacts', {
      sessionId,
      title,
      kind: 'document',
      status: 'done',
      capabilityId: 'document.create',
      description: `${documentType} for ${audience}.`,
      files: [{
        path: filePath,
        label: 'Word document',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: stat.size,
        role: 'primary',
      }],
      preview: {
        type: 'markdown',
        content: preview,
        mimeType: 'text/markdown',
      },
      metadata: {
        title,
        documentType,
        audience,
        style,
        language,
        sectionCount: sections.length,
        plugin: 'anoclaw-office',
      },
    });
    artifact = response?.body?.artifact || null;
  }

  return {
    ok: true,
    filePath,
    artifactId: artifact?.id,
    artifact,
    preview,
    sectionCount: sections.length,
  };
}

export async function createSpreadsheetAnalysisArtifact(params = {}, ctx = null, anoclaw = api) {
  const seedText = [
    params.title,
    params.topic,
    params.subject,
    params.csv,
    params.content,
    params.data,
  ].filter((value) => typeof value === 'string').join('\n');
  const title = optionalText(params.title || params.topic || params.subject) || (hasChinese(seedText) ? '表格数据分析' : 'Spreadsheet analysis');
  const language = optionalText(params.language) || (hasChinese(`${title}\n${seedText}`) ? 'zh-CN' : 'en');
  const maxRows = clampNumber(params.maxRows, 1, 10000, 5000);
  const table = await loadSpreadsheetTable(params, ctx, maxRows);
  const analysis = analyzeSpreadsheetTable(table);
  const sessionId = optionalText(ctx?.sessionId) || 'standalone';
  const storageRoot = anoclaw?.context?.storagePath || path.join(process.cwd(), 'plugins', 'anoclaw-office', 'data');
  const outputDir = path.join(storageRoot, 'artifacts', safeSegment(sessionId));
  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `${safeSegment(title).slice(0, 60) || 'spreadsheet-analysis'}-${Date.now().toString(36)}.xlsx`;
  const filePath = path.join(outputDir, fileName);
  await writeSpreadsheetWorkbook({ title, table, analysis, language, filePath });

  const stat = await fs.stat(filePath);
  const preview = spreadsheetAnalysisToMarkdown({ title, table, analysis, language });
  let artifact = null;
  if (anoclaw?.api?.call && sessionId !== 'standalone') {
    const response = await anoclaw.api.call('POST', '/api/v1/artifacts', {
      sessionId,
      title,
      kind: 'spreadsheet',
      status: 'done',
      capabilityId: 'spreadsheet.analyze',
      description: language.startsWith('zh') ? '表格数据分析工作簿。' : 'Spreadsheet analysis workbook.',
      files: [{
        path: filePath,
        label: 'Excel workbook',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: stat.size,
        role: 'primary',
      }],
      preview: {
        type: 'markdown',
        content: preview,
        mimeType: 'text/markdown',
      },
      metadata: {
        title,
        language,
        source: table.source,
        rowCount: analysis.rowCount,
        columnCount: analysis.columnCount,
        numericColumns: analysis.numericColumns.map((column) => column.name),
        plugin: 'anoclaw-office',
      },
    });
    artifact = response?.body?.artifact || null;
  }

  return {
    ok: true,
    filePath,
    artifactId: artifact?.id,
    artifact,
    preview,
    rowCount: analysis.rowCount,
    columnCount: analysis.columnCount,
    numericColumns: analysis.numericColumns.map((column) => column.name),
  };
}

async function writePresentation({ topic, audience, style, language, slides, filePath }) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'AnoClaw';
  pptx.company = 'AnoClaw';
  pptx.subject = topic;
  pptx.title = `${topic} PPT`;
  pptx.lang = language;
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: language,
  };

  addTitleSlide(pptx, { topic, audience, style });
  slides.forEach((slide, index) => addContentSlide(pptx, slide, index + 1));
  await pptx.writeFile({ fileName: filePath });
}

async function writeDocument({ title, documentType, audience, style, language, sections, filePath }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml());
  zip.folder('_rels').file('.rels', packageRelsXml());
  const word = zip.folder('word');
  word.file('document.xml', documentXml({ title, documentType, audience, style, language, sections }));
  word.file('styles.xml', stylesXml());
  word.file('settings.xml', settingsXml());
  word.folder('_rels').file('document.xml.rels', documentRelsXml());
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(filePath, buffer);
}

async function writeSpreadsheetWorkbook({ title, table, analysis, language, filePath }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', spreadsheetContentTypesXml());
  zip.folder('_rels').file('.rels', spreadsheetPackageRelsXml());
  const xl = zip.folder('xl');
  xl.file('workbook.xml', spreadsheetWorkbookXml());
  xl.file('styles.xml', spreadsheetStylesXml());
  xl.folder('_rels').file('workbook.xml.rels', spreadsheetWorkbookRelsXml());
  const worksheets = xl.folder('worksheets');
  worksheets.file('sheet1.xml', worksheetXml([table.headers, ...table.rows]));
  worksheets.file('sheet2.xml', worksheetXml(analysisRows({ title, table, analysis, language })));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(filePath, buffer);
}

async function loadSpreadsheetTable(params, ctx, maxRows) {
  if (Array.isArray(params.rows)) {
    return tableFromRows(params.rows, { source: 'rows', maxRows });
  }

  const csv = optionalText(params.csv || params.tsv || params.content || params.data);
  if (csv) {
    const delimiter = optionalText(params.delimiter);
    return tableFromRows(parseDelimitedRows(csv, delimiter), { source: 'inline-csv', maxRows });
  }

  const inputPath = optionalText(params.filePath || params.path);
  if (inputPath) {
    return readSpreadsheetFile(inputPath, ctx, maxRows, optionalText(params.delimiter));
  }

  throw new Error('Provide rows, csv, content, data, or filePath to analyze a spreadsheet.');
}

async function readSpreadsheetFile(inputPath, ctx, maxRows, delimiter) {
  const filePath = resolveInputPath(inputPath, ctx);
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
    const text = await fs.readFile(filePath, 'utf8');
    const parsedDelimiter = delimiter || (extension === '.tsv' ? '\t' : '');
    return tableFromRows(parseDelimitedRows(text, parsedDelimiter), { source: filePath, maxRows });
  }
  if (extension === '.xlsx') {
    const rows = await readXlsxRows(filePath);
    return tableFromRows(rows, { source: filePath, maxRows });
  }
  throw new Error(`Unsupported spreadsheet file type: ${extension || 'unknown'}`);
}

function resolveInputPath(inputPath, ctx) {
  if (path.isAbsolute(inputPath)) return inputPath;
  const base = optionalText(ctx?.workspace) || process.cwd();
  return path.resolve(base, inputPath);
}

function tableFromRows(inputRows, { source, maxRows }) {
  const rows = inputRows.slice(0, maxRows + 1);
  if (rows.length === 0) {
    throw new Error('Spreadsheet data is empty.');
  }

  if (rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    const headers = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!headers.includes(key)) headers.push(key);
      }
    }
    const body = rows.map((row) => headers.map((header) => cellToText(row[header])));
    return trimTable({ headers, rows: body, source });
  }

  const matrix = rows.map((row) => Array.isArray(row) ? row.map(cellToText) : [cellToText(row)]);
  const columnCount = Math.max(...matrix.map((row) => row.length), 1);
  const padded = matrix.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || ''));
  const firstRow = padded[0] || [];
  const hasHeader = looksLikeHeaderRow(firstRow, padded.slice(1));
  const headers = hasHeader
    ? dedupeHeaders(firstRow)
    : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  const body = hasHeader ? padded.slice(1) : padded;
  return trimTable({ headers, rows: body, source });
}

function trimTable(table) {
  const activeColumnIndexes = table.headers
    .map((_header, index) => index)
    .filter((index) => table.headers[index] || table.rows.some((row) => optionalText(row[index])));
  const headers = activeColumnIndexes.map((index, fallbackIndex) => table.headers[index] || `Column ${fallbackIndex + 1}`);
  const rows = table.rows
    .map((row) => activeColumnIndexes.map((index) => row[index] || ''))
    .filter((row) => row.some((cell) => optionalText(cell)));
  if (headers.length === 0) throw new Error('Spreadsheet data has no columns.');
  return { headers: dedupeHeaders(headers), rows, source: table.source };
}

function dedupeHeaders(headers) {
  const used = new Map();
  return headers.map((header, index) => {
    const base = optionalText(header) || `Column ${index + 1}`;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base} ${count + 1}`;
  });
}

function looksLikeHeaderRow(firstRow, remainingRows) {
  if (firstRow.length === 0) return false;
  const nonEmpty = firstRow.filter((cell) => optionalText(cell));
  if (nonEmpty.length === 0) return false;
  const unique = new Set(nonEmpty.map((cell) => cell.toLowerCase()));
  if (unique.size !== nonEmpty.length) return false;
  const headerTextCount = nonEmpty.filter((cell) => !Number.isFinite(parseLooseNumber(cell))).length;
  if (headerTextCount === 0) return false;
  const laterNumericCount = remainingRows
    .flatMap((row) => row)
    .filter((cell) => Number.isFinite(parseLooseNumber(cell))).length;
  return headerTextCount >= Math.ceil(nonEmpty.length / 2) || laterNumericCount > 0;
}

function parseDelimitedRows(text, delimiter = '') {
  const actualDelimiter = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === actualDelimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  row.push(field);
  if (row.some((cell) => cell.length > 0) || rows.length === 0) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const candidates = [',', '\t', ';', '|'];
  return candidates
    .map((delimiter) => ({ delimiter, count: sample.split(delimiter).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter || ',';
}

function analyzeSpreadsheetTable(table) {
  const columns = table.headers.map((name, index) => analyzeColumn(name, table.rows.map((row) => row[index] || '')));
  const numericColumns = columns.filter((column) => column.type === 'number');
  const highlights = buildSpreadsheetHighlights(table, columns, numericColumns);
  return {
    rowCount: table.rows.length,
    columnCount: table.headers.length,
    columns,
    numericColumns,
    highlights,
  };
}

function analyzeColumn(name, values) {
  const nonEmptyValues = values.map(optionalText).filter(Boolean);
  const numericValues = nonEmptyValues.map(parseLooseNumber).filter(Number.isFinite);
  const type = numericValues.length > 0 && numericValues.length >= Math.max(1, Math.ceil(nonEmptyValues.length * 0.6))
    ? 'number'
    : 'text';
  const uniqueValues = new Set(nonEmptyValues);
  const result = {
    name,
    type,
    nonEmptyCount: nonEmptyValues.length,
    missingCount: values.length - nonEmptyValues.length,
    uniqueCount: uniqueValues.size,
    sampleValues: Array.from(uniqueValues).slice(0, 5),
  };
  if (type === 'number') {
    const sum = numericValues.reduce((total, value) => total + value, 0);
    return {
      ...result,
      numericCount: numericValues.length,
      sum: roundNumber(sum),
      average: roundNumber(sum / numericValues.length),
      min: roundNumber(Math.min(...numericValues)),
      max: roundNumber(Math.max(...numericValues)),
    };
  }
  return result;
}

function buildSpreadsheetHighlights(table, columns, numericColumns) {
  const highlights = [
    `Rows: ${table.rows.length}`,
    `Columns: ${table.headers.length}`,
  ];
  if (numericColumns.length > 0) {
    const strongest = [...numericColumns].sort((a, b) => Math.abs(b.sum || 0) - Math.abs(a.sum || 0))[0];
    highlights.push(`Top numeric column: ${strongest.name} (sum ${formatNumber(strongest.sum)})`);
  }
  const sparse = columns.filter((column) => column.missingCount > 0).sort((a, b) => b.missingCount - a.missingCount)[0];
  if (sparse) highlights.push(`Most missing values: ${sparse.name} (${sparse.missingCount})`);
  return highlights;
}

function addTitleSlide(pptx, { topic, audience, style }) {
  const slide = pptx.addSlide();
  slide.background = { color: 'F7F7F2' };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.18, fill: { color: '2A6F68' }, line: { color: '2A6F68' } });
  slide.addText(topic, {
    x: 0.7,
    y: 1.35,
    w: 11.9,
    h: 1.2,
    fontFace: 'Aptos Display',
    fontSize: 34,
    bold: true,
    color: '1F2933',
    breakLine: false,
    fit: 'shrink',
  });
  slide.addText(`Audience: ${audience}\nStyle: ${style}`, {
    x: 0.75,
    y: 3.05,
    w: 8.8,
    h: 0.8,
    fontSize: 15,
    color: '53616F',
    breakLine: false,
  });
  slide.addText('Generated by AnoClaw', {
    x: 0.75,
    y: 6.75,
    w: 3.5,
    h: 0.3,
    fontSize: 10,
    color: '718096',
  });
}

function addContentSlide(pptx, slideData, pageNumber) {
  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };
  slide.addText(slideData.title, {
    x: 0.55,
    y: 0.45,
    w: 11.8,
    h: 0.55,
    fontFace: 'Aptos Display',
    fontSize: 25,
    bold: true,
    color: '1F2933',
    fit: 'shrink',
  });
  slide.addShape(pptx.ShapeType.line, { x: 0.58, y: 1.18, w: 12.0, h: 0, line: { color: 'D1D8DD', width: 1 } });
  const bulletText = slideData.bullets.map((bullet) => ({ text: bullet, options: { bullet: { indent: 18 }, hanging: 4 } }));
  slide.addText(bulletText, {
    x: 0.9,
    y: 1.55,
    w: 11.1,
    h: 4.4,
    fontSize: 17,
    color: '24313D',
    breakLine: false,
    paraSpaceAfterPt: 10,
    fit: 'shrink',
  });
  if (slideData.notes) {
    slide.addNotes(slideData.notes);
  }
  slide.addText(String(pageNumber), {
    x: 12.25,
    y: 6.85,
    w: 0.45,
    h: 0.24,
    fontSize: 9,
    color: '718096',
    align: 'right',
  });
}

function normalizeSlides(value, fallback) {
  const fromUser = Array.isArray(value)
    ? value.map((item) => ({
        title: optionalText(item?.title),
        bullets: Array.isArray(item?.bullets) ? item.bullets.map(optionalText).filter(Boolean).slice(0, 6) : [],
        notes: optionalText(item?.notes),
      })).filter((item) => item.title)
    : [];

  if (fromUser.length > 0) {
    return fromUser.map((item, index) => ({
      title: item.title || `Slide ${index + 1}`,
      bullets: item.bullets.length > 0 ? item.bullets : defaultBullets(fallback.topic, fallback.audience, index),
      notes: item.notes,
    })).slice(0, 30);
  }

  return defaultOutline(fallback);
}

function defaultOutline({ topic, audience, slideCount, language }) {
  const zh = language.startsWith('zh');
  const titles = zh
    ? ['任务概览', '为什么重要', '核心概念', '关键事实', '示例说明', '实践步骤', '常见误区', '总结与下一步']
    : ['Overview', 'Why It Matters', 'Core Ideas', 'Key Facts', 'Example', 'Action Steps', 'Common Pitfalls', 'Summary'];

  return Array.from({ length: slideCount }, (_, index) => ({
    title: titles[index] || (zh ? `要点 ${index + 1}` : `Point ${index + 1}`),
    bullets: defaultBullets(topic, audience, index, zh),
  }));
}

function defaultBullets(topic, audience, index, zh = hasChinese(topic)) {
  if (zh) {
    return [
      `围绕“${topic}”给 ${audience} 建立清晰理解`,
      '先给结论，再补充关键背景',
      '使用简洁例子帮助听众快速进入主题',
    ];
  }

  return [
    `Frame "${topic}" clearly for ${audience}`,
    'Lead with the main takeaway before details',
    'Use simple examples to make the idea memorable',
  ];
}

function slidesToMarkdown({ topic, audience, style, language, slides }) {
  const lines = [`# ${topic}`, '', `- Audience: ${audience}`, `- Style: ${style}`, `- Language: ${language}`, ''];
  for (const [index, slide] of slides.entries()) {
    lines.push(`## ${index + 1}. ${slide.title}`);
    for (const bullet of slide.bullets) lines.push(`- ${bullet}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function normalizeDocumentSections(value, fallback) {
  const fromUser = Array.isArray(value)
    ? value.map((item) => ({
        heading: optionalText(item?.heading || item?.title),
        paragraphs: Array.isArray(item?.paragraphs)
          ? item.paragraphs.map(optionalText).filter(Boolean).slice(0, 8)
          : optionalText(item?.content) ? [optionalText(item.content)] : [],
      })).filter((item) => item.heading || item.paragraphs.length > 0)
    : [];

  if (fromUser.length > 0) {
    return fromUser.map((item, index) => ({
      heading: item.heading || `Section ${index + 1}`,
      paragraphs: item.paragraphs.length > 0
        ? item.paragraphs
        : defaultDocumentParagraphs(fallback, index),
    })).slice(0, 30);
  }

  return defaultDocumentSections(fallback);
}

function defaultDocumentSections({ title, documentType, audience, content, language }) {
  const zh = language.startsWith('zh');
  const headings = zh
    ? ['摘要', '背景', '核心内容', '建议', '下一步']
    : ['Summary', 'Background', 'Main Content', 'Recommendations', 'Next Steps'];
  const base = headings.map((heading, index) => ({
    heading,
    paragraphs: defaultDocumentParagraphs({ title, documentType, audience, content, language }, index),
  }));
  if (content) {
    base.splice(2, 0, {
      heading: zh ? '原始资料整理' : 'Source Material',
      paragraphs: splitContentParagraphs(content),
    });
  }
  return base;
}

function defaultDocumentParagraphs({ title, documentType, audience, content, language }, index) {
  const zh = language.startsWith('zh');
  if (zh) {
    const paragraphs = [
      `本文档围绕“${title}”形成一份${documentType}，面向${audience}，采用清晰专业的表达。`,
      `当前任务的重点是先交付可编辑成品，后续可以继续补充事实、数据和具体案例。`,
      content ? `已有资料要点：${content.slice(0, 240)}` : `核心内容应围绕目标、现状、关键问题和可执行建议展开。`,
      `建议优先补齐真实背景、时间范围、负责人和衡量指标，让文档更适合正式交付。`,
      `下一步可以继续要求 AnoClaw 调整语气、增加章节、压缩篇幅或导出其他格式。`,
    ];
    return [paragraphs[index] || paragraphs[1]];
  }

  const paragraphs = [
    `This ${documentType} frames "${title}" for ${audience} in a clear, professional style.`,
    'The first draft prioritizes an editable deliverable. Facts, metrics, and examples can be refined in follow-up edits.',
    content ? `Source material summary: ${content.slice(0, 240)}` : 'The main content should cover the goal, current context, key issues, and practical recommendations.',
    'Add concrete context, owners, timing, and success metrics before using the document as a final deliverable.',
    'Next, ask AnoClaw to adjust tone, add sections, shorten the draft, or export another format.',
  ];
  return [paragraphs[index] || paragraphs[1]];
}

function splitContentParagraphs(content) {
  return content
    .split(/\n{2,}|[。.!?]\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function documentToMarkdown({ title, documentType, audience, style, language, sections }) {
  const lines = [`# ${title}`, '', `- Type: ${documentType}`, `- Audience: ${audience}`, `- Style: ${style}`, `- Language: ${language}`, ''];
  for (const section of sections) {
    lines.push(`## ${section.heading}`);
    for (const paragraph of section.paragraphs) lines.push(paragraph, '');
  }
  return lines.join('\n').trim();
}

async function readXlsxRows(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const sheetPath = await findFirstWorksheetPath(zip);
  const sheet = zip.file(sheetPath);
  if (!sheet) throw new Error('The XLSX workbook does not contain a readable worksheet.');
  const sharedStrings = await readSharedStrings(zip);
  return parseWorksheetRows(await sheet.async('string'), sharedStrings);
}

async function findFirstWorksheetPath(zip) {
  const workbook = zip.file('xl/workbook.xml');
  const rels = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) return 'xl/worksheets/sheet1.xml';
  const workbookXmlText = await workbook.async('string');
  const relsXmlText = await rels.async('string');
  const firstSheet = workbookXmlText.match(/<sheet\b[^>]*r:id="([^"]+)"/);
  const relId = firstSheet?.[1];
  if (!relId) return 'xl/worksheets/sheet1.xml';
  const relationship = new RegExp(`<Relationship\\b[^>]*Id="${escapeRegExp(relId)}"[^>]*Target="([^"]+)"`).exec(relsXmlText);
  const target = relationship?.[1] || 'worksheets/sheet1.xml';
  return target.startsWith('xl/') ? target : `xl/${target.replace(/^\/?xl\//, '')}`;
}

async function readSharedStrings(zip) {
  const shared = zip.file('xl/sharedStrings.xml');
  if (!shared) return [];
  const xml = await shared.async('string');
  return Array.from(xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g))
    .map((match) => Array.from(match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((textMatch) => decodeXml(textMatch[1]))
      .join(''));
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = [];
  const rowMatches = Array.from(xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g));
  for (const [fallbackRowIndex, rowMatch] of rowMatches.entries()) {
    const rowAttrs = parseXmlAttributes(rowMatch[1]);
    const rowIndex = Number(rowAttrs.r || fallbackRowIndex + 1);
    const values = [];
    const cells = Array.from(rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g));
    for (const cellMatch of cells) {
      const attrs = parseXmlAttributes(cellMatch[1]);
      const refColumn = attrs.r ? columnIndexFromRef(attrs.r) : values.length + 1;
      values[refColumn - 1] = parseWorksheetCell(cellMatch[2], attrs, sharedStrings);
    }
    rows[rowIndex - 1] = values.map((value) => value || '');
  }
  return rows.filter((row) => Array.isArray(row) && row.some((cell) => optionalText(cell)));
}

function parseWorksheetCell(innerXml, attrs, sharedStrings) {
  if (attrs.t === 'inlineStr') {
    return Array.from(innerXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
      .map((match) => decodeXml(match[1]))
      .join('');
  }
  const value = innerXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
  if (attrs.t === 's') return sharedStrings[Number(value)] || '';
  return decodeXml(value);
}

function spreadsheetAnalysisToMarkdown({ title, table, analysis, language }) {
  const zh = language.startsWith('zh');
  const lines = [
    `# ${title}`,
    '',
    zh ? `- 数据源: ${table.source}` : `- Source: ${table.source}`,
    zh ? `- 行数: ${analysis.rowCount}` : `- Rows: ${analysis.rowCount}`,
    zh ? `- 列数: ${analysis.columnCount}` : `- Columns: ${analysis.columnCount}`,
    '',
    zh ? '## 关键发现' : '## Highlights',
  ];
  for (const highlight of localizedSpreadsheetHighlights(analysis, language)) lines.push(`- ${highlight}`);
  lines.push('', zh ? '## 字段概览' : '## Column Summary', '');
  lines.push(zh ? '| 字段 | 类型 | 非空 | 缺失 | 唯一值 | 平均值 | 最小值 | 最大值 |' : '| Column | Type | Non-empty | Missing | Unique | Average | Min | Max |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const column of analysis.columns) {
    lines.push([
      escapeMarkdownCell(column.name),
      column.type,
      column.nonEmptyCount,
      column.missingCount,
      column.uniqueCount,
      column.average === undefined ? '' : formatNumber(column.average),
      column.min === undefined ? '' : formatNumber(column.min),
      column.max === undefined ? '' : formatNumber(column.max),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return lines.join('\n').trim();
}

function localizedSpreadsheetHighlights(analysis, language) {
  if (!language.startsWith('zh')) return analysis.highlights;
  const highlights = [
    `行数: ${analysis.rowCount}`,
    `列数: ${analysis.columnCount}`,
  ];
  if (analysis.numericColumns.length > 0) {
    const strongest = [...analysis.numericColumns].sort((a, b) => Math.abs(b.sum || 0) - Math.abs(a.sum || 0))[0];
    highlights.push(`主要数值列: ${strongest.name} (合计 ${formatNumber(strongest.sum)})`);
  }
  const sparse = analysis.columns.filter((column) => column.missingCount > 0).sort((a, b) => b.missingCount - a.missingCount)[0];
  if (sparse) highlights.push(`缺失值最多: ${sparse.name} (${sparse.missingCount})`);
  return highlights;
}

function analysisRows({ title, table, analysis, language }) {
  const zh = language.startsWith('zh');
  const rows = [
    [zh ? '指标' : 'Metric', zh ? '值' : 'Value'],
    [zh ? '标题' : 'Title', title],
    [zh ? '数据源' : 'Source', table.source],
    [zh ? '行数' : 'Rows', analysis.rowCount],
    [zh ? '列数' : 'Columns', analysis.columnCount],
    [zh ? '数值列' : 'Numeric columns', analysis.numericColumns.map((column) => column.name).join(', ')],
    [],
    [zh ? '字段' : 'Column', zh ? '类型' : 'Type', zh ? '非空' : 'Non-empty', zh ? '缺失' : 'Missing', zh ? '唯一值' : 'Unique', zh ? '求和' : 'Sum', zh ? '平均值' : 'Average', zh ? '最小值' : 'Min', zh ? '最大值' : 'Max'],
  ];
  for (const column of analysis.columns) {
    rows.push([
      column.name,
      column.type,
      column.nonEmptyCount,
      column.missingCount,
      column.uniqueCount,
      column.sum ?? '',
      column.average ?? '',
      column.min ?? '',
      column.max ?? '',
    ]);
  }
  return rows;
}

function contentTypesXml() {
  return xmlDecl(`\
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`);
}

function packageRelsXml() {
  return xmlDecl(`\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
}

function documentRelsXml() {
  return xmlDecl('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
}

function settingsXml() {
  return xmlDecl('<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>');
}

function stylesXml() {
  return xmlDecl(`\
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>
  </w:style>
</w:styles>`);
}

function documentXml({ title, documentType, audience, style, language, sections }) {
  const body = [
    paragraphXml(title, 'Title'),
    paragraphXml(`Type: ${documentType} | Audience: ${audience} | Style: ${style} | Language: ${language}`),
    ...sections.flatMap((section) => [
      paragraphXml(section.heading, 'Heading1'),
      ...section.paragraphs.map((paragraph) => paragraphXml(paragraph)),
    ]),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
  ].join('');
  return xmlDecl(`\
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`);
}

function paragraphXml(text, styleId = '') {
  const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function spreadsheetContentTypesXml() {
  return xmlDecl(`\
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
}

function spreadsheetPackageRelsXml() {
  return xmlDecl(`\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
}

function spreadsheetWorkbookXml() {
  return xmlDecl(`\
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Analysis" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`);
}

function spreadsheetWorkbookRelsXml() {
  return xmlDecl(`\
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
}

function spreadsheetStylesXml() {
  return xmlDecl(`\
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);
}

function worksheetXml(rows) {
  const sheetData = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((cell, columnIndex) => cellXml(cell, rowNumber, columnIndex + 1))
        .join('');
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join('');
  return xmlDecl(`\
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetData}</sheetData>
</worksheet>`);
}

function cellXml(value, rowNumber, columnNumber) {
  const ref = `${columnName(columnNumber)}${rowNumber}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cellToText(value))}</t></is></c>`;
}

function columnName(columnNumber) {
  let number = columnNumber;
  let name = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function columnIndexFromRef(ref) {
  const letters = String(ref || '').match(/^[A-Z]+/i)?.[0] || 'A';
  return letters.toUpperCase().split('').reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function xmlDecl(content) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${content}`;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(value) {
  const attrs = {};
  for (const match of String(value || '').matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function parseLooseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  const raw = optionalText(value);
  if (!raw) return Number.NaN;
  const normalized = raw
    .replace(/[%％]$/, '')
    .replace(/[$￥¥,，\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return Number.NaN;
  const parsed = Number(normalized);
  return raw.endsWith('%') || raw.endsWith('％') ? parsed / 100 : parsed;
}

function roundNumber(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : String(roundNumber(value));
}

function escapeMarkdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
