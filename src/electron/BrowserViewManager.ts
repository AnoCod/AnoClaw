
// Shared between main.ts IPC handlers and BrowserAgentTool so the agent tool
// can control browser tabs directly through webContents APIs instead of CDP.
//
// Dependencies (WindowManager getter + BrowserWindow ref) are injected via init()
// rather than lazy-required, so this module has no hidden coupling to WindowManager.

import { WebContentsView, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ViewEntry {
  view: WebContentsView;
  bounds: { x: number; y: number; w: number; h: number };
  createdAt: number;
  sessionId?: string;
  workspacePath?: string;
  defaultUserAgent: string;
  consoleLogs: BrowserConsoleLog[];
  networkEvents: BrowserNetworkEvent[];
  networkStarts: Map<string, BrowserNetworkStart>;
  securityEvents: BrowserSecurityEvent[];
  viewport?: BrowserViewportOptions;
}

interface BrowserViewState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  zoomFactor: number;
}

interface BrowserViewOptions {
  sessionId?: string;
  workspacePath?: string;
}

interface BrowserNetworkStart {
  url: string;
  method: string;
  resourceType: string;
  timestamp: number;
}

export interface BrowserNetworkEvent {
  viewId: string;
  id: string;
  state: 'started' | 'completed' | 'failed';
  url: string;
  method: string;
  resourceType: string;
  statusCode?: number;
  fromCache?: boolean;
  error?: string;
  timestamp: number;
  durationMs?: number;
}

export interface BrowserSecurityEvent {
  viewId: string;
  id: string;
  kind: 'popup' | 'external' | 'permission' | 'certificate';
  decision: 'prompt' | 'allowed' | 'blocked' | 'redirected';
  message: string;
  url?: string;
  permission?: string;
  timestamp: number;
}

export interface BrowserFindResult {
  viewId: string;
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
  selectionArea?: unknown;
}

export interface BrowserViewportOptions {
  name: string;
  width?: number;
  height?: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
  userAgent?: string;
}

export interface BrowserConsoleLog {
  level: string;
  message: string;
  line?: number;
  sourceId?: string;
  timestamp: number;
}

export interface BrowserDownloadEvent {
  viewId: string;
  id: string;
  state: 'started' | 'progress' | 'completed' | 'cancelled' | 'interrupted';
  filename: string;
  url: string;
  savePath: string;
  relativePath: string;
  receivedBytes: number;
  totalBytes: number;
  timestamp: number;
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
  private _webContentsToViewId = new Map<number, string>();
  private _downloadSessions = new WeakSet<object>();
  private _networkSessions = new WeakSet<object>();
  private _permissionSessions = new WeakSet<object>();
  private _pendingPermissions = new Map<string, { callback: (allowed: boolean) => void; timer: NodeJS.Timeout; viewId: string; permission: string; url?: string }>();
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



