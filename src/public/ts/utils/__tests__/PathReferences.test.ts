import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../MarkdownRenderer.js';
import {
  parseFilePathReference,
  resolveClickedFilePath,
} from '../PathReferences.js';

describe('PathReferences', () => {
  it('strips editor line suffixes from clickable file paths', () => {
    const ref = parseFilePathReference('src/server/core/agent/AgentLoop.ts:148');

    expect(ref).toEqual({
      raw: 'src/server/core/agent/AgentLoop.ts:148',
      path: 'src/server/core/agent/AgentLoop.ts',
      line: 148,
      column: undefined,
    });
  });

  it('resolves Windows workspace-root paths as workspace-relative', () => {
    const resolved = resolveClickedFilePath('/src/server/main.ts:10', 'F:\\QoderSoft\\AnoClaw');

    expect(resolved).toBe('F:\\QoderSoft\\AnoClaw\\src\\server\\main.ts');
  });

  it('renders bare paths with line suffixes as clickable spans with clean data path', () => {
    const html = renderMarkdown('Open src/server/core/agent/AgentLoop.ts:148.');

    expect(html).toContain('class="clickable-path"');
    expect(html).toContain('data-file-path="src/server/core/agent/AgentLoop.ts"');
    expect(html).toContain('data-file-line="148"');
    expect(html).toContain('AgentLoop.ts:148');
  });

  it('renders markdown links to files as clickable file paths instead of external URLs', () => {
    const html = renderMarkdown('[AgentLoop](src/server/core/agent/AgentLoop.ts:148)');

    expect(html).toContain('class="clickable-path"');
    expect(html).toContain('data-file-path="src/server/core/agent/AgentLoop.ts"');
    expect(html).not.toContain('data-external-url="true"');
  });

  it('keeps http URLs as external links and does not path-linkify URL endings', () => {
    const html = renderMarkdown('Read https://example.com/src/server/main.ts');

    expect(html).toContain('data-external-url="true"');
    expect(html).not.toContain('class="clickable-path"');
  });

  it('detects root filenames and dotfiles commonly mentioned by agents', () => {
    const html = renderMarkdown('Check package.json and .gitignore before editing.');

    expect(html).toContain('data-file-path="package.json"');
    expect(html).toContain('data-file-path=".gitignore"');
  });

  it('serves workspace images through the session-scoped raw file endpoint', () => {
    const html = renderMarkdown('![Chart](output/chart.png)', { sessionId: 'session 1' });

    expect(html).toContain('class="md-inline-image"');
    expect(html).toContain('data-file-path="output/chart.png"');
    expect(html).toContain('/api/v1/workspace/read?path=output%2Fchart.png&amp;sessionId=session+1&amp;raw=1');
    expect(html).toContain('tabindex="0"');
  });

  it('renders remote and bitmap data images while rejecting unsafe image schemes', () => {
    const remote = renderMarkdown('![Remote](https://example.com/image.png)');
    const data = renderMarkdown('![Inline](data:image/png;base64,AAAA)');
    const unsafe = renderMarkdown('![Unsafe](javascript:alert(1))');

    expect(remote).toContain('src="https://example.com/image.png"');
    expect(data).toContain('src="data:image/png;base64,AAAA"');
    expect(unsafe).not.toContain('<img');
    expect(unsafe).toContain('Image unavailable');
  });
});
