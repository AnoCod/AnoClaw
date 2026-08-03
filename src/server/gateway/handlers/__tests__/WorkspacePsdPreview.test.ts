import { describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import { decodePsdPreviewBuffer } from '../WorkspacePsdPreview.js';

describe('Workspace PSD flattened preview', () => {
  it('decodes an 8-bit raw RGB composite without reading layers', () => {
    const psd = makePsd({
      width: 2,
      height: 1,
      channels: 3,
      composite: Buffer.from([255, 0, 0, 255, 0, 0]),
    });

    const preview = decodePsdPreviewBuffer(psd);

    expect(preview).toMatchObject({ mimeType: 'image/png', width: 2, height: 1, source: 'composite' });
    expect(readPngScanlines(preview.data)).toEqual(Buffer.from([
      0,
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]));
  });

  it('decodes PackBits-compressed composite rows', () => {
    const rows = [
      Buffer.from([1, 255, 0]),
      Buffer.from([1, 0, 255]),
      Buffer.from([1, 0, 0]),
    ];
    const counts = Buffer.alloc(rows.length * 2);
    rows.forEach((row, index) => counts.writeUInt16BE(row.length, index * 2));
    const psd = makePsd({
      width: 2,
      height: 1,
      channels: 3,
      compression: 1,
      composite: Buffer.concat([counts, ...rows]),
    });

    expect(readPngScanlines(decodePsdPreviewBuffer(psd).data)).toEqual(Buffer.from([
      0,
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]));
  });

  it.each([
    { compression: 2, encoded: Buffer.from([10, 30, 20, 40, 30, 50]), label: 'ZIP' },
    { compression: 3, encoded: Buffer.from([10, 20, 20, 20, 30, 20]), label: 'ZIP prediction' },
  ])('decodes $label composite rows', ({ compression, encoded }) => {
    const psd = makePsd({
      width: 2,
      height: 1,
      channels: 3,
      compression,
      composite: zlib.deflateSync(encoded),
    });

    expect(readPngScanlines(decodePsdPreviewBuffer(psd).data)).toEqual(Buffer.from([
      0,
      10, 20, 30, 255,
      30, 40, 50, 255,
    ]));
  });

  it('prefers the embedded merged JPEG thumbnail', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const thumbnail = Buffer.alloc(28 + jpeg.length);
    thumbnail.writeUInt32BE(1, 0);
    thumbnail.writeUInt32BE(64, 4);
    thumbnail.writeUInt32BE(32, 8);
    thumbnail.writeUInt32BE(64 * 3, 12);
    thumbnail.writeUInt32BE(jpeg.length, 16);
    thumbnail.writeUInt32BE(jpeg.length, 20);
    thumbnail.writeUInt16BE(24, 24);
    thumbnail.writeUInt16BE(1, 26);
    jpeg.copy(thumbnail, 28);
    const resource = makeResource(1036, thumbnail);
    const psd = makePsd({ width: 64, height: 32, channels: 3, resources: resource, composite: Buffer.alloc(0) });

    expect(decodePsdPreviewBuffer(psd)).toEqual({
      data: jpeg,
      mimeType: 'image/jpeg',
      width: 64,
      height: 32,
      source: 'thumbnail',
    });
  });

  it('rejects maliciously large composite dimensions', () => {
    const psd = makePsd({ width: 100_000, height: 100_000, channels: 3, composite: Buffer.alloc(0) });

    expect(() => decodePsdPreviewBuffer(psd)).toThrow('pixel preview limit');
  });
});

function makePsd(options: {
  width: number;
  height: number;
  channels: number;
  compression?: number;
  resources?: Buffer;
  composite: Buffer;
}): Buffer {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'ascii');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(options.channels, 12);
  header.writeUInt32BE(options.height, 14);
  header.writeUInt32BE(options.width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);
  const resources = options.resources || Buffer.alloc(0);
  const resourceLength = Buffer.alloc(4);
  resourceLength.writeUInt32BE(resources.length, 0);
  const compression = Buffer.alloc(2);
  compression.writeUInt16BE(options.compression || 0, 0);
  return Buffer.concat([
    header,
    Buffer.alloc(4),
    resourceLength,
    resources,
    Buffer.alloc(4),
    compression,
    options.composite,
  ]);
}

function makeResource(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write('8BIM', 0, 'ascii');
  header.writeUInt16BE(id, 4);
  header[6] = 0;
  header[7] = 0;
  header.writeUInt32BE(data.length, 8);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function readPngScanlines(png: Buffer): Buffer {
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return zlib.inflateSync(Buffer.concat(idat));
}
