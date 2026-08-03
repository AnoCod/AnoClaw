import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeHtml } from '../MarkdownRenderer.js';

describe('MarkdownRenderer HTML sanitization', () => {
  it('removes executable attributes and javascript URLs from converted previews', () => {
    const html = sanitizeHtml('<p onclick="alert(1)"><a href="javascript:alert(2)">Open</a></p>');

    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<p><a>Open</a></p>');
  });

  it('removes URL schemes obfuscated with browser-ignored control characters', () => {
    const html = sanitizeHtml([
      '<a href="java\nscript:alert(1)">newline</a>',
      '<a href="java\tscript:alert(2)">tab</a>',
      '<a href="vbscript:msgbox(1)">vbscript</a>',
      '<a href="data:text/html;base64,PHNjcmlwdD4=">data</a>',
      '<a href="file:///C:/Temp/probe.html">file</a>',
      '<a href="shell:open">custom</a>',
    ].join(''));

    expect(html).not.toContain('href=');
    expect(html).toContain('<a>newline</a>');
    expect(html).toContain('<a>tab</a>');
    expect(html).toContain('<a>vbscript</a>');
    expect(html).toContain('<a>data</a>');
    expect(html).toContain('<a>file</a>');
    expect(html).toContain('<a>custom</a>');
  });

  it('blocks dangerous schemes introduced by Markdown link conversion', () => {
    const rendered = renderMarkdown([
      '[script](javascript:alert%281%29)',
      '[tab](java\tscript:alert%281%29)',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '[custom](shell:open)',
    ].join('\n'));

    expect(rendered).not.toContain('javascript:');
    expect(rendered).not.toContain('data:text/html');
    expect(rendered).not.toContain('shell:open');
    expect(rendered).not.toContain('data-external-url');
  });

  it('keeps ordinary Markdown links', () => {
    const rendered = renderMarkdown([
      '[web](https://example.com/path)',
      '[mail](mailto:test@example.com)',
      '[anchor](#section)',
    ].join('\n'));

    expect(rendered).toContain('href="https://example.com/path"');
    expect(rendered).toContain('href="mailto:test@example.com"');
    expect(rendered).toContain('href="#section"');
  });

  it('keeps ordinary raw HTML links', () => {
    const rendered = renderMarkdown(
      '<a href="https://example.com">web</a><a href="mailto:test@example.com">mail</a><a href="#section">anchor</a>',
    );

    expect(rendered).toContain('href="https://example.com"');
    expect(rendered).toContain('href="mailto:test@example.com"');
    expect(rendered).toContain('href="#section"');
  });

  it('resolves local images relative to the Markdown file directory', () => {
    const rendered = renderMarkdown('![chart](../assets/chart.png)', {
      sessionId: 'session-a',
      basePath: 'docs/guides',
    });

    expect(rendered).toContain('path=docs%2Fassets%2Fchart.png');
    expect(rendered).toContain('sessionId=session-a');
  });
});