  create(url: string, options: BrowserViewOptions = {}): string {
    if (this._views.size >= this._maxViews) {
      throw new Error(`BrowserView limit reached (max ${this._maxViews})`);
    }
    const viewId = `wv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const view = new WebContentsView({
      webPreferences: { sandbox: false, nodeIntegration: false, contextIsolation: true },
    });
    const webContents = view.webContents;
    const webContentsId = webContents.id;
    webContents.setWindowOpenHandler(({ url: popupUrl }: { url: string }) => {
      this._handlePopup(viewId, popupUrl, view);
      return { action: 'deny' };
    });

    const mainWin = this._getMainWindow?.() ?? null;
    if (mainWin?.contentView) mainWin.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 }); // hidden until positioned

    this._views.set(viewId, {
      view,
      bounds: { x: 0, y: 0, w: 0, h: 0 },
      createdAt: Date.now(),
      sessionId: options.sessionId,
      workspacePath: options.workspacePath,
      defaultUserAgent: webContents.getUserAgent?.() || '',
      consoleLogs: [],
      networkEvents: [],
      networkStarts: new Map(),
      securityEvents: [],
    });
    this._webContentsToViewId.set(webContentsId, viewId);
    this._ensureDownloadHook(webContents.session);
    this._ensureNetworkHook(webContents.session);
    this._ensurePermissionHook(webContents.session);

    // Forward lifecycle events to renderer
    webContents.on('did-start-loading', () => this._emit(viewId, 'loading-start'));
    webContents.on('did-stop-loading', () => this._emit(viewId, 'loading-stop'));
    webContents.on('did-finish-load', () => this._emit(viewId, 'load-finish'));
    webContents.on('did-fail-load', (_e: any, errorCode: number, errorDescription: string, validatedURL: string) => {
      this._emit(viewId, 'load-error', { errorCode, errorDescription, validatedURL });
    });
    webContents.on('page-title-updated', (_e: any, title: string) => {
      this._emit(viewId, 'title', { title });
    });
    webContents.on('page-favicon-updated', (_e: any, favicons: string[]) => {
      this._emit(viewId, 'favicon', { favicons });
    });
    webContents.on('will-navigate', (event: any, navUrl: string) => {
      if (this._isExternalNavigation(navUrl)) {
        event.preventDefault();
        this._recordSecurityEvent(viewId, {
          kind: 'external',
          decision: 'blocked',
          message: 'External navigation was blocked',
          url: navUrl,
        });
      }
    });
    webContents.on('did-navigate', () => this._emit(viewId, 'nav-state'));
    webContents.on('did-navigate-in-page', () => this._emit(viewId, 'nav-state'));
    (webContents as any).on('console-message', (...args: any[]) => this._recordConsoleMessage(viewId, args));
    webContents.on('found-in-page', (_event: unknown, result: any) => this._emitFindResult(viewId, result));
    webContents.on('destroyed', () => {
      this._dropPendingPermissionsForView(viewId);
      this._webContentsToViewId.delete(webContentsId);
      this._views.delete(viewId);
    });

    webContents.loadURL(url);
    return viewId;
  }

  destroy(viewId: string): boolean {
    const entry = this._views.get(viewId);
    if (!entry) return false;
    const webContents = this._safeWebContents(entry);
    const webContentsId = webContents?.id;
    this._dropPendingPermissionsForView(viewId);
    this._views.delete(viewId);
    if (typeof webContentsId === 'number') this._webContentsToViewId.delete(webContentsId);
    const mainWin = this._getMainWindow?.() ?? null;
    if (mainWin?.contentView) {
      try { mainWin.contentView.removeChildView(entry.view); } catch {}
    }
    try {
      if (webContents && !webContents.isDestroyed?.()) webContents.close();
    } catch {}
    return true;
  }

  setMetadata(viewId: string, options: BrowserViewOptions): void {
    const entry = this._views.get(viewId);
    if (!entry) return;
    if (options.sessionId !== undefined) entry.sessionId = options.sessionId;
    if (options.workspacePath !== undefined) entry.workspacePath = options.workspacePath;
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
  setZoomFactor(viewId: string, zoomFactor: number): void {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    const bounded = Math.max(0.25, Math.min(3, zoomFactor));
    view.webContents.setZoomFactor(bounded);
    this._emit(viewId, 'zoom', { zoomFactor: bounded });
  }

  setViewport(viewId: string, viewport: BrowserViewportOptions): void {
    const entry = this._views.get(viewId);
    if (!entry) throw new Error(`View ${viewId} not found`);
    entry.viewport = viewport;
    const wc = entry.view.webContents as any;
    if (viewport.mobile) {
      if (viewport.userAgent) wc.setUserAgent?.(viewport.userAgent);
      wc.enableDeviceEmulation?.({
        screenPosition: 'mobile',
        screenSize: { width: viewport.width || 390, height: viewport.height || 844 },
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: viewport.deviceScaleFactor || 2,
        viewSize: { width: viewport.width || 390, height: viewport.height || 844 },
        scale: 1,
      });
    } else {
      wc.disableDeviceEmulation?.();
      if (entry.defaultUserAgent) wc.setUserAgent?.(entry.defaultUserAgent);
    }
    this._emit(viewId, 'viewport', { viewport });
  }



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

  getState(viewId: string): BrowserViewState | null {
    const view = this.get(viewId);
    if (!view) return null;
    const wc = view.webContents as any;
    const history = wc.navigationHistory;
    return {
      url: wc.getURL?.() || '',
      title: wc.getTitle?.() || '',
      canGoBack: Boolean(history?.canGoBack?.() ?? wc.canGoBack?.() ?? false),
      canGoForward: Boolean(history?.canGoForward?.() ?? wc.canGoForward?.() ?? false),
      isLoading: Boolean(wc.isLoading?.() ?? false),
      zoomFactor: Number(wc.getZoomFactor?.() || 1),
    };
  }

  getConsoleLogs(viewId: string, limit = 80): BrowserConsoleLog[] {
    const entry = this._views.get(viewId);
    if (!entry) return [];
    return entry.consoleLogs.slice(-Math.max(1, Math.min(200, limit)));
  }

  getNetworkEvents(viewId: string, limit = 120): BrowserNetworkEvent[] {
    const entry = this._views.get(viewId);
    if (!entry) return [];
    return entry.networkEvents.slice(-Math.max(1, Math.min(200, limit)));
  }

  getSecurityEvents(viewId: string, limit = 60): BrowserSecurityEvent[] {
    const entry = this._views.get(viewId);
    if (!entry) return [];
    return entry.securityEvents.slice(-Math.max(1, Math.min(120, limit)));
  }

  findInPage(viewId: string, text: string, options: { forward?: boolean; findNext?: boolean; matchCase?: boolean } = {}): number {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    if (!text) {
      view.webContents.stopFindInPage('clearSelection');
      return 0;
    }
    return view.webContents.findInPage(text, {
      forward: options.forward !== false,
      findNext: Boolean(options.findNext),
      matchCase: Boolean(options.matchCase),
    });
  }

  stopFindInPage(viewId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'): void {
    const view = this.get(viewId);
    if (!view) throw new Error(`View ${viewId} not found`);
    view.webContents.stopFindInPage(action);
  }

  resolvePermission(eventId: string, allowed: boolean): boolean {
    const pending = this._pendingPermissions.get(eventId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pendingPermissions.delete(eventId);
    pending.callback(allowed);
    this._recordSecurityEvent(pending.viewId, {
      id: eventId,
      kind: 'permission',
      decision: allowed ? 'allowed' : 'blocked',
      permission: pending.permission,
      url: pending.url,
      message: `${pending.permission} permission ${allowed ? 'allowed' : 'blocked'}`,
    });
    return true;
  }

  handleCertificateError(webContents: { id?: number } | null | undefined, url: string, error: string): boolean {
    const viewId = this._webContentsToViewId.get(Number(webContents?.id));
    if (!viewId || !this._views.has(viewId)) return false;
    this._recordSecurityEvent(viewId, {
      kind: 'certificate',
      decision: 'blocked',
      message: `Certificate error: ${error}`,
      url,
    });
    return true;
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
    if (!this._views.has(viewId)) return;
    const mainWin = this._getMainWindow?.() ?? null;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('wv-state-change', { viewId, type, ...(this.getState(viewId) || {}), ...(extra || {}) });
  }

  private _recordConsoleMessage(viewId: string, args: any[]): void {
    const entry = this._views.get(viewId);
    if (!entry) return;
    const details = args.find((arg) => arg && typeof arg === 'object' && ('message' in arg || 'level' in arg));
    const legacyLevel = args[1];
    const legacyMessage = args[2];
    const log: BrowserConsoleLog = {
      level: String(details?.level ?? legacyLevel ?? 'log'),
      message: String(details?.message ?? legacyMessage ?? ''),
      line: Number(details?.line ?? args[3] ?? 0) || undefined,
      sourceId: typeof details?.sourceId === 'string' ? details.sourceId : (typeof args[4] === 'string' ? args[4] : undefined),
      timestamp: Date.now(),
    };
    if (!log.message) return;
    entry.consoleLogs.push(log);
    if (entry.consoleLogs.length > 200) entry.consoleLogs.splice(0, entry.consoleLogs.length - 200);
    this._emit(viewId, 'console-message', { consoleLog: log });
  }

  private _recordNetworkEvent(viewId: string, event: BrowserNetworkEvent): void {
    const entry = this._views.get(viewId);
    if (!entry) return;
    entry.networkEvents.push(event);
    if (entry.networkEvents.length > 200) entry.networkEvents.splice(0, entry.networkEvents.length - 200);
    this._emitNetwork(event);
  }

  private _recordSecurityEvent(viewId: string, partial: Omit<BrowserSecurityEvent, 'viewId' | 'id' | 'timestamp'> & { id?: string }): string {
    const entry = this._views.get(viewId);
    const id = partial.id || `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (!entry) return id;
    const event: BrowserSecurityEvent = { viewId, id, timestamp: Date.now(), ...partial };
    const idx = entry.securityEvents.findIndex(item => item.id === id);
    if (idx >= 0) entry.securityEvents[idx] = event;
    else entry.securityEvents.push(event);
    if (entry.securityEvents.length > 120) entry.securityEvents.splice(0, entry.securityEvents.length - 120);
    this._emitSecurity(event);
    return id;
  }

