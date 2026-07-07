import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebResearchArtifact, parseSearchResults } from '../extension.js';

describe('anoclaw-web-research tool', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'anoclaw-web-research-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('parses the built-in WebSearch text result format', () => {
    const parsed = parseSearchResults([
      'AnoClaw docs',
      '  https://example.com/docs',
      '  Desktop AI agent documentation.',
      '',
      'AnoClaw release notes',
      '  https://example.com/releases',
      '  Current version notes.',
    ].join('\n'));

    expect(parsed).toEqual([
      {
        title: 'AnoClaw docs',
        url: 'https://example.com/docs',
        snippet: 'Desktop AI agent documentation.',
      },
      {
        title: 'AnoClaw release notes',
        url: 'https://example.com/releases',
        snippet: 'Current version notes.',
      },
    ]);
  });

  it('creates a cited markdown research artifact from search and fetch results', async () => {
    const apiCall = vi.fn(async (_method: string, _path: string, body: Record<string, unknown>) => ({
      body: {
        artifact: {
          id: 'web-art-test',
          sessionId: body.sessionId,
          title: body.title,
        },
      },
    }));
    const toolExecute = vi.fn(async (name: string, params: Record<string, unknown>) => {
      if (name === 'WebSearch') {
        expect(params.query).toBe('AI desktop agent platforms');
        return [
          'Desktop AI agents overview',
          '  https://example.com/agents',
          '  Desktop AI agents combine local workspace context with web research and artifact creation.',
          '',
          'AI office automation',
          '  https://example.com/office',
          '  Office automation agents generate presentations, documents, and spreadsheet summaries.',
        ].join('\n');
      }
      if (name === 'WebFetch') {
        return `[${params.url}]\n\nDesktop AI agents are strongest when they can cite sources, inspect files, and produce downloadable artifacts. They should keep links attached to claims.`;
      }
      throw new Error(`Unexpected tool: ${name}`);
    });
    const fakeApi = {
      context: { storagePath: path.join(root, '.plugin-data') },
      api: { call: apiCall },
      tools: { execute: toolExecute },
    };

    const result = await createWebResearchArtifact({
      query: 'AI desktop agent platforms',
      title: 'AI desktop agent research',
      maxSources: 2,
      maxFetchedSources: 1,
    }, { sessionId: 'session-1', agentId: 'ceo', workspace: root }, fakeApi);

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBe('web-art-test');
    expect(result.sourceCount).toBe(2);
    expect(result.fetchedSourceCount).toBe(1);
    expect(result.preview).toContain('# AI desktop agent research');
    expect(result.preview).toContain('https://example.com/agents');
    expect(result.preview).toContain('[1]');
    const markdown = await fs.readFile(result.filePath, 'utf8');
    expect(markdown).toContain('## Key findings');
    expect(markdown).toContain('## Sources');
    expect(apiCall).toHaveBeenCalledWith('POST', '/api/v1/artifacts', expect.objectContaining({
      sessionId: 'session-1',
      kind: 'report',
      status: 'done',
      capabilityId: 'web.research',
      preview: expect.objectContaining({ type: 'markdown' }),
    }));
  });
});
