import { describe, expect, it } from 'vitest';
import { EventEmitter } from '../../EventEmitter.js';
import { SessionViewModel } from '../SessionViewModel.js';

class FakeWSClient extends EventEmitter {}

describe('SessionViewModel workspace synchronization', () => {
  it('updates the active session workspace from the authoritative event', () => {
    const ws = new FakeWSClient();
    const vm = new SessionViewModel(ws as any);
    vm.sessions.addSession({
      id: 'session-1',
      title: 'Workspace test',
      workspace: 'D:\\old-workspace',
      status: 'active',
      agentId: 'main',
      parentId: null,
      children: [],
    } as any);
    vm.selectSession('session-1');

    ws.emit('workspace_changed', {
      sessionId: 'session-1',
      workspace: 'C:\\current-workspace',
    });

    expect(vm.activeSession?.workspace).toBe('C:\\current-workspace');
  });

  it('supports immediate synchronization after a successful binding response', () => {
    const vm = new SessionViewModel(new FakeWSClient() as any);
    vm.sessions.addSession({ id: 'session-1', workspace: 'old' } as any);

    vm.updateSessionWorkspace('session-1', 'new');

    expect(vm.sessions.getById('session-1')?.workspace).toBe('new');
  });
});