  private _emitFindResult(viewId: string, result: any): void {
    if (!this._views.has(viewId)) return;
    const event: BrowserFindResult = {
      viewId,
      requestId: Number(result?.requestId || 0),
      activeMatchOrdinal: Number(result?.activeMatchOrdinal || 0),
      matches: Number(result?.matches || 0),
      finalUpdate: Boolean(result?.finalUpdate),
      selectionArea: result?.selectionArea,
    };
    const mainWin = this._getMainWindow?.() ?? null;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('wv-find-result', event);
  }

  private _ensureNetworkHook(session: object): void {
    if (this._networkSessions.has(session)) return;
    this._networkSessions.add(session);
    const webRequest = (session as any).webRequest;
    if (!webRequest) return;
    const filter = { urls: ['<all_urls>'] };

    webRequest.onBeforeRequest(filter, (details: any, callback: (response: { cancel?: boolean }) => void) => {
      const viewId = this._webContentsToViewId.get(Number(details?.webContentsId));
      if (viewId) {
        const entry = this._views.get(viewId);
        const id = String(details?.id || `${Date.now()}-${Math.random()}`);
        const start: BrowserNetworkStart = {
          url: String(details?.url || ''),
          method: String(details?.method || 'GET'),
          resourceType: String(details?.resourceType || 'other'),
          timestamp: Date.now(),
        };
        entry?.networkStarts.set(id, start);
        this._recordNetworkEvent(viewId, { viewId, id, state: 'started', ...start });
      }
      callback({ cancel: false });
    });

    webRequest.onCompleted(filter, (details: any) => {
      const viewId = this._webContentsToViewId.get(Number(details?.webContentsId));
      if (!viewId) return;
      const entry = this._views.get(viewId);
      const id = String(details?.id || '');
      const start = entry?.networkStarts.get(id);
      if (entry && id) entry.networkStarts.delete(id);
      const timestamp = Date.now();
      this._recordNetworkEvent(viewId, {
        viewId,
        id,
        state: 'completed',
        url: String(details?.url || start?.url || ''),
        method: String(details?.method || start?.method || 'GET'),
        resourceType: String(details?.resourceType || start?.resourceType || 'other'),
        statusCode: Number(details?.statusCode || 0) || undefined,
        fromCache: Boolean(details?.fromCache),
        timestamp,
        durationMs: start ? timestamp - start.timestamp : undefined,
      });
    });

    webRequest.onErrorOccurred(filter, (details: any) => {
      const viewId = this._webContentsToViewId.get(Number(details?.webContentsId));
      if (!viewId) return;
      const entry = this._views.get(viewId);
      const id = String(details?.id || '');
      const start = entry?.networkStarts.get(id);
      if (entry && id) entry.networkStarts.delete(id);
      const timestamp = Date.now();
      this._recordNetworkEvent(viewId, {
        viewId,
        id,
        state: 'failed',
        url: String(details?.url || start?.url || ''),
        method: String(details?.method || start?.method || 'GET'),
        resourceType: String(details?.resourceType || start?.resourceType || 'other'),
        error: String(details?.error || 'Network error'),
        timestamp,
        durationMs: start ? timestamp - start.timestamp : undefined,
      });
    });
  }

