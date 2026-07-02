import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

export class WindowManager {
  private static instance: WindowManager;
  private windows = new Set<any>();
  private mainWindow: any = null;
  private Bw: any;

  private constructor(BrowserWindow: any) {
    this.Bw = BrowserWindow;
  }

  static getInstance(): WindowManager {
    if (!WindowManager.instance) WindowManager.instance = new WindowManager(null as any);
    return WindowManager.instance;
  }

  static init(BrowserWindow: any): void {
    WindowManager.instance = new WindowManager(BrowserWindow);
  }

  createWindow(sessionId?: string): any {
    const state = this.loadState();
    const port = 3456;
    // app.getAppPath() works inside asar — Electron patches it to resolve correctly.
    const appRoot = app.getAppPath();

    const win = new this.Bw({
      width: state.width, height: state.height,
      x: state.x, y: state.y,
      minWidth: 800, minHeight: 600,
      titleBarStyle: 'hidden',
      icon: path.join(appRoot, 'build', 'icon.ico'),
      show: false,
      backgroundColor: '#0a0a0a',
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(appRoot, 'dist', 'electron', 'preload.cjs'),
        backgroundThrottling: false,
      },
    });

    if (state.maximized) win.maximize();

    const url = sessionId ? `http://localhost:${port}/?session=${sessionId}` : `http://localhost:${port}/`;
    win.loadURL(url);
    win.once('ready-to-show', () => win.show());

    // Debounced save on resize/move — 500ms debounce avoids thrashing the FS
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    win.on('resize', () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { this.saveState(win); saveTimer = null; }, 500);
    });
    win.on('move', () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { this.saveState(win); saveTimer = null; }, 500);
    });
    win.on('close', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } this.saveState(win); });
    win.on('maximize', () => { win._preBounds = win._preBounds || win.getBounds(); this._notifyMax(win, true); });
    win.on('unmaximize', () => this._notifyMax(win, false));

    this.windows.add(win);
    if (!this.mainWindow) this.mainWindow = win;
    return win;
  }

  getMainWindow(): any { return this.mainWindow; }
  getAllWindows(): any[] { return [...this.windows]; }

  private _notifyMax(win: any, v: boolean): void { win.webContents.send('maximize-change', v); }

  private loadState(): any {
    // In packaged mode, app.getAppPath() is inside asar (read-only).
    // Use userData for writable state — standard Electron API.
    const statePath = path.join(app.getPath('userData'), 'window-state.json');
    try { return JSON.parse(fs.readFileSync(statePath, 'utf-8')); }
    catch { return { width: 1200, height: 800, maximized: false }; }
  }

  private saveState(win: any): void {
    const maximized = win.isMaximized?.() ?? false;
    const b = maximized ? (win._preBounds ?? win.getBounds()) : win.getBounds();
    try {
      const statePath = path.join(app.getPath('userData'), 'window-state.json');
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
        x: b.x, y: b.y, width: b.width, height: b.height, maximized,
      }, null, 2));
    } catch { /* best effort */ }
  }
}
