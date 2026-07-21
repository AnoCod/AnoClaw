import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../MarkdownRenderer.js';

describe('MarkdownRenderer HTML sanitization', () => {
  it('removes executable attributes and javascript URLs from converted previews', () => {
    const html = sanitizeHtml('<p onclick="alert(1)"><a href="javascript:alert(2)">Open</a></p>');

    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<p><a>Open</a></p>');
  });
});
