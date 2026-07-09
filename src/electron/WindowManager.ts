import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow as BwType, screen } from 'electron';

export class WindowManager {
  private static instance: WindowManager;
  private windows = new Set<BwType>();
  private mainWindow: BwType | null = null;
  private Bw: typeof BwType;

  private constructor(BrowserWindow: typeof BwType) {
    this.Bw = BrowserWindow;
  }

  static getInstance(): WindowManager {
    if (!WindowManager.instance) WindowManager.instance = new WindowManager(null as any);
    return WindowManager.instance;
  }

  static init(BrowserWindow: typeof BwType): void {
    WindowManager.instance = new WindowManager(BrowserWindow);
  }

  createWindow(sessionId?: string): BwType {
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
        backgroundThrottling: true,
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
    win.on('maximize', () => { (win as any)._preBounds = (win as any)._preBounds || win.getBounds(); this._notifyMax(win, true); });
    win.on('unmaximize', () => this._notifyMax(win, false));

    this.windows.add(win);
    if (!this.mainWindow) this.mainWindow = win;
    return win;
  }

  getMainWindow(): BwType | null { return this.mainWindow; }
  getAllWindows(): BwType[] { return [...this.windows]; }

  private _notifyMax(win: BwType, v: boolean): void { win.webContents.send('maximize-change', v); }

  private loadState(): { width: number; height: number; x?: number; y?: number; maximized: boolean } {
    // In packaged mode, app.getAppPath() is inside asar (read-only).
    // Use userData for writable state — standard Electron API.
    const statePath = path.join(app.getPath('userData'), 'window-state.json');
    try { return this.normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf-8'))); }
    catch { return { width: 1200, height: 800, maximized: false }; }
  }

  private normalizeState(raw: any): { width: number; height: number; x?: number; y?: number; maximized: boolean } {
    const width = Math.max(800, Number(raw?.width) || 1200);
    const height = Math.max(600, Number(raw?.height) || 800);
    const maximized = raw?.maximized === true;
    const x = Number(raw?.x);
    const y = Number(raw?.y);
    const state: { width: number; height: number; x?: number; y?: number; maximized: boolean } = { width, height, maximized };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return state;

    const visibleEnough = screen.getAllDisplays().some((display) => {
      const b = display.workArea;
      const visibleW = Math.min(x + width, b.x + b.width) - Math.max(x, b.x);
      const visibleH = Math.min(y + height, b.y + b.height) - Math.max(y, b.y);
      return visibleW >= Math.min(600, width * 0.6) && visibleH >= Math.min(400, height * 0.6);
    });
    if (visibleEnough) {
      state.x = x;
      state.y = y;
    }
    return state;
  }

  private saveState(win: BwType): void {
    if (!win.isVisible() || win.isMinimized()) return;
    const maximized = win.isMaximized?.() ?? false;
    const b = maximized ? ((win as any)._preBounds ?? win.getBounds()) : win.getBounds();
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
