import { describe, expect, it } from 'vitest';
import {
  detectWorkspaceBinarySignature,
  parseWorkspaceConfig,
} from '../WorkspacePreviewParsers.js';

describe('Workspace read-only preview parsers', () => {
  it('parses INI, properties, and env assignments without evaluating values', () => {
    const parsed = parseWorkspaceConfig([
      '; comment',
      '[database]',
      'host = localhost',
      'port: 5432',
      'export TOKEN=${UNCHANGED}',
      '"url:key" = https://example.test:8443/path',
    ].join('\n'));

    expect(parsed).toEqual({
      truncated: false,
      entries: [
        { section: 'database', key: 'host', value: 'localhost', line: 3 },
        { section: 'database', key: 'port', value: '5432', line: 4 },
        { section: 'database', key: 'TOKEN', value: '${UNCHANGED}', line: 5 },
        { section: 'database', key: '"url:key"', value: 'https://example.test:8443/path', line: 6 },
      ],
    });
  });

  it('limits very large configuration previews', () => {
    expect(parseWorkspaceConfig('a=1\nb=2', 1)).toMatchObject({
      truncated: true,
      entries: [{ key: 'a', value: '1' }],
    });
  });

  it('identifies common and uncommon binary signatures', () => {
    expect(detectWorkspaceBinarySignature(Uint8Array.from([0x00, 0x61, 0x73, 0x6d]), 'bin')).toBe('WebAssembly module');
    expect(detectWorkspaceBinarySignature(new TextEncoder().encode('SQLite format 3\0'), 'db')).toBe('SQLite database');
    expect(detectWorkspaceBinarySignature(Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]), 'h5')).toBe('HDF5 scientific data');
    expect(detectWorkspaceBinarySignature(Uint8Array.from([0x0a, 0x0d, 0x0d, 0x0a]), 'pcapng')).toBe('PCAP-NG network capture');
    expect(detectWorkspaceBinarySignature(Uint8Array.from([1, 2, 3]), 'bin')).toBe('BIN binary data');
  });
});
