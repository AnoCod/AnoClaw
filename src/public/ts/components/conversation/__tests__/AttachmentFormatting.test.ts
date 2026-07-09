import { describe, expect, it } from 'vitest';
import {
  attachmentDisplayLabel,
  attachmentPromptBlocks,
  buildPromptContentWithAttachments,
} from '../AttachmentFormatting.js';

describe('AttachmentFormatting', () => {
  it('builds display labels for attachment-only sends', () => {
    expect(attachmentDisplayLabel([
      { name: 'notes.md', path: 'notes.md', type: 'text/markdown', size: 12 },
      { name: 'diagram.png', path: 'diagram.png', type: 'image/png', size: 256 },
    ])).toBe('[Attached: notes.md, diagram.png]');
  });

  it('includes text content and metadata-only attachments in prompt blocks', () => {
    const blocks = attachmentPromptBlocks([
      { name: 'notes.md', path: 'notes.md', type: 'text/markdown', size: 12, content: 'hello' },
      { name: 'diagram.png', path: 'diagram.png', type: 'image/png', size: 256 },
    ]);

    expect(blocks[0]).toBe('[File: notes.md]\nhello');
    expect(blocks[1]).toContain('[Attached file: diagram.png]');
    expect(blocks[1]).toContain('Content not available in message payload.');
    expect(blocks[1]).toContain('type=image/png');
    expect(blocks[1]).toContain('size=256 bytes');
  });

  it('prepends attachment blocks to user text', () => {
    expect(buildPromptContentWithAttachments('please inspect', [
      { name: 'empty.txt', path: 'empty.txt', type: 'text/plain', size: 0, content: '' },
    ])).toBe('[File: empty.txt]\n(empty file)\n\nplease inspect');
  });
});
