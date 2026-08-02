import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFileTree } from '../WorkspaceFileTree.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WorkspaceFileTree mutation safety', () => {
  it('cancels a pending delete when the active session changes', async () => {
    let confirmDelete!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>(resolve => { confirmDelete = resolve; });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tree = Object.create(WorkspaceFileTree.prototype) as any;
    tree._sessionId = 'session-a';
    tree._confirm = vi.fn(() => confirmation);
    tree.beforePathDelete = null;

    const pending = tree._deleteByName('src/a.ts', 'a.ts');
    tree._sessionId = 'session-b';
    confirmDelete(true);
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not apply a completed delete response to a newly selected session', async () => {
    let resolveResponse!: (response: { ok: boolean }) => void;
    const response = new Promise<{ ok: boolean }>(resolve => { resolveResponse = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => response));
    const tree = Object.create(WorkspaceFileTree.prototype) as any;
    tree._sessionId = 'session-a';
    tree._selectedPath = 'src/a.ts';
    tree._confirm = vi.fn(async () => true);
    tree.beforePathDelete = null;
    tree.onPathDeleted = vi.fn();
    tree.refreshDirectory = vi.fn();

    const pending = tree._deleteByName('src/a.ts', 'a.ts');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    tree._sessionId = 'session-b';
    resolveResponse({ ok: true });
    await pending;

    expect(tree.onPathDeleted).not.toHaveBeenCalled();
    expect(tree.refreshDirectory).not.toHaveBeenCalled();
    expect(tree._selectedPath).toBe('src/a.ts');
  });
});
