import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionManager } from '../../../core/session/SessionManager.js';
import { SessionStore } from '../../../core/session/SessionStore.js';
import {
  ActiveSessionRoute,
  HardDeleteSessionRoute,
  InterruptSessionRoute,
  InterruptStatusRoute,
  SessionGarbageCollectRoute,
  SessionListFilteredRoute,
  SessionMetadataRoute,
  SessionParentRoute,
  SessionRootRoute,
  SetActiveSessionRoute,
} from '../SessionControlRoutes.js';

interface Capture {
  status: number;
  body: Record<string, unknown>;
}

function mockReq(body: Record<string, unknown> = {}): IncomingMessage {
  const chunks = [Buffer.from(JSON.stringify(body))];
  let req: IncomingMessage;
  req = {
    on: (event: string, callback: (...args: unknown[]) => void) => {
      if (event === 'data') {
        for (const chunk of chunks) callback(chunk);
      }
      if (event === 'end') callback();
      return req;
    },
    headers: {},
    method: 'PATCH',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
  return req;
}

function mockRes(capture: Capture): ServerResponse {
  return {
    writeHead: (status: number) => {
      capture.status = status;
    },
    end: (data?: string) => {
      if (data) capture.body = JSON.parse(data) as Record<string, unknown>;
    },
    setHeader: () => {},
    getHeader: () => undefined,
  } as unknown as ServerResponse;
}

function routeMatch(sessionId: string) {
  return {
    segments: ['api', 'v1', 'sessions', sessionId],
    params: { id: sessionId },
    query: new URLSearchParams(),
  };
}

describe('SessionControlRoutes', () => {
  let tmpDir = '';
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-session-routes-'));
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    manager = SessionManager.getInstance();
    await manager.initialize(path.join(tmpDir, 'sessions'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    if (tmpDir && path.basename(tmpDir).startsWith('anoclaw-session-routes-')) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists metadata and returns 404 for an unknown session', async () => {
    const session = await manager.createMainSession(
      'agent-main',
      'Main',
      path.join(tmpDir, 'workspace'),
    );
    const route = new SessionMetadataRoute();
    const capture: Capture = { status: 0, body: {} };

    await route.handle(
      routeMatch(session.id),
      mockReq({ key: 'reviewed', value: true }),
      mockRes(capture),
      null,
    );

    expect(capture.status).toBe(200);
    expect((await SessionStore.getInstance().readSessionMeta(session.id))?.metadata.reviewed).toBe(true);

    const missingCapture: Capture = { status: 0, body: {} };
    await route.handle(
      routeMatch('missing-session'),
      mockReq({ key: 'reviewed', value: true }),
      mockRes(missingCapture),
      null,
    );
    expect(missingCapture.status).toBe(404);
  });

  it('refuses to permanently delete a session that has descendants', async () => {
    const parent = await manager.createMainSession(
      'agent-main',
      'Parent',
      path.join(tmpDir, 'workspace'),
    );
    const child = await manager.createSubSession(parent.id, 'agent-child', 'Child');
    const capture: Capture = { status: 0, body: {} };

    await new HardDeleteSessionRoute().handle(
      routeMatch(parent.id),
      mockReq(),
      mockRes(capture),
      null,
    );

    expect(capture.status).toBe(409);
    expect(capture.body.childSessionIds).toEqual([child.id]);
    expect(manager.session(parent.id)).toBeDefined();
    expect(manager.session(child.id)).toBeDefined();
    expect(await SessionStore.getInstance().readSessionMeta(parent.id)).not.toBeNull();
  });

  it('uses persisted child metadata when the archived tree is not loaded in memory', async () => {
    const sessionsDir = path.join(tmpDir, 'sessions');
    const parent = await manager.createMainSession(
      'agent-main',
      'Parent',
      path.join(tmpDir, 'workspace'),
    );
    const child = await manager.createSubSession(parent.id, 'agent-child', 'Child');
    await manager.archiveSession(parent.id);

    SessionManager.resetInstance();
    SessionStore.resetInstance();
    manager = SessionManager.getInstance();
    await manager.initialize(sessionsDir);
    expect(manager.session(parent.id)).toBeUndefined();

    const capture: Capture = { status: 0, body: {} };
    await new HardDeleteSessionRoute().handle(
      routeMatch(parent.id),
      mockReq(),
      mockRes(capture),
      null,
    );

    expect(capture.status).toBe(409);
    expect(capture.body.childSessionIds).toEqual([child.id]);
    expect(await SessionStore.getInstance().readSessionMeta(parent.id)).not.toBeNull();
  });

  it('serializes permanent deletion with concurrent child creation', async () => {
    const parent = await manager.createMainSession(
      'agent-main',
      'Parent',
      path.join(tmpDir, 'workspace'),
    );
    const store = SessionStore.getInstance();
    const originalWriteSessionMeta = store.writeSessionMeta.bind(store);
    let markChildWriteStarted: () => void = () => {};
    const childWriteStarted = new Promise<void>((resolve) => {
      markChildWriteStarted = resolve;
    });
    let releaseChildWrite: () => void = () => {};
    const childWriteGate = new Promise<void>((resolve) => {
      releaseChildWrite = resolve;
    });

    vi.spyOn(store, 'writeSessionMeta').mockImplementation(async (sessionId, node) => {
      if (node.parentSessionId === parent.id) {
        markChildWriteStarted();
        await childWriteGate;
      }
      await originalWriteSessionMeta(sessionId, node);
    });

    const childPromise = manager.createSubSession(parent.id, 'agent-child', 'Child');
    await childWriteStarted;
    const capture: Capture = { status: 0, body: {} };
    const deletePromise = new HardDeleteSessionRoute().handle(
      routeMatch(parent.id),
      mockReq(),
      mockRes(capture),
      null,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(capture.status).toBe(0);

    releaseChildWrite();
    const [child] = await Promise.all([childPromise, deletePromise]);

    expect(capture.status).toBe(409);
    expect(capture.body.childSessionIds).toEqual([child.id]);
    expect(manager.session(parent.id)).toBeDefined();
    expect(manager.session(child.id)).toBeDefined();
  });

  it('declares read/write permissions for every session control route', () => {
    expect([
      new InterruptStatusRoute(),
      new SessionParentRoute(),
      new SessionRootRoute(),
      new ActiveSessionRoute(),
      new SessionListFilteredRoute(),
    ].map((route) => route.permission)).toEqual(Array(5).fill('sessions:read'));

    expect([
      new InterruptSessionRoute(),
      new SessionMetadataRoute(),
      new SetActiveSessionRoute(),
      new SessionGarbageCollectRoute(),
      new HardDeleteSessionRoute(),
    ].map((route) => route.permission)).toEqual(Array(5).fill('sessions:write'));
  });
});
