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
//   floating-ball-action:   'new-session' | 'open-session'  (from renderer)
//   floating-ball-sessions: getRecentSessions() (provider registered in main.ts)

import * as path from 'path';
import { app, screen } from 'electron';
import { WindowManager } from './WindowManager.js';

export class FloatingBallManager {
  private static instance: FloatingBallManager;
  private _ball: any = null;
  private _Bw: any = null;
  private _ipcMain: any = null;
  private _ipcInstalled = false;
  private _sessionProvider: (() => Promise<any[]>) | null = null;
  /** Saved main window bounds before minimize, used to position ball at that window's corner. */
  private _mainWinBounds: { x: number; y: number; width: number; height: number } | null = null;

  static getInstance(): FloatingBallManager {
    if (!FloatingBallManager.instance) FloatingBallManager.instance = new FloatingBallManager();
    return FloatingBallManager.instance;
  }

  /** Init with Electron dependencies. Call once at app startup. Registers IPC handlers. */
  static init(BrowserWindow: any, ipcMain: any): void {
    const inst = FloatingBallManager.getInstance();
    inst._Bw = BrowserWindow;
    inst._ipcMain = ipcMain;
    // Register IPC handlers once — not per minimize
    if (!inst._ipcInstalled) {
      inst._ipcInstalled = true;
      ipcMain.on('floating-ball-action', (_: any, action: string, data?: any) => {
        inst._handleAction(action, data);
      });
      ipcMain.handle('floating-ball-sessions', async () => {
        return inst._sessionProvider ? inst._sessionProvider() : [];
      });
    }
  }

  /** Register a provider for recent sessions (used by satellite display). */
  setSessionProvider(fn: () => Promise<any[]>): void {
    this._sessionProvider = fn;
  }

  /** Store main window bounds so the ball window appears at the correct corner. */
  saveMainWindowBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this._mainWinBounds = bounds;
  }

  /** Show the 400x400 ball window at the main window's top-right corner. */
  show(): void {
    if (!this._Bw) return;
    if (!this._ball || this._ball.isDestroyed?.()) this._createBall();

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

    this._ball.setPosition(posX, posY);
    this._ball.show();
    this._ball.focus();
  }

  /** Animate main window shrinking to a tiny square, then show ball. */
  animateMinimize(mainWin: any): void {
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
    const port = 3456;
    this._ball = new this._Bw({
      width: 400, height: 400,
      transparent: true, frame: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, show: false, hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(app.getAppPath(), 'dist', 'electron', 'preload.cjs'),
        backgroundThrottling: false,
      },
    });

    this._ball.loadURL(`http://localhost:${port}/floating-ball/index.html`);
    this._ball.setIgnoreMouseEvents(false);
  }

  /** Handle satellite action: show main window and dispatch new-session / open-session event. */
  private _handleAction(action: string, data?: any): void {
    switch (action) {
      case 'new-session': {
        this.hide();
        const mainWin = WindowManager.getInstance().getMainWindow();
        if (mainWin) { mainWin.show(); mainWin.webContents.send('floating-ball-new-session'); }
        else { WindowManager.getInstance().createWindow(); }
        break;
      }
      case 'open-session': {
        this.hide();
        const mainWin = WindowManager.getInstance().getMainWindow();
        if (mainWin) { mainWin.show(); mainWin.webContents.send('floating-ball-open-session', data); }
        else { WindowManager.getInstance().createWindow(); }
        break;
      }
    }
  }
}
