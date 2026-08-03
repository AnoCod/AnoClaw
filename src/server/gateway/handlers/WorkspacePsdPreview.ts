import * as fsp from 'node:fs/promises';
import * as zlib from 'node:zlib';

const MAX_PSD_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PSD_COLOR_MODE_BYTES = 4 * 1024 * 1024;
const MAX_PSD_COMPOSITE_READ_BYTES = 192 * 1024 * 1024;
const MAX_PSD_PREVIEW_PIXELS = 32_000_000;
const MAX_PSD_DECODED_BYTES = 192 * 1024 * 1024;

export interface PsdPreviewImage {
  data: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  source: 'thumbnail' | 'composite';
}

interface PsdHeader {
  version: 1 | 2;
  channels: number;
  width: number;
  height: number;
  depth: number;
  colorMode: number;
}

interface PsdSections {
  header: PsdHeader;
  colorModeData: Buffer;
  resources: Buffer;
  imageDataOffset: number;
}

export class PsdPreviewError extends Error {
  constructor(message: string, readonly statusCode = 422) {
    super(message);
    this.name = 'PsdPreviewError';
  }
}

/** Seek past layer data and read only the thumbnail resources or merged composite. */
export async function createPsdPreview(filePath: string, fileSize: number): Promise<PsdPreviewImage> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const initial = await readExactly(handle, 30, 0, 30, 'PSD header');
    const header = parsePsdHeader(initial);
    const colorModeLength = initial.readUInt32BE(26);
    const resourceLengthOffset = checkedOffset(30, colorModeLength, fileSize);
    const resourceLengthBuffer = await readExactly(handle, 4, resourceLengthOffset, 4, 'PSD resource length');
    const resourceLength = resourceLengthBuffer.readUInt32BE(0);
    const resourceStart = checkedOffset(resourceLengthOffset, 4, fileSize);
    const layerLengthOffset = checkedOffset(resourceStart, resourceLength, fileSize);

    if (resourceLength <= MAX_PSD_RESOURCE_BYTES) {
      const resources = await readExactly(
        handle,
        resourceLength,
        resourceStart,
        MAX_PSD_RESOURCE_BYTES,
        'PSD resource section',
      );
      const thumbnail = extractPsdThumbnail(resources);
      if (thumbnail) return thumbnail;
    }

    if (colorModeLength > MAX_PSD_COLOR_MODE_BYTES) {
      throw new PsdPreviewError('PSD color mode data exceeds the safe preview limit', 413);
    }
    const colorModeData = await readExactly(
      handle,
      colorModeLength,
      30,
      MAX_PSD_COLOR_MODE_BYTES,
      'PSD color mode data',
    );
    const layerLengthBytes = header.version === 1 ? 4 : 8;
    const layerLengthBuffer = await readExactly(
      handle,
      layerLengthBytes,
      layerLengthOffset,
      layerLengthBytes,
      'PSD layer section length',
    );
    const layerLengthValue = header.version === 1
      ? BigInt(layerLengthBuffer.readUInt32BE(0))
      : layerLengthBuffer.readBigUInt64BE(0);
    if (layerLengthValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PsdPreviewError('PSB layer section is too large', 413);
    }
    const compositeOffset = checkedOffset(
      checkedOffset(layerLengthOffset, layerLengthBytes, fileSize),
      Number(layerLengthValue),
      fileSize,
    );
    const compositeLength = fileSize - compositeOffset;
    if (compositeLength > MAX_PSD_COMPOSITE_READ_BYTES) {
      throw new PsdPreviewError('PSD merged composite exceeds the safe preview limit', 413);
    }
    const composite = await readExactly(
      handle,
      compositeLength,
      compositeOffset,
      MAX_PSD_COMPOSITE_READ_BYTES,
      'PSD merged composite',
    );
    const colorLength = Buffer.alloc(4);
    colorLength.writeUInt32BE(colorModeData.length, 0);
    return decodePsdPreviewBuffer(Buffer.concat([
      initial.subarray(0, 26),
      colorLength,
      colorModeData,
      Buffer.alloc(4),
      Buffer.alloc(layerLengthBytes),
      composite,
    ]));
  } finally {
    await handle.close();
  }
}

