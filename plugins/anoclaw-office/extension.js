import path from 'node:path';
import { promises as fs } from 'node:fs';
import PptxGenJS from 'pptxgenjs';

const TOOL_CREATE_PPTX = 'office.create_pptx';

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

  anoclaw.log.info('Office plugin activated');
}

export async function executeTool(toolName, params = {}, ctx = null) {
  if (toolName !== TOOL_CREATE_PPTX) throw new Error(`Unknown tool: ${toolName}`);
  const result = await createPresentationArtifact(params, ctx, api);
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
