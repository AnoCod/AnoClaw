export interface WorkspaceConfigEntry {
  section: string;
  key: string;
  value: string;
  line: number;
}

export interface WorkspaceConfigPreview {
  entries: WorkspaceConfigEntry[];
  truncated: boolean;
}

/** Parse common INI/properties/env-style files without evaluating substitutions. */
export function parseWorkspaceConfig(content: string, limit = 1000): WorkspaceConfigPreview {
  const entries: WorkspaceConfigEntry[] = [];
  let section = '';
  let truncated = false;
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r\n?|\n/);

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const sectionMatch = /^\[([^\]]+)\](?:\s*[;#].*)?$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
    const delimiter = findConfigDelimiter(normalized);
    if (delimiter <= 0) continue;
    const key = normalized.slice(0, delimiter).trim();
    if (!key) continue;
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    entries.push({
      section,
      key,
      value: normalized.slice(delimiter + 1).trim(),
      line: index + 1,
    });
  }

  return { entries, truncated };
}

function findConfigDelimiter(value: string): number {
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '=' || character === ':') return index;
  }
  return -1;
}

/** Identify common binary containers from their magic bytes; never executes content. */
export function detectWorkspaceBinarySignature(bytes: Uint8Array, extension = ''): string {
  const startsWith = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  const asciiAt = (offset: number, value: string) => {
    if (offset + value.length > bytes.length) return false;
    for (let index = 0; index < value.length; index++) {
      if (bytes[offset + index] !== value.charCodeAt(index)) return false;
    }
    return true;
  };

  if (startsWith(0x4d, 0x5a)) return 'PE / DOS executable';
  if (startsWith(0x7f, 0x45, 0x4c, 0x46)) return 'ELF executable';
  if (startsWith(0xca, 0xfe, 0xba, 0xbe)) return 'Java class / Mach-O universal';
  if (startsWith(0x00, 0x61, 0x73, 0x6d)) return 'WebAssembly module';
  if (startsWith(0xcf, 0xfa, 0xed, 0xfe) || startsWith(0xfe, 0xed, 0xfa, 0xcf)
    || startsWith(0xce, 0xfa, 0xed, 0xfe) || startsWith(0xfe, 0xed, 0xfa, 0xce)) return 'Mach-O executable';
  if (asciiAt(0, 'SQLite format 3\0')) return 'SQLite database';
  if (startsWith(0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a)) return 'HDF5 scientific data';
  if (asciiAt(0, 'CDF\u0001') || asciiAt(0, 'CDF\u0002') || asciiAt(0, 'CDF\u0005')) return 'NetCDF scientific data';
  if (startsWith(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59)) return 'NumPy array';
  if (startsWith(0x0a, 0x0d, 0x0d, 0x0a)) return 'PCAP-NG network capture';
  if (startsWith(0xd4, 0xc3, 0xb2, 0xa1) || startsWith(0xa1, 0xb2, 0xc3, 0xd4)
    || startsWith(0x4d, 0x3c, 0xb2, 0xa1) || startsWith(0xa1, 0xb2, 0x3c, 0x4d)) return 'PCAP network capture';
  if (startsWith(0x51, 0x46, 0x49, 0xfb)) return 'QCOW disk image';
  if (asciiAt(0, 'KDMV')) return 'VMDK disk image';
  if (startsWith(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7-Zip archive';
  if (startsWith(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'RAR archive';
  if (startsWith(0x1f, 0x8b)) return 'GZIP stream';
  if (asciiAt(0, 'BZh')) return 'BZIP2 stream';
  if (startsWith(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'XZ stream';
  if (startsWith(0x28, 0xb5, 0x2f, 0xfd)) return 'Zstandard stream';
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'OLE compound document';
  if (asciiAt(0, 'MSCF')) return 'Microsoft Cabinet archive';
  if (startsWith(0xed, 0xab, 0xee, 0xdb)) return 'RPM package';
  if (asciiAt(0, '!<arch>\n')) return 'Unix archive / Debian package';
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) return 'ZIP container';
  if (asciiAt(0, '%PDF-')) return 'PDF document';
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'PNG image';
  if (startsWith(0xff, 0xd8, 0xff)) return 'JPEG image';
  if (asciiAt(0, 'GIF87a') || asciiAt(0, 'GIF89a')) return 'GIF image';
  if (asciiAt(0, 'BM')) return 'BMP image';
  if (asciiAt(0, 'II*\0') || asciiAt(0, 'MM\0*')) return 'TIFF image';
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) return 'WebP image';
  if (asciiAt(0, '8BPS')) return 'Adobe Photoshop document';
  if (asciiAt(0, 'gimp xcf ')) return 'GIMP XCF document';
  if (asciiAt(0, 'glTF')) return 'glTF binary scene';
  if (asciiAt(0, 'PAR1')) return 'Apache Parquet data';
  if (asciiAt(0, 'ARROW1')) return 'Apache Arrow data';
  if (asciiAt(0, 'BLENDER')) return 'Blender project';
  if (asciiAt(0, 'dex\n')) return 'Android DEX bytecode';
  if (startsWith(0xac, 0xed, 0x00, 0x05)) return 'Java serialized data';
  if (startsWith(0x1b, 0x4c, 0x75, 0x61)) return 'Lua bytecode';
  if (asciiAt(0, 'MThd')) return 'MIDI sequence';
  if (asciiAt(0, 'OggS')) return 'Ogg media stream';
  if (asciiAt(0, 'fLaC')) return 'FLAC audio';
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WAVE')) return 'WAVE audio';
  if (asciiAt(4, 'ftyp')) return 'ISO base media container';
  if (asciiAt(0, 'MATLAB 5.0 MAT-file')) return 'MATLAB data';
  if (asciiAt(0, 'SIMPLE  =')) return 'FITS scientific image';
  if (asciiAt(257, 'ustar')) return 'TAR archive';
  if (asciiAt(128, 'DICM')) return 'DICOM medical image';
  if (asciiAt(32769, 'CD001')) return 'ISO 9660 image';

  const normalized = String(extension || '').replace(/^\./, '').trim().toUpperCase();
  return normalized ? `${normalized} binary data` : 'Unknown binary data';
}
