import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  quit: vi.fn(),
  windows: [] as FakeBrowserWindow[],
}));

class FakeBrowserWindow extends EventEmitter {
  private destroyed = false;

  setMenuBarVisibility = vi.fn();
  loadFile = vi.fn();
  show = vi.fn();
  focus = vi.fn();

  constructor(_options: unknown) {
    super();
    electronMock.windows.push(this);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

class FakeIpcMain extends EventEmitter {
  handle = vi.fn();
  removeHandler = vi.fn();
}

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    quit: electronMock.quit,
  },
}));

describe('SetupWizard window lifecycle', () => {
  beforeEach(() => {
    electronMock.quit.mockReset();
    electronMock.windows.length = 0;
  });

  it('resolves setup completion without quitting the app', async () => {
    const { init, runSetupWizard } = await import('../SetupWizard.js');
    const ipc = new FakeIpcMain();
    init(FakeBrowserWindow as never, ipc as never);

    const setupFinished = runSetupWizard();
    ipc.emit('setup-done');
    await setupFinished;

    expect(electronMock.windows).toHaveLength(1);
    expect(electronMock.windows[0].isDestroyed()).toBe(true);
    expect(electronMock.quit).not.toHaveBeenCalled();
  });

  it('quits when the setup window is closed before completion', async () => {
    const { init, runSetupWizard } = await import('../SetupWizard.js');
    const ipc = new FakeIpcMain();
    init(FakeBrowserWindow as never, ipc as never);

    void runSetupWizard();
    electronMock.windows[0].close();

    expect(electronMock.quit).toHaveBeenCalledOnce();
  });
});
