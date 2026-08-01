import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleWriteWorkspaceFile } from '../WorkspaceHandlers.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { SessionStore } from '../../../core/session/SessionStore.js';
import { WsServer } from '../../../infra/network/WsServer.js';

describe('workspace optimistic writes', () => {
  let root = '';
  let workspace = '';
  let sessionId = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-workspace-write-'));
    workspace = path.join(root, 'workspace');
    await fsp.mkdir(workspace, { recursive: true });
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    const manager = SessionManager.getInstance();
    await manager.initialize(path.join(root, 'sessions'));
    sessionId = (await manager.createMainSession('agent-main', 'Main', workspace)).id;
    vi.spyOn(WsServer.getInstance(), 'isConnected').mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('rejects a stale editor revision instead of overwriting an external change', async () => {
    const filePath = path.join(workspace, 'note.txt');
    await fsp.writeFile(filePath, 'opened version', 'utf8');
    const openedSha = createHash('sha256').update('opened version').digest('hex');
    await fsp.writeFile(filePath, 'agent version', 'utf8');

    const capture: { status?: number; body?: Record<string, unknown> } = {};
    await handleWriteWorkspaceFile(
      {} as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      async () => ({
        sessionId,
        path: 'note.txt',
        content: 'editor version',
        expectedSha256: openedSha,
      }),
    );

    expect(capture.status).toBe(409);
    expect(capture.body?.error).toBe('Conflict');
    await expect(fsp.readFile(filePath, 'utf8')).resolves.toBe('agent version');
  });

  it('atomically saves and returns the new revision when the expected hash matches', async () => {
    const filePath = path.join(workspace, 'note.txt');
    await fsp.writeFile(filePath, 'opened version', 'utf8');
    const openedSha = createHash('sha256').update('opened version').digest('hex');
    const capture: { status?: number; body?: Record<string, unknown> } = {};

    await handleWriteWorkspaceFile(
      {} as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      async () => ({
        sessionId,
        path: 'note.txt',
        content: 'editor version',
        expectedSha256: openedSha,
      }),
    );

    expect(capture.status).toBe(200);
    expect(capture.body?.sha256).toBe(createHash('sha256').update('editor version').digest('hex'));
    await expect(fsp.readFile(filePath, 'utf8')).resolves.toBe('editor version');
  });

  it('serializes compare-and-swap writes so only one concurrent revision wins', async () => {
    const filePath = path.join(workspace, 'note.txt');
    await fsp.writeFile(filePath, 'opened version', 'utf8');
    const openedSha = createHash('sha256').update('opened version').digest('hex');
    const captures = [
      {} as { status?: number; body?: Record<string, unknown> },
      {} as { status?: number; body?: Record<string, unknown> },
    ];

    await Promise.all(['first editor', 'second editor'].map((content, index) =>
      handleWriteWorkspaceFile(
        {} as IncomingMessage,
        {} as ServerResponse,
        (_res, status, body) => {
          captures[index].status = status;
          captures[index].body = body as Record<string, unknown>;
        },
        async () => ({
          sessionId,
          path: 'note.txt',
          content,
          expectedSha256: openedSha,
        }),
      )
    ));

    expect(captures.map((capture) => capture.status).sort()).toEqual([200, 409]);
    await expect(fsp.readFile(filePath, 'utf8')).resolves.toBe('first editor');
  });
});
