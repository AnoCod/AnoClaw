import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from '../../../../EventEmitter.js';

class FakeElement {
  className = '';
  textContent = '';
  innerHTML = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = {
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn(),
  };

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  setAttribute(): void {}
  addEventListener(): void {}
  remove(): void {}
  getAnimations(): Array<{ finish: () => void }> { return []; }
  getBoundingClientRect(): { width: number } { return { width: 240 }; }
}

class FakeSessionViewModel extends EventEmitter {
  activeSessionId: string | null = null;
  sessions = { all: [] as Array<{ id: string }> };
}

afterEach(() => {
  vi.doUnmock('../../../../app.js');
  vi.doUnmock('../../../../PageRegistry.js');
  vi.doUnmock('../WorkspaceFileTree.js');
  vi.doUnmock('../WorkspaceSplitContainer.js');
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WorkspacePage session lifecycle', () => {
  it('clears the visible workspace and disposes deleted session caches', async () => {
    const sessionVM = new FakeSessionViewModel();
    const loadRoot = vi.fn(async () => {});
    const fileTree = {
      element: new FakeElement(),
      loadRoot,
      suspend: vi.fn(),
      beforePathDelete: null,
      onPathRenamed: null,
      onPathDeleted: null,
    };

    const windowListeners = new Map<string, Set<(event: Event) => void>>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, handler: (event: Event) => void) => {
        const handlers = windowListeners.get(type) || new Set();
        handlers.add(handler);
        windowListeners.set(type, handlers);
      }),
      removeEventListener: vi.fn((type: string, handler: (event: Event) => void) => {
        windowListeners.get(type)?.delete(handler);
      }),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      electronAPI: undefined,
    });
    vi.stubGlobal('document', {
      createElement: vi.fn(() => new FakeElement()),
    });

    vi.doMock('../../../../app.js', () => ({
      App: { getInstance: () => ({ sessionVM }) },
    }));
    vi.doMock('../../../../PageRegistry.js', () => ({
      pageRegistry: { currentPage: null, navigateTo: vi.fn(), getPage: vi.fn() },
    }));
    vi.doMock('../WorkspaceFileTree.js', () => ({
      WorkspaceFileTree: class {
        constructor() { return fileTree; }
      },
    }));
    vi.doMock('../WorkspaceSplitContainer.js', () => ({
      WorkspaceSplitContainer: class {},
    }));

    const { setLocale } = await import('../../../../i18n/index.js');
    setLocale('en-US');
    const { WorkspacePage } = await import('../WorkspacePage.js');
    const page = new WorkspacePage();
    page.onEnter();
    loadRoot.mockClear();

    const staleGroup = {
      element: new FakeElement(),
      suspend: vi.fn(),
      dispose: vi.fn(),
    };
    const internal = page as any;
    internal._sessionId = 'deleted-session';
    internal._workspacePath = 'C:/stale-workspace';
    internal._toolbarPath.textContent = 'C:/stale-workspace';
    internal._currentGroup = staleGroup;
    internal._tabCache.set('deleted-session', staleGroup);

    sessionVM.emit('sessionDeselected');

    expect(internal._sessionId).toBe('');
    expect(internal._workspacePath).toBe('');
    expect(internal._toolbarPath.textContent).toBe('No workspace');
    expect(staleGroup.suspend).toHaveBeenCalledTimes(1);
    expect(loadRoot).toHaveBeenCalledWith('');
    expect(internal._tabMount.innerHTML).toContain('Workspace editor idle');

    sessionVM.emit('sessionsRemoved', ['deleted-session']);

    expect(staleGroup.dispose).toHaveBeenCalledTimes(1);
    expect(internal._tabCache.has('deleted-session')).toBe(false);
    page.onExit();
  });
});
