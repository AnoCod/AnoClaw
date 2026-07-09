import { describe, expect, it } from 'vitest';
import {
  attachmentTextBlocks,
  buildUserContent,
  hasSendableUserPayload,
} from '../SendMessageHandler.js';

describe('SendMessageHandler attachment helpers', () => {
  it('allows attachment-only messages through the send payload guard', () => {
    expect(hasSendableUserPayload('', [{ name: 'notes.md', content: 'hello' }])).toBe(true);
    expect(hasSendableUserPayload('  ', [{ name: 'diagram.png', type: 'image/png' }])).toBe(true);
    expect(hasSendableUserPayload('  ', [])).toBe(false);
  });

  it('formats text, empty text, and metadata-only attachments', () => {
    const blocks = attachmentTextBlocks([
      { name: 'notes.md', type: 'text/markdown', size: 5, content: 'hello' },
      { name: 'empty.txt', type: 'text/plain', size: 0, content: '' },
      { name: 'diagram.png', type: 'image/png', size: 256 },
    ]);

    expect(blocks[0]).toBe('[File: notes.md]\nhello');
    expect(blocks[1]).toBe('[File: empty.txt]\n(empty file)');
    expect(blocks[2]).toContain('[Attached file: diagram.png]');
    expect(blocks[2]).toContain('Content not available in message payload.');
    expect(blocks[2]).toContain('type=image/png');
    expect(blocks[2]).toContain('size=256 bytes');
  });

  it('builds the user content that AgentLoop receives', () => {
    expect(buildUserContent('please inspect this', [
      { name: 'notes.md', content: 'hello' },
    ])).toBe('[File: notes.md]\nhello\n\nplease inspect this');

    expect(buildUserContent('', [
      { name: 'archive.zip', type: 'application/zip', size: 1000 },
    ])).toContain('[Attached file: archive.zip]');

    expect(buildUserContent('  ', [
      { name: 'notes.md', content: 'hello' },
    ])).toBe('[File: notes.md]\nhello');
  });
});