/** Decode only the document-level merged image; layer pixels and layer metadata are ignored. */
export function decodePsdPreviewBuffer(buffer: Buffer): PsdPreviewImage {
  const sections = parsePsdSections(buffer);
  const thumbnail = extractPsdThumbnail(sections.resources);
  if (thumbnail) return thumbnail;

  const { header } = sections;
  const pixelCount = header.width * header.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount <= 0 || pixelCount > MAX_PSD_PREVIEW_PIXELS) {
    throw new PsdPreviewError(`PSD canvas exceeds the ${MAX_PSD_PREVIEW_PIXELS}-pixel preview limit`, 413);
  }
  if (header.depth !== 8 && !(header.colorMode === 0 && header.depth === 1)) {
    throw new PsdPreviewError(`PSD ${header.depth}-bit composite preview requires an embedded thumbnail`);
  }

  const requiredChannels = requiredColorChannels(header.colorMode);
  if (requiredChannels === 0 || header.channels < requiredChannels) {
    throw new PsdPreviewError(`Unsupported PSD color mode: ${header.colorMode}`);
  }
  if (header.colorMode === 2 && sections.colorModeData.length < 768) {
    throw new PsdPreviewError('Indexed PSD is missing its color palette');
  }

  const rowBytes = header.depth === 1 ? Math.ceil(header.width / 8) : header.width;
  const decodedLength = rowBytes * header.height * header.channels;
  if (!Number.isSafeInteger(decodedLength) || decodedLength <= 0 || decodedLength > MAX_PSD_DECODED_BYTES) {
    throw new PsdPreviewError('PSD composite expands beyond the preview memory limit', 413);
  }
  const planes = decodeCompositePlanes(buffer, sections.imageDataOffset, header, rowBytes, decodedLength);
  const rgba = Buffer.allocUnsafe(pixelCount * 4);
  const planeSize = rowBytes * header.height;
  const alphaChannel = header.depth === 1 || header.channels <= requiredChannels ? -1 : requiredChannels;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const output = pixel * 4;
    let red: number;
    let green: number;
    let blue: number;
    if (header.colorMode === 3) {
      red = planes[pixel];
      green = planes[planeSize + pixel];
      blue = planes[planeSize * 2 + pixel];
    } else if (header.colorMode === 2) {
      const paletteIndex = planes[pixel];
      red = sections.colorModeData[paletteIndex];
      green = sections.colorModeData[256 + paletteIndex];
      blue = sections.colorModeData[512 + paletteIndex];
    } else if (header.colorMode === 0) {
      const row = Math.floor(pixel / header.width);
      const column = pixel % header.width;
      const packed = planes[row * rowBytes + Math.floor(column / 8)];
      const value = (packed & (0x80 >> (column % 8))) === 0 ? 255 : 0;
      red = green = blue = value;
    } else {
      red = green = blue = planes[pixel];
    }
    rgba[output] = red;
    rgba[output + 1] = green;
    rgba[output + 2] = blue;
    rgba[output + 3] = alphaChannel >= 0 ? planes[planeSize * alphaChannel + pixel] : 255;
  }

  return {
    data: encodeRgbaPng(header.width, header.height, rgba),
    mimeType: 'image/png',
    width: header.width,
    height: header.height,
    source: 'composite',
  };
}

function parsePsdHeader(buffer: Buffer): PsdHeader {
  ensureRange(buffer, 0, 26, 'PSD header');
  if (buffer.toString('ascii', 0, 4) !== '8BPS') throw new PsdPreviewError('Invalid PSD signature', 400);
  const version = buffer.readUInt16BE(4);
  if (version !== 1 && version !== 2) throw new PsdPreviewError(`Unsupported PSD version: ${version}`, 400);
  const channels = buffer.readUInt16BE(12);
  const height = buffer.readUInt32BE(14);
  const width = buffer.readUInt32BE(18);
  const depth = buffer.readUInt16BE(22);
  const colorMode = buffer.readUInt16BE(24);
  if (channels < 1 || channels > 56 || width < 1 || height < 1) {
    throw new PsdPreviewError('Invalid PSD dimensions or channel count', 400);
  }
  return { version, channels, width, height, depth, colorMode };
}

