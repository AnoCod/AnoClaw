import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleInspectWorkspaceArchive,
  handlePreviewWorkspacePsd,
  handleReadWorkspaceFile,
} from '../WorkspaceHandlers.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { SessionStore } from '../../../core/session/SessionStore.js';

describe('Workspace read-only preview handlers', () => {
  let root = '';
  let sessionId = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-workspace-preview-'));
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    const manager = SessionManager.getInstance();
    await manager.initialize(path.join(root, 'sessions'));
    sessionId = (await manager.createMainSession('agent-main', 'Main', root)).id;
  });

  afterEach(async () => {
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('decodes UTF-16 LE text without rewriting the file', async () => {
    const filePath = path.join(root, 'hello.txt');
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好 AnoClaw', 'utf16le')]);
    await fsp.writeFile(filePath, original);
    const capture: { status?: number; body?: Record<string, unknown> } = {};

    await handleReadWorkspaceFile(
      { url: `/api/v1/workspace/read?sessionId=${encodeURIComponent(sessionId)}&path=hello.txt` } as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      '127.0.0.1',
      15730,
    );

    expect(capture.status).toBe(200);
    expect(capture.body).toMatchObject({ content: '你好 AnoClaw', encoding: 'UTF-16 LE', truncated: false });
    expect(await fsp.readFile(filePath)).toEqual(original);
  });

  it('lists ZIP-family archives in natural path order without extracting them', async () => {
    const zip = new JSZip();
    zip.file('assets/file10.txt', 'ten');
    zip.file('assets/file2.txt', 'two');
    zip.file('README.md', '# Preview');
    await fsp.writeFile(path.join(root, 'sample.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const capture: { status?: number; body?: Record<string, unknown> } = {};

    await handleInspectWorkspaceArchive(
      { url: `/api/v1/workspace/inspect-archive?sessionId=${encodeURIComponent(sessionId)}&path=sample.zip` } as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      '127.0.0.1',
      15730,
    );

    expect(capture.status).toBe(200);
    const entries = capture.body?.entries as Array<{ path: string }>;
    expect(entries.map(entry => entry.path)).toEqual([
      'assets/',
      'assets/file2.txt',
      'assets/file10.txt',
      'README.md',
    ]);
    await expect(fsp.stat(path.join(root, 'assets'))).rejects.toThrow();
  });

  it('returns a flattened PSD preview without modifying the source document', async () => {
    const header = Buffer.alloc(26);
    header.write('8BPS', 0, 'ascii');
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(3, 12);
    header.writeUInt32BE(1, 14);
    header.writeUInt32BE(1, 18);
    header.writeUInt16BE(8, 22);
    header.writeUInt16BE(3, 24);
    const layerData = Buffer.from('layer-data-must-be-skipped', 'ascii');
    const layerLength = Buffer.alloc(4);
    layerLength.writeUInt32BE(layerData.length, 0);
    const original = Buffer.concat([
      header,
      Buffer.alloc(4),
      Buffer.alloc(4),
      layerLength,
      layerData,
      Buffer.alloc(2),
      Buffer.from([40, 80, 120]),
    ]);
    const filePath = path.join(root, 'design.psd');
    await fsp.writeFile(filePath, original);
    const capture: { status?: number; headers?: Record<string, string | number>; data?: Buffer } = {};
    const response = {
      writeHead: (status: number, headers: Record<string, string | number>) => {
        capture.status = status;
        capture.headers = headers;
      },
      end: (data?: Buffer) => { capture.data = data; },
    } as unknown as ServerResponse;

    await handlePreviewWorkspacePsd(
      { url: `/api/v1/workspace/preview-psd?sessionId=${encodeURIComponent(sessionId)}&path=design.psd` } as IncomingMessage,
      response,
      () => { throw new Error('Expected an image response'); },
      '127.0.0.1',
      15730,
    );

    expect(capture.status).toBe(200);
    expect(capture.headers).toMatchObject({
      'Content-Type': 'image/png',
      'X-AnoClaw-Psd-Source': 'composite',
      'X-AnoClaw-Image-Width': 1,
      'X-AnoClaw-Image-Height': 1,
    });
    expect(capture.data?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(await fsp.readFile(filePath)).toEqual(original);
  });
});
