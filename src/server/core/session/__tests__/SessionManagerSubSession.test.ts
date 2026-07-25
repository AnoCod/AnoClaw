import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../SessionManager.js';
import { SessionStore } from '../SessionStore.js';

describe('SessionManager.createSubSession', () => {
  let tmpDir = '';
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-subsession-'));
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    manager = SessionManager.getInstance();
    await manager.initialize(path.join(tmpDir, 'sessions'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    SessionManager.resetInstance();
    SessionStore.resetInstance();
    if (tmpDir && path.basename(tmpDir).startsWith('anoclaw-subsession-')) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects creation under an archived parent', async () => {
    const parent = await manager.createMainSession(
      'agent-main',
      'Parent',
      path.join(tmpDir, 'workspace'),
    );
    await manager.archiveSession(parent.id);

    await expect(
      manager.createSubSession(parent.id, 'agent-child', 'Child'),
    ).rejects.toThrow(`Cannot create sub-session under archived parent '${parent.id}'`);
    expect(parent.subSessionIds).toEqual([]);
  });

  it('serializes creation with a concurrent parent workspace change', async () => {
    const initialWorkspace = path.join(tmpDir, 'workspace-a');
    const nextWorkspace = path.join(tmpDir, 'workspace-b');
    const parent = await manager.createMainSession('agent-main', 'Parent', initialWorkspace);
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
    const parentWorkspaceSpy = vi.spyOn(parent, 'setWorkspace');

    const childPromise = manager.createSubSession(parent.id, 'agent-child', 'Child');
    await childWriteStarted;
    const workspacePromise = manager.setWorkspace(parent.id, nextWorkspace);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const workspaceChangedBeforeChildCommit = parentWorkspaceSpy.mock.calls.length > 0;

    releaseChildWrite();
    const [child] = await Promise.all([childPromise, workspacePromise]);

    expect(workspaceChangedBeforeChildCommit).toBe(false);
    expect(parent.workspace).toBe(nextWorkspace);
    expect(child.workspace).toBe(nextWorkspace);
  });

  it('serializes ancestor workspace changes with descendant creation', async () => {
    const initialWorkspace = path.join(tmpDir, 'workspace-a');
    const nextWorkspace = path.join(tmpDir, 'workspace-b');
    const root = await manager.createMainSession('agent-main', 'Root', initialWorkspace);
    const child = await manager.createSubSession(root.id, 'agent-child', 'Child');
    const grandchild = await manager.createSubSession(child.id, 'agent-grandchild', 'Grandchild');
    const store = SessionStore.getInstance();
    const originalWriteSessionMeta = store.writeSessionMeta.bind(store);

    let markLeafWriteStarted: () => void = () => {};
    const leafWriteStarted = new Promise<void>((resolve) => {
      markLeafWriteStarted = resolve;
    });
    let releaseLeafWrite: () => void = () => {};
    const leafWriteGate = new Promise<void>((resolve) => {
      releaseLeafWrite = resolve;
    });

    vi.spyOn(store, 'writeSessionMeta').mockImplementation(async (sessionId, node) => {
      if (node.parentSessionId === grandchild.id) {
        markLeafWriteStarted();
        await leafWriteGate;
      }
      await originalWriteSessionMeta(sessionId, node);
    });
    const rootWorkspaceSpy = vi.spyOn(root, 'setWorkspace');

    const leafPromise = manager.createSubSession(grandchild.id, 'agent-leaf', 'Leaf');
    await leafWriteStarted;
    const workspacePromise = manager.setWorkspace(root.id, nextWorkspace);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rootWorkspaceSpy).not.toHaveBeenCalled();

    releaseLeafWrite();
    const [leaf] = await Promise.all([leafPromise, workspacePromise]);

    expect([root, child, grandchild, leaf].map((session) => session.workspace))
      .toEqual(Array(4).fill(nextWorkspace));
    expect((await store.readSessionMeta(leaf.id))?.workspace).toBe(nextWorkspace);
  });
});