  private _ensureDownloadHook(session: object): void {
    if (this._downloadSessions.has(session)) return;
    this._downloadSessions.add(session);
    (session as any).on('will-download', (_event: unknown, item: any, webContents: any) => {
      const viewId = this._webContentsToViewId.get(webContents?.id);
      if (!viewId) return;
      this._handleDownload(viewId, item);
    });
  }

  private _handleDownload(viewId: string, item: any): void {
    const entry = this._views.get(viewId);
    if (!entry) return;
    const workspacePath = entry.workspacePath ? path.resolve(entry.workspacePath) : '';
    const filename = sanitizeDownloadFilename(item.getFilename?.() || 'download');
    let savePath = item.getSavePath?.() || '';
    let relativePath = '';

    if (workspacePath) {
      const targetDir = path.join(workspacePath, 'downloads');
      fs.mkdirSync(targetDir, { recursive: true });
      savePath = uniqueDownloadPath(targetDir, filename);
      relativePath = path.relative(workspacePath, savePath).replace(/\\/g, '/');
      item.setSavePath?.(savePath);
    }

    const downloadId = `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const emitDownload = (state: BrowserDownloadEvent['state']) => {
      this._emitDownload({
        viewId,
        id: downloadId,
        state,
        filename,
        url: item.getURL?.() || '',
        savePath: item.getSavePath?.() || savePath,
        relativePath,
        receivedBytes: Number(item.getReceivedBytes?.() || 0),
        totalBytes: Number(item.getTotalBytes?.() || 0),
        timestamp: Date.now(),
      });
    };

    emitDownload('started');
    item.on?.('updated', (_event: unknown, state: string) => emitDownload(state === 'interrupted' ? 'interrupted' : 'progress'));
    item.once?.('done', (_event: unknown, state: string) => {
      emitDownload(state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted');
    });
  }

  private _ensurePermissionHook(session: object): void {
    if (this._permissionSessions.has(session)) return;
    this._permissionSessions.add(session);
    (session as any).setPermissionRequestHandler?.((webContents: any, permission: string, callback: (allowed: boolean) => void, details?: any) => {
      const viewId = this._webContentsToViewId.get(Number(webContents?.id));
      if (!viewId || !this._views.has(viewId)) { callback(false); return; }
      const url = String(details?.requestingUrl || details?.embeddingOrigin || this.getUrl(viewId) || '');
      const id = this._recordSecurityEvent(viewId, {
        kind: 'permission',
        decision: 'prompt',
        permission,
        url,
        message: `${permission} permission requested`,
      });
      const timer = setTimeout(() => {
        const pending = this._pendingPermissions.get(id);
        if (!pending) return;
        this._pendingPermissions.delete(id);
        pending.callback(false);
        this._recordSecurityEvent(viewId, {
          id,
          kind: 'permission',
          decision: 'blocked',
          permission,
          url,
          message: `${permission} permission timed out`,
        });
      }, 15000);
      this._pendingPermissions.set(id, { callback, timer, viewId, permission, url });
    });
  }

  private _emitNetwork(event: BrowserNetworkEvent): void {
    if (!this._views.has(event.viewId)) return;
    const mainWin = this._getMainWindow?.() ?? null;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('wv-network', event);
  }

  private _emitSecurity(event: BrowserSecurityEvent): void {
    if (!this._views.has(event.viewId)) return;
    const mainWin = this._getMainWindow?.() ?? null;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('wv-security', event);
  }

  private _handlePopup(viewId: string, popupUrl: string, view: WebContentsView): void {
    if (!this._views.has(viewId)) return;
    if (!popupUrl || popupUrl === 'about:blank') return;
    if (this._isExternalNavigation(popupUrl)) {
      this._recordSecurityEvent(viewId, {
        kind: 'external',
        decision: 'blocked',
        message: 'External popup was blocked',
        url: popupUrl,
      });
      return;
    }
    this._recordSecurityEvent(viewId, {
      kind: 'popup',
      decision: 'redirected',
      message: 'Popup opened in the current browser tab',
      url: popupUrl,
    });
    try {
      const webContents = view.webContents as WebContents | undefined;
      if (webContents && !webContents.isDestroyed?.()) webContents.loadURL(popupUrl);
    } catch {}
  }

  private _emitDownload(event: BrowserDownloadEvent): void {
    if (!this._views.has(event.viewId)) return;
    const mainWin = this._getMainWindow?.() ?? null;
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send('wv-download', event);
  }

  private _safeWebContents(entry: ViewEntry): WebContents | null {
    try {
      return (entry.view.webContents as WebContents | undefined) ?? null;
    } catch {
      return null;
    }
  }

  private _dropPendingPermissionsForView(viewId: string): void {
    for (const [id, pending] of [...this._pendingPermissions.entries()]) {
      if (pending.viewId !== viewId) continue;
      clearTimeout(pending.timer);
      this._pendingPermissions.delete(id);
      try { pending.callback(false); } catch {}
    }
  }

  private _isExternalNavigation(url: string): boolean {
    if (!url) return false;
    return !/^(https?:|file:|about:|data:|blob:|view-source:)/i.test(url);
  }
}

function sanitizeDownloadFilename(filename: string): string {
  const cleaned = filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'download';
}

function uniqueDownloadPath(dir: string, filename: string): string {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name} (${i})${parsed.ext}`);
    i++;
  }
  return candidate;
}