function parsePsdSections(buffer: Buffer): PsdSections {
  const header = parsePsdHeader(buffer);
  let offset = 26;
  const colorLength = readUInt32(buffer, offset, 'color mode length');
  offset = checkedBufferOffset(buffer, offset + 4, colorLength, 'color mode data');
  const colorModeData = buffer.subarray(offset - colorLength, offset);
  const resourceLength = readUInt32(buffer, offset, 'image resource length');
  offset = checkedBufferOffset(buffer, offset + 4, resourceLength, 'image resources');
  const resources = buffer.subarray(offset - resourceLength, offset);

  let layerLength: number;
  if (header.version === 1) {
    layerLength = readUInt32(buffer, offset, 'layer and mask length');
    offset += 4;
  } else {
    ensureRange(buffer, offset, 8, 'PSB layer and mask length');
    const value = buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new PsdPreviewError('PSB layer section is too large', 413);
    layerLength = Number(value);
    offset += 8;
  }
  offset = checkedBufferOffset(buffer, offset, layerLength, 'layer and mask data');
  ensureRange(buffer, offset, 2, 'composite compression');
  return { header, colorModeData, resources, imageDataOffset: offset };
}

function extractPsdThumbnail(resources: Buffer): PsdPreviewImage | null {
  let offset = 0;
  let legacy: PsdPreviewImage | null = null;
  while (offset + 12 <= resources.length) {
    const signature = resources.toString('ascii', offset, offset + 4);
    if (signature !== '8BIM' && signature !== 'MeSa') break;
    const id = resources.readUInt16BE(offset + 4);
    offset += 6;
    const nameLength = resources[offset];
    const pascalLength = 1 + nameLength;
    offset += pascalLength + (pascalLength % 2);
    ensureRange(resources, offset, 4, 'PSD resource size');
    const dataLength = resources.readUInt32BE(offset);
    offset += 4;
    ensureRange(resources, offset, dataLength, 'PSD resource data');
    if (id === 1033 || id === 1036) {
      const thumbnail = decodeThumbnailResource(resources.subarray(offset, offset + dataLength), id === 1033);
      if (thumbnail && id === 1036) return thumbnail;
      if (thumbnail) legacy = thumbnail;
    }
    offset += dataLength + (dataLength % 2);
  }
  return legacy;
}

function decodeThumbnailResource(data: Buffer, legacyBgr: boolean): PsdPreviewImage | null {
  if (data.length < 28) return null;
  const format = data.readUInt32BE(0);
  const width = data.readUInt32BE(4);
  const height = data.readUInt32BE(8);
  const rowBytes = data.readUInt32BE(12);
  const compressedSize = data.readUInt32BE(20);
  const bitsPerPixel = data.readUInt16BE(24);
  const planes = data.readUInt16BE(26);
  if (!width || !height || width * height > MAX_PSD_PREVIEW_PIXELS) return null;
  const payloadLength = Math.min(compressedSize || data.length - 28, data.length - 28);
  const payload = data.subarray(28, 28 + payloadLength);
  if (format === 1 && payload.length >= 4 && payload[0] === 0xff && payload[1] === 0xd8) {
    return { data: Buffer.from(payload), mimeType: 'image/jpeg', width, height, source: 'thumbnail' };
  }
  if (format !== 0 || bitsPerPixel !== 24 || planes !== 1 || rowBytes < width * 3 || payload.length < rowBytes * height) {
    return null;
  }
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = y * rowBytes + x * 3;
      const target = (y * width + x) * 4;
      rgba[target] = payload[source + (legacyBgr ? 2 : 0)];
      rgba[target + 1] = payload[source + 1];
      rgba[target + 2] = payload[source + (legacyBgr ? 0 : 2)];
      rgba[target + 3] = 255;
    }
  }
  return { data: encodeRgbaPng(width, height, rgba), mimeType: 'image/png', width, height, source: 'thumbnail' };
}

function requiredColorChannels(colorMode: number): number {
  if (colorMode === 0 || colorMode === 1 || colorMode === 2) return 1;
  if (colorMode === 3) return 3;
  return 0;
}

