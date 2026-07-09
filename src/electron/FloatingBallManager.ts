// FloatingBallManager — always-on-top floating ball window
// Singleton. Manages a transparent frameless BrowserWindow that replaces the
// main window on minimize. Provides satellite orbit UI for quick actions.
//
// Lifecycle:
//   init(BrowserWindow, ipcMain) @ startup
//   → saveMainWindowBounds() on minimize
//   → animateMinimize() shrinks main window to 56x56 over 10 steps
//   → show() positions 400x400 ball window at main window's top-right corner
//   → hide() / destroy() on cleanup
//
// IPC:
//   floating-ball-action:   quick helper actions from the floating renderer
//   floating-ball-sessions: getRecentSessions() (provider registered in main.ts)
//   floating-ball-state:    status snapshot for the floating helper

import * as path from 'path';
import { app, clipboard, screen, BrowserWindow as BwType, IpcMain } from 'electron';
import { WindowManager } from './WindowManager.js';

type FloatingBallSession = { id: string; title: string; status?: string };
type FloatingBallState = {
  activeSessionId: string | null;
  activeTitle: string | null;
  connection: 'connected' | 'connecting' | 'disconnected';
  runningCount: number;
  waitingCount: number;
  recentSessions: FloatingBallSession[];
  currentTask?: {
    sessionId: string;
    title: string;
    phase: 'thinking' | 'tool' | 'waiting' | 'done' | 'failed' | 'idle';
    detail?: string;
  };
  clipboardText?: string;
};

export class FloatingBallManager {
  private static instance: FloatingBallManager;
  private _ball: BwType | null = null;
  private _Bw: typeof BwType | null = null;
  private _ipcMain: IpcMain | null = null;
  private _ipcInstalled = false;
  private _sessionProvider: (() => Promise<FloatingBallSession[]>) | null = null;
  private _state: FloatingBallState = {
    activeSessionId: null,
    activeTitle: null,
    connection: 'disconnected',
    runningCount: 0,
    waitingCount: 0,
    recentSessions: [],
  };
  /** Saved main window bounds before minimize, used to position ball at that window's corner. */
  private _mainWinBounds: { x: number; y: number; width: number; height: number } | null = null;

  static getInstance(): FloatingBallManager {
    if (!FloatingBallManager.instance) FloatingBallManager.instance = new FloatingBallManager();
    return FloatingBallManager.instance;
  }

  /** Init with Electron dependencies. Call once at app startup. Registers IPC handlers. */
  static init(BrowserWindow: typeof BwType, ipcMain: IpcMain): void {
    const inst = FloatingBallManager.getInstance();
    inst._Bw = BrowserWindow;
    inst._ipcMain = ipcMain;
    // Register IPC handlers once — not per minimize
    if (!inst._ipcInstalled) {
      inst._ipcInstalled = true;
      ipcMain.on('floating-ball-action', (_e, action: string, data?: any) => {
        inst._handleAction(action, data);
      });
      ipcMain.handle('floating-ball-sessions', async () => {
        return inst._sessionProvider ? inst._sessionProvider() : [];
      });
      ipcMain.handle('floating-ball-state', async () => inst._buildState());
      ipcMain.on('floating-ball-update-state', (_e, patch: Partial<FloatingBallState>) => {
        inst.updateState(patch);
      });
    }
  }

  /** Register a provider for recent sessions (used by satellite display). */
  setSessionProvider(fn: () => Promise<FloatingBallSession[]>): void {
    this._sessionProvider = fn;
  }

  /** Merge the latest renderer status into the floating helper state. */
  updateState(patch: Partial<FloatingBallState>): void {
    this._state = {
      ...this._state,
      ...patch,
      recentSessions: Array.isArray(patch.recentSessions) ? patch.recentSessions : this._state.recentSessions,
    };
    this._pushStateToBall();
  }

