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

    constructor() {
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

  beforeAll(async () => {
    ({ BrowserViewManager } = await import('../BrowserViewManager.js'));
  });

  afterEach(() => {
    const manager = BrowserViewManager.getInstance();
    for (const id of manager.allIds()) manager.destroy(id);
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
});