function decodeCompositePlanes(
  buffer: Buffer,
  imageDataOffset: number,
  header: PsdHeader,
  rowBytes: number,
  decodedLength: number,
): Buffer {
  const compression = buffer.readUInt16BE(imageDataOffset);
  let offset = imageDataOffset + 2;
  if (compression === 0) {
    ensureRange(buffer, offset, decodedLength, 'raw PSD composite');
    return Buffer.from(buffer.subarray(offset, offset + decodedLength));
  }
  if (compression === 1) {
    const rowCount = header.channels * header.height;
    const countBytes = header.version === 1 ? 2 : 4;
    ensureRange(buffer, offset, rowCount * countBytes, 'PSD RLE row lengths');
    const counts: number[] = [];
    for (let index = 0; index < rowCount; index++) {
      counts.push(countBytes === 2 ? buffer.readUInt16BE(offset) : buffer.readUInt32BE(offset));
      offset += countBytes;
    }
    const output = Buffer.allocUnsafe(decodedLength);
    for (let row = 0; row < rowCount; row++) {
      const encodedLength = counts[row];
      ensureRange(buffer, offset, encodedLength, 'PSD RLE row');
      decodePackBitsRow(buffer.subarray(offset, offset + encodedLength), output, row * rowBytes, rowBytes);
      offset += encodedLength;
    }
    return output;
  }
  if (compression === 2 || compression === 3) {
    let output: Buffer;
    try {
      output = zlib.inflateSync(buffer.subarray(offset), { maxOutputLength: decodedLength });
    } catch {
      throw new PsdPreviewError('PSD ZIP composite cannot be safely decompressed');
    }
    if (output.length !== decodedLength) throw new PsdPreviewError('PSD ZIP composite length is invalid');
    if (compression === 3) {
      if (header.depth !== 8) throw new PsdPreviewError('Predicted ZIP preview is supported only for 8-bit PSD composites');
      for (let plane = 0; plane < header.channels; plane++) {
        for (let row = 0; row < header.height; row++) {
          const rowOffset = (plane * header.height + row) * rowBytes;
          for (let column = 1; column < rowBytes; column++) {
            output[rowOffset + column] = (output[rowOffset + column] + output[rowOffset + column - 1]) & 0xff;
          }
        }
      }
    }
    return output;
  }
  throw new PsdPreviewError(`Unsupported PSD composite compression: ${compression}`);
}

function decodePackBitsRow(encoded: Buffer, output: Buffer, outputOffset: number, expectedLength: number): void {
  let inputOffset = 0;
  let written = 0;
  while (inputOffset < encoded.length && written < expectedLength) {
    const marker = encoded.readInt8(inputOffset++);
    if (marker >= 0) {
      const length = marker + 1;
      if (inputOffset + length > encoded.length || written + length > expectedLength) {
        throw new PsdPreviewError('Invalid PSD PackBits literal run');
      }
      encoded.copy(output, outputOffset + written, inputOffset, inputOffset + length);
      inputOffset += length;
      written += length;
    } else if (marker >= -127) {
      if (inputOffset >= encoded.length) throw new PsdPreviewError('Invalid PSD PackBits repeat run');
      const length = 1 - marker;
      if (written + length > expectedLength) throw new PsdPreviewError('PSD PackBits row exceeds its declared width');
      output.fill(encoded[inputOffset++], outputOffset + written, outputOffset + written + length);
      written += length;
    }
  }
  if (written !== expectedLength) throw new PsdPreviewError('PSD PackBits row is shorter than its declared width');
}

function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const scanlines = Buffer.allocUnsafe((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const target = row * (stride + 1);
    scanlines[target] = 0;
    rgba.copy(scanlines, target + 1, row * stride, (row + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const value of data) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readExactly(
  handle: fsp.FileHandle,
  length: number,
  position: number,
  maxLength: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw new PsdPreviewError(`${label} exceeds the safe preview limit`, 413);
  }
  const buffer = Buffer.alloc(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await handle.read(buffer, totalRead, length - totalRead, position + totalRead);
    if (bytesRead === 0) throw new PsdPreviewError('PSD file ended unexpectedly', 400);
    totalRead += bytesRead;
  }
  return buffer;
}

function readUInt32(buffer: Buffer, offset: number, label: string): number {
  ensureRange(buffer, offset, 4, label);
  return buffer.readUInt32BE(offset);
}

function checkedBufferOffset(buffer: Buffer, offset: number, length: number, label: string): number {
  ensureRange(buffer, offset, length, label);
  return offset + length;
}

function checkedOffset(offset: number, length: number, fileSize: number): number {
  const result = offset + length;
  if (!Number.isSafeInteger(result) || offset < 0 || length < 0 || result > fileSize) {
    throw new PsdPreviewError('PSD section exceeds the file boundary', 400);
  }
  return result;
}

function ensureRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new PsdPreviewError(`${label} exceeds the file boundary`, 400);
  }
}
