import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setSessionModeHandler } from '../SetSessionModeHandler.js';
import { SessionManager } from '../../../../core/session/SessionManager.js';
import { SessionStore } from '../../../../core/session/SessionStore.js';
import type { Transport } from '../../Transport.js';

describe('SetSessionModeHandler', () => {
  let tmpDir = '';
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-mode-'));
    (SessionManager as unknown as { _instance?: SessionManager })._instance = undefined;
    (SessionStore as unknown as { _instance?: SessionStore })._instance = undefined;
    manager = SessionManager.getInstance();
    await manager.initialize(path.join(tmpDir, 'sessions'));
  });

  afterEach(async () => {
    if (tmpDir && path.basename(tmpDir).startsWith('anoclaw-mode-')) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps Goal on Auto Edit while preserving the requested session preference', async () => {
    const session = await manager.createMainSession('agent-main', 'Goal Session', tmpDir);
    await manager.setGoal(session.id, { objective: 'keep going', permissionMode: 'AutoEdit' });
    const sends: Array<{ sessionId: string; event: Record<string, unknown> }> = [];
    const ws = {
      send: (sessionId: string, event: Record<string, unknown>) => {
        sends.push({ sessionId, event });
        return true;
      },
      broadcast: () => {},
      isConnected: () => true,
      activeSessions: () => [],
      shutdown: async () => {},
      on: () => {},
    } satisfies Transport;

    await setSessionModeHandler({
      sessionId: session.id,
      type: 'set_session_mode',
      data: { mode: 'ask', effort: true },
      ws,
    });

    expect(manager.getSessionPermissionMode(session.id)).toBe('Ask');
    expect(sends.at(-1)?.event).toMatchObject({
      type: 'session_mode_changed',
      mode: 'auto-edit',
      storedMode: 'ask',
      effort: true,
    });
  });

  it('locks sub-sessions to Auto Edit regardless of requested mode', async () => {
    const root = await manager.createMainSession('agent-main', 'Root Session', tmpDir);
    const child = await manager.createSubSession(root.id, 'agent-child', 'Delegated work');
    const sends: Array<{ sessionId: string; event: Record<string, unknown> }> = [];
    const ws = {
      send: (sessionId: string, event: Record<string, unknown>) => {
        sends.push({ sessionId, event });
        return true;
      },
      broadcast: () => {},
      isConnected: () => true,
      activeSessions: () => [],
      shutdown: async () => {},
      on: () => {},
    } satisfies Transport;

    await setSessionModeHandler({
      sessionId: child.id,
      type: 'set_session_mode',
      data: { mode: 'plan', effort: false },
      ws,
    });

    expect(manager.getSessionPermissionMode(child.id)).toBe('AutoEdit');
    expect(sends.at(-1)?.event).toMatchObject({
      type: 'session_mode_changed',
      mode: 'auto-edit',
      storedMode: 'auto-edit',
      effort: true,
      locked: true,
    });
  });
});
