
// Shared between main.ts IPC handlers and BrowserAgentTool so the agent tool
// can control browser tabs directly through webContents APIs instead of CDP.
//
// Dependencies (WindowManager getter + BrowserWindow ref) are injected via init()
// rather than lazy-required, so this module has no hidden coupling to WindowManager.

import { WebContentsView, BrowserWindow } from 'electron';

interface ViewEntry {
  view: WebContentsView;
  bounds: { x: number; y: number; w: number; h: number };
  createdAt: number;
}

export interface AgentBrowserEvent {
  sessionId: string;
  viewId: string;
  action: string;
  phase: 'start' | 'done' | 'error';
  url?: string;
  selector?: string;
  valuePreview?: string;
  resultPreview?: string;
  error?: string;
  timestamp: number;
}

let _instance: BrowserViewManager | null = null;

export class BrowserViewManager {
  private _views = new Map<string, ViewEntry>();
  private _maxViews = 20;
  private _getMainWindow: (() => BrowserWindow | null) | null = null;

  static getInstance(): BrowserViewManager {
    if (!_instance) _instance = new BrowserViewManager();
    return _instance;
  }

  /** Inject the main-window accessor. Call once at startup. */
  static init(getMainWindow: () => BrowserWindow | null): void {
    BrowserViewManager.getInstance()._getMainWindow = getMainWindow;
  }

  private constructor() {}



  create(url: string): string {
    if (this._views.size >= this._maxViews) {
      throw new Error(`BrowserView limit reached (max ${this._maxViews})`);
    }
    const view = new WebContentsView({
      webPreferences: { sandbox: false, nodeIntegration: false, contextIsolation: true },
    });
    view.webContents.setWindowOpenHandler(({ url: popupUrl }: { url: string }) => {
      if (popupUrl && popupUrl !== 'about:blank') view.webContents.loadURL(popupUrl);
      return { action: 'deny' };
    });
    view.webContents.loadURL(url);

    const mainWin = this._getMainWindow?.() ?? null;
    if (mainWin?.contentView) mainWin.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 }); // hidden until positioned

    const viewId = `wv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this._views.set(viewId, { view, bounds: { x: 0, y: 0, w: 0, h: 0 }, createdAt: Date.now() });

    // Forward lifecycle events to renderer
    view.webContents.on('did-start-loading', () => this._emit(viewId, 'loading-start'));
    view.webContents.on('did-stop-loading', () => this._emit(viewId, 'loading-stop'));
    view.webContents.on('did-finish-load', () => this._emit(viewId, 'load-finish'));
    view.webContents.on('did-fail-load', (_e: any, errorCode: number, errorDescription: string, validatedURL: string) => {
      this._emit(viewId, 'load-error', { errorCode, errorDescription, validatedURL });
    });
    view.webContents.on('page-title-updated', (_e: any, title: string) => {
      this._emit(viewId, 'title', { title });
    });
    view.webContents.on('page-favicon-updated', (_e: any, favicons: string[]) => {
      this._emit(viewId, 'favicon', { favicons });
    });
    view.webContents.on('destroyed', () => { this._views.delete(viewId); });

    return viewId;
  }

  destroy(viewId: string): boolean {
    const entry = this._views.get(viewId);
    if (!entry) return false;
    const mainWin = this._getMainWindow?.() ?? null;
    if (mainWin?.contentView) {
      try { mainWin.contentView.removeChildView(entry.view); } catch {}
    }
    try { entry.view.webContents.close(); } catch {}
    this._views.delete(viewId);
    return true;
  }

  get(viewId: string): WebContentsView | null {
    return this._views.get(viewId)?.view ?? null;
  }

  /** Set bounds of a view (for positioning). */
  setBounds(viewId: string, x: number, y: number, w: number, h: number): void {
    const entry = this._views.get(viewId);
    if (!entry) return;
    entry.bounds = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    if (w > 0 && h > 0) {
      entry.view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    }
  }

  /** Return all view IDs, newest first. */
  allIds(): string[] {
    return [...this._views.entries()]
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .map(([id]) => id);
  }

  /** Return all view info entries for listing. */
  allEntries(): Array<{ id: string; url: string; title: string }> {
    return this.allIds().map(id => ({
      id,
      url: this.getUrl(id),
      title: this.getTitle(id),
    }));
  }

  /** Get the most recently created view, or null. */
  latest(): { id: string; view: WebContentsView } | null {
    const ids = this.allIds();
    if (!ids.length) return null;
    const id = ids[0];
    const entry = this._views.get(id);
    return entry ? { id, view: entry.view } : null;
  }

  count(): number { return this._views.size; }

  /** Set the maximum number of concurrent views. */
  setMaxViews(n: number): void { this._maxViews = n; }



  navigate(viewId: string, url: string): void {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    view.webContents.loadURL(url);
  }

  reload(viewId: string): void { this.get(viewId)?.webContents.reload(); }
  goBack(viewId: string): void { this.get(viewId)?.webContents.navigationHistory?.goBack(); }
  goForward(viewId: string): void { this.get(viewId)?.webContents.navigationHistory?.goForward(); }



  async execJs(viewId: string, code: string): Promise<any> {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    return view.webContents.executeJavaScript(code);
  }
  sendInputEvent(viewId: string, event: Record<string, unknown>): void {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    view.webContents.sendInputEvent(event as any);
  }



  async screenshot(viewId: string): Promise<string> {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    const img = await view.webContents.capturePage();
    return img.toDataURL();
  }

  devTools(viewId: string): void { this.get(viewId)?.webContents.openDevTools(); }

  emitAgentBrowserEvent(event: AgentBrowserEvent): void {
    const mainWin = this._getMainWindow?.() ?? null;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('agent-browser-event', event);
  }



  getUrl(viewId: string): string {
    try { return this.get(viewId)?.webContents.getURL() || ''; } catch { return ''; }
  }

  getTitle(viewId: string): string {
    try { return this.get(viewId)?.webContents.getTitle() || ''; } catch { return ''; }
  }



  /** Wait for the page to finish loading. */
  waitForLoad(viewId: string, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const view = this.get(viewId);
      if (!view) return reject(new Error(`View ${viewId} not found`));
      const timer = setTimeout(() => resolve(), timeoutMs); // don't reject, just timeout
      const onFinish = () => { clearTimeout(timer); view.webContents.removeListener('did-finish-load', onFinish); resolve(); };
      view.webContents.on('did-finish-load', onFinish);
      // Also check if already loaded
      if (!view.webContents.isLoading()) { clearTimeout(timer); view.webContents.removeListener('did-finish-load', onFinish); resolve(); }
    });
  }

  /** Wait for a CSS selector to appear on the page. */
  async waitForSelector(viewId: string, selector: string, timeoutMs = 10000): Promise<void> {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const found = await view.webContents.executeJavaScript(
          `!!document.querySelector(${JSON.stringify(selector)})`
        );
        if (found) return;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }



  private _emit(viewId: string, type: string, extra?: Record<string, unknown>): void {
    const mainWin = this._getMainWindow?.() ?? null;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('wv-state-change', { viewId, type, ...(extra || {}) });
  }
}
