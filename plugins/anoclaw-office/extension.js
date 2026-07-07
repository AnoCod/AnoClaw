import path from 'node:path';
import { promises as fs } from 'node:fs';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';

const TOOL_CREATE_PPTX = 'office.create_pptx';
const TOOL_CREATE_DOCX = 'office.create_docx';

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

  anoclaw.log.info('Office plugin activated');
}

export async function executeTool(toolName, params = {}, ctx = null) {
  let result;
  if (toolName === TOOL_CREATE_PPTX) {
    result = await createPresentationArtifact(params, ctx, api);
  } else if (toolName === TOOL_CREATE_DOCX) {
    result = await createDocumentArtifact(params, ctx, api);
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
