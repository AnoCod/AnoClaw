import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleBindWorkspace } from '../WorkspaceHandlers.js';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { SessionStore } from '../../../core/session/SessionStore.js';
import { WsServer } from '../../../infra/network/WsServer.js';

describe('Workspace binding stays filesystem read-only', () => {
  let root = '';
  let sessionId = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-workspace-bind-ro-'));
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    const manager = SessionManager.getInstance();
    await manager.initialize(path.join(root, 'sessions'));
    sessionId = (await manager.createMainSession('agent-main', 'Main', root)).id;
    vi.spyOn(WsServer.getInstance(), 'isConnected').mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('does not create a missing directory while binding', async () => {
    const missing = path.join(root, 'must-not-be-created');
    const capture: { status?: number; body?: Record<string, unknown> } = {};
    await handleBindWorkspace(
      sessionId,
      {} as IncomingMessage,
      {} as ServerResponse,
      (_res, status, body) => { capture.status = status; capture.body = body as Record<string, unknown>; },
      async () => ({ path: missing }),
    );

    expect(capture.status).toBe(400);
    expect(capture.body?.message).toContain('must already exist');
    await expect(fsp.stat(missing)).rejects.toThrow();
  });
});
