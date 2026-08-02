import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../../EventEmitter.js';
import { SessionViewModel } from '../SessionViewModel.js';

class FakeWSClient extends EventEmitter {}

function addTree(vm: SessionViewModel): void {
  vm.sessions.addSession({ id: 'root', title: 'Root', parentId: null, children: [] } as any);
  vm.sessions.addSession({ id: 'child', title: 'Child', parentId: 'root', children: [] } as any);
  vm.sessions.addSession({ id: 'grandchild', title: 'Grandchild', parentId: 'child', children: [] } as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SessionViewModel lifecycle reconciliation', () => {
  it('archives a parent as one tree operation and deselects an active descendant', async () => {
    const vm = new SessionViewModel(new FakeWSClient() as any);
    addTree(vm);
    vm.selectSession('grandchild');
    const removed = vi.fn();
    const deselected = vi.fn();
    vm.on('sessionsRemoved', removed);
    vm.on('sessionDeselected', deselected);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204 } as Response)));

    await expect(vm.archiveSession('root')).resolves.toBe(true);

    expect(vm.sessions.all).toHaveLength(0);
    expect(vm.activeSessionId).toBeNull();
    expect(deselected).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith(expect.arrayContaining(['root', 'child', 'grandchild']));
  });

  it('reconciles an active descendant when a hard-delete event removes its parent', () => {
    const ws = new FakeWSClient();
    const vm = new SessionViewModel(ws as any);
    addTree(vm);
    vm.selectSession('child');

    ws.emit('session_hard_deleted', { sessionId: 'root' });

    expect(vm.activeSessionId).toBeNull();
    expect(vm.sessions.getById('child')).toBeUndefined();
    expect(vm.sessions.getById('grandchild')).toBeUndefined();
  });

  it('clears stale selection and reports removed sessions after a list refresh', async () => {
    const vm = new SessionViewModel(new FakeWSClient() as any);
    addTree(vm);
    vm.selectSession('child');
    const removed = vi.fn();
    vm.on('sessionsRemoved', removed);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response)));

    await vm.loadSessions();

    expect(vm.activeSessionId).toBeNull();
    expect(vm.sessions.all).toHaveLength(0);
    expect(removed).toHaveBeenCalledWith(expect.arrayContaining(['root', 'child', 'grandchild']));
  });
});
