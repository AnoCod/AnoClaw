import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../SessionManager.js';
import { SessionStore } from '../SessionStore.js';

describe('SessionManager workspace inheritance', () => {
  let tmpDir = '';
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-session-'));
    (SessionManager as any)._instance = undefined;
    (SessionStore as any)._instance = undefined;
    manager = SessionManager.getInstance();
    await manager.initialize(path.join(tmpDir, 'sessions'));
  });

  afterEach(async () => {
    if (tmpDir && path.basename(tmpDir).startsWith('anoclaw-session-')) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('cascades parent workspace changes to existing child and grandchild sessions', async () => {
    const initialWorkspace = path.join(tmpDir, 'workspace-a');
    const nextWorkspace = path.join(tmpDir, 'workspace-b');

    const parent = await manager.createMainSession('agent-main', 'Parent', initialWorkspace);
    const child = await manager.createSubSession(parent.id, 'agent-child', 'Child');
    const grandchild = await manager.createSubSession(child.id, 'agent-grandchild', 'Grandchild');

    expect(child.workspace).toBe(initialWorkspace);
    expect(grandchild.workspace).toBe(initialWorkspace);

    await manager.setWorkspace(parent.id, nextWorkspace);

    expect(manager.session(parent.id)?.workspace).toBe(nextWorkspace);
    expect(manager.session(child.id)?.workspace).toBe(nextWorkspace);
    expect(manager.session(grandchild.id)?.workspace).toBe(nextWorkspace);

    const childMeta = JSON.parse(
      await fsp.readFile(path.join(tmpDir, 'sessions', child.id, 'meta.json'), 'utf-8'),
    ) as { workspace: string };
    const grandchildMeta = JSON.parse(
      await fsp.readFile(path.join(tmpDir, 'sessions', grandchild.id, 'meta.json'), 'utf-8'),
    ) as { workspace: string };

    expect(childMeta.workspace).toBe(nextWorkspace);
    expect(grandchildMeta.workspace).toBe(nextWorkspace);
  });
});
