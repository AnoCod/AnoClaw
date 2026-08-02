import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { isGitignored, validateOfficeArchiveBuffer } from '../WorkspaceHandlers.js';

describe('workspace preview safety', () => {
  it('accepts a small well-formed Office ZIP', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<document><p>Hello</p></document>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    expect(validateOfficeArchiveBuffer(buffer).has('word/document.xml')).toBe(true);
  });

  it('rejects an archive that declares an oversized decompressed entry', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<slide>Hello</slide>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const centralOffset = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    buffer.writeUInt32LE(21 * 1024 * 1024, centralOffset + 24);

    expect(() => validateOfficeArchiveBuffer(buffer)).toThrow('entry is too large');
  });

  it('rejects compressed data whose actual output disagrees with safe metadata', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<document><p>Hello</p></document>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const centralOffset = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    buffer.writeUInt32LE(1, centralOffset + 24);

    expect(() => validateOfficeArchiveBuffer(buffer)).toThrow('cannot be safely decompressed');
  });
});

describe('workspace gitignore negation', () => {
  it('honors a later negation rule for a previously ignored file', () => {
    const patterns = ['*.log', '!important.log'];

    expect(isGitignored('debug.log', false, patterns)).toBe(true);
    expect(isGitignored('important.log', false, patterns)).toBe(false);
  });

  it('applies rules in file order', () => {
    expect(isGitignored('important.log', false, ['*.log', '!important.log', 'important.log'])).toBe(true);
  });
});
