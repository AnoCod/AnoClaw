import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresentationArtifact } from '../extension.js';

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
});
