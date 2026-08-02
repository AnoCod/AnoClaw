import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  views: [] as any[],
  nextWebContentsId: 1000,
}));

let BrowserViewManager: typeof import('../BrowserViewManager.js').BrowserViewManager;

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeWebContents extends EventEmitter {
    id = electronMock.nextWebContentsId++;
    session = {
      webRequest: {
        onBeforeRequest: vi.fn(),
        onCompleted: vi.fn(),
        onErrorOccurred: vi.fn(),
      },
      on: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    private _destroyed = false;

    constructor(private readonly _parent: { _webContents?: FakeWebContents }) {
      super();
    }

    setWindowOpenHandler = vi.fn();
    getUserAgent = vi.fn(() => 'AnoClawTest');
    loadURL = vi.fn();
    getURL = vi.fn(() => 'about:blank');
    getTitle = vi.fn(() => '');
    isLoading = vi.fn(() => false);
    isDestroyed = vi.fn(() => this._destroyed);
    close = vi.fn(() => {
      this._destroyed = true;
      this._parent._webContents = undefined;
      this.emit('destroyed');
    });
  }

  class FakeWebContentsView {
    _webContents?: FakeWebContents;
    setBounds = vi.fn();
    setVisible = vi.fn();

    constructor(readonly options: Record<string, unknown> = {}) {
      this._webContents = new FakeWebContents(this);
      electronMock.views.push(this);
    }

    get webContents(): FakeWebContents {
      return this._webContents as FakeWebContents;
    }
  }

  return {
    BrowserWindow: class {},
    WebContentsView: FakeWebContentsView,
  };
});

describe('BrowserViewManager', () => {
  const mainWindow = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
  const secondWindow = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    webContents: {
      id: 202,
      send: vi.fn(),
    },
  };

  beforeAll(async () => {
    ({ BrowserViewManager } = await import('../BrowserViewManager.js'));
  });

  afterEach(() => {
    const manager = BrowserViewManager.getInstance();
    for (const id of manager.allIds()) manager.destroy(id);
    manager.registerWindowSession(secondWindow as any, '');
    electronMock.views.length = 0;
    vi.clearAllMocks();
  });

  it('ignores late destroyed events after a browser view loses webContents', () => {
    BrowserViewManager.init(() => mainWindow as any);
    const manager = BrowserViewManager.getInstance();

    const viewId = manager.create('about:blank');
    const fakeView = electronMock.views.at(-1);
    const webContents = fakeView._webContents;

    expect(manager.destroy(viewId)).toBe(true);
    expect(manager.get(viewId)).toBeNull();
    expect(fakeView._webContents).toBeUndefined();
    expect(() => webContents.emit('destroyed')).not.toThrow();

    webContents.emit('did-start-loading');
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('hides browser views when renderer bounds collapse and restores them when positioned', () => {
    BrowserViewManager.init(() => mainWindow as any);
    const manager = BrowserViewManager.getInstance();

    const viewId = manager.create('https://example.com');
    const fakeView = electronMock.views.at(-1);

    expect(fakeView.setVisible).toHaveBeenCalledWith(false);

    manager.setBounds(viewId, 260, 198, 580, 720);
    expect(fakeView.setBounds).toHaveBeenLastCalledWith({ x: 260, y: 198, width: 580, height: 720 });
    expect(fakeView.setVisible).toHaveBeenLastCalledWith(true);

    manager.setBounds(viewId, -1, -1, 0, 0);
    expect(fakeView.setVisible).toHaveBeenLastCalledWith(false);
    expect(fakeView.setBounds).toHaveBeenCalledTimes(2);
  });

  it('sandboxes browser content in a session-specific partition', () => {
    BrowserViewManager.init(() => mainWindow as any);
    const manager = BrowserViewManager.getInstance();

    manager.create('https://example.com', { sessionId: 'session-a' });
    manager.create('https://example.org', { sessionId: 'session-b' });

    const firstPreferences = electronMock.views[0].options.webPreferences;
    const secondPreferences = electronMock.views[1].options.webPreferences;
    expect(firstPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true });
    expect(firstPreferences.partition).toMatch(/^persist:anoclaw-browser-/);
    expect(secondPreferences.partition).not.toBe(firstPreferences.partition);
  });

  it('attaches views and sends events to the owning renderer window', () => {
    BrowserViewManager.init(() => mainWindow as any);
    const manager = BrowserViewManager.getInstance();
    manager.registerWindowSession(mainWindow as any, 'session-b');
    manager.registerWindowSession(secondWindow as any, 'session-b');

    const viewId = manager.create('https://example.com', { sessionId: 'session-b' });
    const fakeView = electronMock.views.at(-1);
    const webContents = fakeView._webContents;

    expect(secondWindow.contentView.addChildView).toHaveBeenCalledWith(fakeView);
    expect(mainWindow.contentView.addChildView).not.toHaveBeenCalled();

    webContents.emit('did-start-loading');
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      'wv-state-change',
      expect.objectContaining({ viewId, type: 'loading-start' }),
    );
    expect(mainWindow.webContents.send).not.toHaveBeenCalled();

    manager.destroy(viewId);
    expect(secondWindow.contentView.removeChildView).toHaveBeenCalledWith(fakeView);
  });

  it('filters agent-owned tabs by session and ownership kind', () => {
    BrowserViewManager.init(() => mainWindow as any);
    const manager = BrowserViewManager.getInstance();
    const agentA = manager.create('https://agent-a.example', { sessionId: 'session-a', ownerKind: 'agent' });
    manager.create('https://user-a.example', { sessionId: 'session-a' });
    manager.create('https://agent-b.example', { sessionId: 'session-b', ownerKind: 'agent' });

    expect(manager.allEntries('session-a', 'agent').map(entry => entry.id)).toEqual([agentA]);
    expect(manager.isOwnedBySession(agentA, 'session-a', 'agent')).toBe(true);
    expect(manager.isOwnedBySession(agentA, 'session-b', 'agent')).toBe(false);
  });
});