  /** Store main window bounds so the ball window appears at the correct corner. */
  saveMainWindowBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    const normalized = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(800, bounds.width),
      height: Math.max(600, bounds.height),
    };
    const visibleEnough = screen.getAllDisplays().some((display) => {
      const b = display.workArea;
      const visibleW = Math.min(normalized.x + normalized.width, b.x + b.width) - Math.max(normalized.x, b.x);
      const visibleH = Math.min(normalized.y + normalized.height, b.y + b.height) - Math.max(normalized.y, b.y);
      return visibleW >= Math.min(600, normalized.width * 0.6) && visibleH >= Math.min(400, normalized.height * 0.6);
    });
    if (!visibleEnough) {
      const display = screen.getPrimaryDisplay();
      const b = display.workArea;
      normalized.x = Math.round(b.x + (b.width - normalized.width) / 2);
      normalized.y = Math.round(b.y + (b.height - normalized.height) / 2);
    }
    this._mainWinBounds = normalized;
  }

  /** Show the 400x400 ball window at the main window's top-right corner. */
  show(): void {
    if (!this._Bw) return;
    if (!this._ball || this._ball.isDestroyed?.()) {
      this._createBall();
    } else if (this._ball.isVisible()) {
      return; // Already visible
    }
    // At this point _ball is guaranteed non-null
    const ball = this._ball!;

    const bounds = this._mainWinBounds;
    let posX: number, posY: number;
    if (bounds) {
      posX = bounds.x + bounds.width - 400;
      posY = bounds.y;
    } else {
      const cursor = screen.getCursorScreenPoint();
      const displays = screen.getAllDisplays();
      const display = displays.find((d: any) => {
        const b = d.bounds;
        return cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
      }) || displays[0];
      const wa = display.workArea;
      posX = wa.x + wa.width - 400;
      posY = wa.y;
    }

    ball.setPosition(posX, posY);
    ball.show();
    ball.focus();
  }

  /** Animate main window shrinking to a tiny square, then show ball. */
  animateMinimize(mainWin: BwType): void {
    const bounds = mainWin.getBounds();
    this.saveMainWindowBounds(bounds);

    // Step 1: shrink window to 56x56 at top-right over ~250ms (10 steps)
    const targetX = bounds.x + bounds.width - 56;
    const targetY = bounds.y;
    const steps = 10;
    const stepMs = 25;
    let step = 0;

    const shrink = () => {
      step++;
      if (step > steps) {
        mainWin.hide();
        this.show();
        return;
      }
      const t = step / steps;
      const ease = t * t; // ease-in
      const w = bounds.width + (56 - bounds.width) * ease;
      const h = bounds.height + (56 - bounds.height) * ease;
      const x = bounds.x + (targetX - bounds.x) * ease;
      const y = bounds.y + (targetY - bounds.y) * ease;
      try { mainWin.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }); } catch {}
      setTimeout(shrink, stepMs);
    };
    shrink();
  }

  /** Hide the ball window without destroying it. */
  hide(): void {
    if (this._ball && !this._ball.isDestroyed?.()) this._ball.hide();
  }

  /** True if the ball window exists and is currently visible. */
  get isVisible(): boolean {
    return this._ball !== null && !this._ball.isDestroyed?.() && this._ball.isVisible();
  }

  /** Close and null the ball window. */
  destroy(): void {
    if (this._ball && !this._ball.isDestroyed?.()) this._ball.close();
    this._ball = null;
  }

  /** Create the transparent frameless 400x400 ball window and wire IPC listeners. */
  private _createBall(): void {
    if (!this._Bw) return;
    const port = 3456;
    this._ball = new this._Bw({
      width: 400, height: 400,
      transparent: true, frame: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, show: false, hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(app.getAppPath(), 'dist', 'electron', 'preload.cjs'),
        backgroundThrottling: true,
      },
    });

    this._ball.loadURL(`http://localhost:${port}/floating-ball/index.html`);
    this._ball.setIgnoreMouseEvents(false);
  }

  private async _buildState(): Promise<FloatingBallState> {
    let recentSessions = this._state.recentSessions;
    if (this._sessionProvider) {
      try {
        const provided = await this._sessionProvider();
        if (Array.isArray(provided)) recentSessions = provided;
      } catch {
        recentSessions = this._state.recentSessions;
      }
    }

    let clipboardText = '';
    try {
      clipboardText = clipboard.readText().trim().slice(0, 4000);
    } catch {
      clipboardText = '';
    }

    return {
      ...this._state,
      recentSessions,
      clipboardText,
    };
  }

  private _pushStateToBall(): void {
    if (!this._ball || this._ball.isDestroyed?.()) return;
    this._buildState()
      .then((state) => {
        if (!this._ball || this._ball.isDestroyed?.()) return;
        this._ball.webContents.send('floating-ball-state-changed', state);
      })
      .catch(() => {});
  }

  /** Handle satellite action: show main window and dispatch new-session / open-session event. */
  private _handleAction(action: string, data?: any): void {
    const showMain = (): BwType | null => {
      const mainWin = WindowManager.getInstance().getMainWindow();
      if (!mainWin) {
        WindowManager.getInstance().createWindow();
        return null;
      }
      if (this._mainWinBounds) {
        try { mainWin.setBounds(this._mainWinBounds); } catch {}
      }
      mainWin.show();
      mainWin.focus();
      return mainWin;
    };

    switch (action) {
      case 'new-session': {
        this.hide();
        showMain()?.webContents.send('floating-ball-new-session');
        break;
      }
      case 'open-session': {
        this.hide();
        showMain()?.webContents.send('floating-ball-open-session', data);
        break;
      }
      case 'continue-current':
      case 'open-current':
      case 'open-waiting':
      case 'quick-ask':
      case 'text-action':
      case 'stop-current': {
        this.hide();
        showMain()?.webContents.send('floating-ball-command', { action, data });
        break;
      }
    }
  }
}
