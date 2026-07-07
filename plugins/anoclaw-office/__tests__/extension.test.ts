import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentArtifact, createPresentationArtifact, createSpreadsheetAnalysisArtifact } from '../extension.js';

describe('anoclaw-office presentation tool', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anoclaw-office-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a pptx file and registers an artifact when session context exists', async () => {
    const apiCall = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => ({
      body: {
        artifact: {
          id: 'art-test',
          sessionId: body.sessionId,
          title: body.title,
        },
      },
    }));
    const fakeApi = {
      context: { storagePath: root },
      api: { call: apiCall },
    };

    const result = await createPresentationArtifact({
      topic: 'Solar System',
      audience: 'elementary students',
      slideCount: 3,
      style: 'friendly classroom',
    }, { sessionId: 'session-1', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBe('art-test');
    expect(result.slideCount).toBe(3);
    const file = await fs.readFile(result.filePath);
    expect(file.subarray(0, 2).toString()).toBe('PK');
    expect(apiCall).toHaveBeenCalledWith('POST', '/api/v1/artifacts', expect.objectContaining({
      sessionId: 'session-1',
      kind: 'presentation',
      status: 'done',
      capabilityId: 'presentation.create',
      preview: expect.objectContaining({ type: 'markdown' }),
    }));
  });

  it('uses clean Chinese defaults for Chinese presentation topics', async () => {
    const fakeApi = {
      context: { storagePath: root },
    };

    const result = await createPresentationArtifact({
      topic: '太阳系介绍',
      audience: '小学生',
      slideCount: 3,
    }, { sessionId: 'standalone', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.preview).toContain('任务概览');
    expect(result.preview).toContain('围绕“太阳系介绍”给 小学生 建立清晰理解');
    expect(result.preview).not.toMatch(/鈥|鍋|甯|绠|姒/);
    const file = await fs.readFile(result.filePath);
    expect(file.subarray(0, 2).toString()).toBe('PK');
  });

  it('creates a docx file and registers a document artifact', async () => {
    const apiCall = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => ({
      body: {
        artifact: {
          id: 'doc-art-test',
          sessionId: body.sessionId,
          title: body.title,
        },
      },
    }));
    const fakeApi = {
      context: { storagePath: root },
      api: { call: apiCall },
    };

    const result = await createDocumentArtifact({
      title: 'Company Year-End Summary',
      documentType: 'report',
      audience: 'management team',
      sections: [
        { heading: 'Highlights', paragraphs: ['Revenue improved and delivery risk decreased.'] },
      ],
    }, { sessionId: 'session-1', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBe('doc-art-test');
    expect(result.sectionCount).toBe(1);
    const file = await fs.readFile(result.filePath);
    expect(file.subarray(0, 2).toString()).toBe('PK');
    expect(apiCall).toHaveBeenCalledWith('POST', '/api/v1/artifacts', expect.objectContaining({
      sessionId: 'session-1',
      kind: 'document',
      status: 'done',
      capabilityId: 'document.create',
      preview: expect.objectContaining({ type: 'markdown' }),
    }));
  });

  it('uses clean Chinese defaults for Chinese document titles', async () => {
    const fakeApi = {
      context: { storagePath: root },
    };

    const result = await createDocumentArtifact({
      title: '公司年终总结报告',
      audience: '管理层',
      content: '今年完成了核心产品迭代，客户反馈稳定提升。',
    }, { sessionId: 'standalone', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.preview).toContain('摘要');
    expect(result.preview).toContain('公司年终总结报告');
    expect(result.preview).not.toMatch(/鈥|鍋|甯|绠|姒/);
    const file = await fs.readFile(result.filePath);
    expect(file.subarray(0, 2).toString()).toBe('PK');
  });

  it('creates a spreadsheet analysis workbook and registers an artifact', async () => {
    const apiCall = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => ({
      body: {
        artifact: {
          id: 'sheet-art-test',
          sessionId: body.sessionId,
          title: body.title,
        },
      },
    }));
    const fakeApi = {
      context: { storagePath: root },
      api: { call: apiCall },
    };

    const result = await createSpreadsheetAnalysisArtifact({
      title: 'Revenue analysis',
      rows: [
        { month: 'Jan', revenue: 120, cost: 70 },
        { month: 'Feb', revenue: 180, cost: 90 },
        { month: 'Mar', revenue: 150, cost: 80 },
      ],
    }, { sessionId: 'session-1', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBe('sheet-art-test');
    expect(result.rowCount).toBe(3);
    expect(result.columnCount).toBe(3);
    expect(result.numericColumns).toEqual(expect.arrayContaining(['revenue', 'cost']));
    expect(result.preview).toContain('Revenue analysis');
    expect(result.preview).toContain('150');
    const file = await fs.readFile(result.filePath);
    expect(file.subarray(0, 2).toString()).toBe('PK');
    expect(apiCall).toHaveBeenCalledWith('POST', '/api/v1/artifacts', expect.objectContaining({
      sessionId: 'session-1',
      kind: 'spreadsheet',
      status: 'done',
      capabilityId: 'spreadsheet.analyze',
      preview: expect.objectContaining({ type: 'markdown' }),
    }));
  });

  it('analyzes Chinese CSV text without mojibake', async () => {
    const fakeApi = {
      context: { storagePath: root },
    };

    const result = await createSpreadsheetAnalysisArtifact({
      title: '销售数据分析',
      csv: '月份,销售额,成本\n一月,1200,800\n二月,1800,950\n三月,1500,900',
    }, { sessionId: 'standalone', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(3);
    expect(result.preview).toContain('销售数据分析');
    expect(result.preview).toContain('销售额');
    expect(result.preview).toContain('1500');
    expect(result.preview).not.toMatch(/鈥|鍋|甯|绠|姒/);
    const file = await fs.readFile(result.filePath);
    expect(file.subarray(0, 2).toString()).toBe('PK');
  });
});
