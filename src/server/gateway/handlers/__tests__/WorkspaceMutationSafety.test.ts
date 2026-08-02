import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleDeleteWorkspaceFile,
  handleMoveWorkspaceFile,
  handleRenameWorkspaceFile,
} from '../WorkspaceHandlers.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { SessionStore } from '../../../core/session/SessionStore.js';
import { WsServer } from '../../../infra/network/WsServer.js';

describe('workspace mutation safety', () => {
  let root = '';
  let workspace = '';
  let sessionId = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-workspace-mutation-'));
    workspace = path.join(root, 'workspace');
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.writeFile(path.join(workspace, 'keep.txt'), 'keep', 'utf8');
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

  it('rejects deleting the bound workspace root', async () => {
    const capture: { status?: number; body?: Record<string, unknown> } = {};
    await handleDeleteWorkspaceFile(
      { url: `/api/v1/workspace/file?path=%2F&sessionId=${encodeURIComponent(sessionId)}` } as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      '127.0.0.1',
      15730,
    );

    expect(capture.status).toBe(400);
    expect(capture.body?.message).toBe('Workspace root cannot be modified');
    await expect(fsp.readFile(path.join(workspace, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('rejects renaming the bound workspace root', async () => {
    const capture: { status?: number; body?: Record<string, unknown> } = {};
    await handleRenameWorkspaceFile(
      {} as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      async () => ({ sessionId, path: '/', newName: 'moved-workspace' }),
    );

    expect(capture.status).toBe(400);
    expect(capture.body?.message).toBe('Workspace root cannot be modified');
    await expect(fsp.stat(workspace)).resolves.toMatchObject({});
    await expect(fsp.stat(path.join(root, 'moved-workspace'))).rejects.toThrow();
  });

  it('rejects moving the bound workspace root', async () => {
    await fsp.mkdir(path.join(workspace, 'destination'));
    const capture: { status?: number; body?: Record<string, unknown> } = {};
    await handleMoveWorkspaceFile(
      {} as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      async () => ({ sessionId, source: '/', destDir: 'destination' }),
    );

    expect(capture.status).toBe(400);
    expect(capture.body?.message).toBe('Workspace root cannot be modified');
    await expect(fsp.readFile(path.join(workspace, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });
});
