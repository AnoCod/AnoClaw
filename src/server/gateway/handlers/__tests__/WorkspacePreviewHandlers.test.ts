import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleInspectWorkspaceArchive,
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
});
