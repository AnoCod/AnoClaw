import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
} from 'electron';
import { WindowManager } from './WindowManager.js';
import { TrayManager } from './TrayManager.js';
import { BrowserViewManager } from './BrowserViewManager.js';
import { AppLifecycleController } from './AppLifecycleController.js';
import { getAutoStart, setAutoStart } from './AutoStart.js';
import { init as initSetup, needsSetup, runSetupWizard } from './SetupWizard.js';
import { startServer, shutdown } from '../server/main.js';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PORT } from '../shared/constants.js';
import { getTrustedUiToken, TRUSTED_UI_HEADER } from '../server/gateway/TrustedUiAuth.js';

function normalizeOpenPathInput(filePath: string): string {
  let normalized = filePath.trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (/^file:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      normalized = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(normalized)) normalized = normalized.slice(1);
    } catch {
      // Fall through to regular path resolution.
    }
  }

  const withLocation = normalized.match(/^(.*):(\d+)(?::\d+|-\d+)?$/);
  if (withLocation && path.extname(withLocation[1])) {
    normalized = withLocation[1];
  }
  return normalized;
}

export async function createApp(electron: typeof import('electron')) {
  const { app, ipcMain, BrowserWindow: BW, WebContentsView, dialog, Tray, Menu, nativeImage, shell, Notification, session } = electron;

  // Init singletons with Electron deps
  WindowManager.init(BW);
  TrayManager.init(Tray, Menu, app, nativeImage);
  BrowserViewManager.init(() => WindowManager.getInstance().getMainWindow());

  const lifecycle = new AppLifecycleController({
    quit: () => app.quit(),
    forceExit: (exitCode) => app.exit(exitCode),
    listWindows: () => BW.getAllWindows(),
    markQuitting: () => { globalThis._quitting = true; },
    gracefulShutdown: async () => {
      try {
        await shutdown();
      } catch (error) {
        console.error('[shutdown] Server drain failed', error);
      }
      try {
        const { LogManager } = await import('../server/infra/logging/LogManager.js');
        await LogManager.getInstance().shutdown();
      } catch (error) {
        console.error('[shutdown] Log flush failed', error);
      }
    },
    reportError: (message, error) => console.error(`[shutdown] ${message}`, error ?? ''),
  });

  // ── Window control IPC ──
  ipcMain.on('window-minimize', (e: IpcMainEvent) => {
    const win = BW.fromWebContents(e.sender);
    if (win && !globalThis._quitting) win.minimize();
  });
  ipcMain.on('window-maximize', (e: IpcMainEvent) => {
    const win = BW.fromWebContents(e.sender);
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('window-close', () => {
    lifecycle.requestQuit();
  });
  ipcMain.handle('window-is-maximized', (e: IpcMainInvokeEvent) => BW.fromWebContents(e.sender)?.isMaximized() ?? false);
  ipcMain.handle('dialog-open', async (e: IpcMainInvokeEvent, opts: Electron.OpenDialogOptions) => {
    const win = BW.fromWebContents(e.sender) ?? undefined;
    return dialog.showOpenDialog(win!, opts);
  });
  ipcMain.handle('dialog-save', async (e: IpcMainInvokeEvent, opts: Electron.SaveDialogOptions) => {
    const win = BW.fromWebContents(e.sender) ?? undefined;
    return dialog.showSaveDialog(win!, opts);
  });
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-autostart', () => getAutoStart(app));
  ipcMain.on('set-autostart', (_e: IpcMainEvent, enabled: boolean) => setAutoStart(app, enabled));

  // ── File/link opening IPC ──
  ipcMain.handle('open-external', async (_e: IpcMainInvokeEvent, url: string) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        await shell.openExternal(url);
        return { ok: true };
      }
      return { ok: false, error: 'Unsupported protocol' };
    } catch {
      return { ok: false, error: 'Invalid URL' };
    }
  });
  ipcMain.handle('open-path', async (_e: IpcMainInvokeEvent, filePath: string) => {
    // Basic safety validation
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'Invalid path: must be a non-empty string' };
    }
    const normalizedPath = normalizeOpenPathInput(filePath);
    const resolved = path.resolve(normalizedPath);
    // Block path traversal to sensitive system directories
    const dangerousPrefixes = ['C:\\Windows', 'C:\\Windows\\System32', '/etc', '/sys', '/proc'];
    for (const prefix of dangerousPrefixes) {
      if (resolved.startsWith(prefix + path.sep) || resolved === prefix) {
        return { ok: false, error: 'Access denied: path is in a protected system directory' };
      }
    }
    // Check existence
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `Path not found: ${normalizedPath}` };
    }
    const err = await shell.openPath(resolved);
    if (err) return { ok: false, error: err };
    return { ok: true };
  });

  // ── Desktop notification IPC ──
  ipcMain.handle('show-notification', (_event: IpcMainInvokeEvent, title: string, body: string) => {
    if (Notification.isSupported()) {
      try {
        const n = new Notification({ title, body, urgency: 'normal' as const });
        n.on('click', () => {
          const win = BW.getAllWindows()[0];
          if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
          }
        });
        n.show();
        return { ok: true };
      } catch {
        return { ok: false, error: 'Notification failed' };
      }
    }
    return { ok: false, error: 'Notifications not supported' };
  });

  // ── WebContentsView management IPC (delegates to BrowserViewManager) ──
  const bvm = BrowserViewManager.getInstance();
  const rendererOwnsView = (event: IpcMainInvokeEvent, viewId: string): boolean =>
    bvm.isOwnedByWindow(viewId, BW.fromWebContents(event.sender));
  const viewOwnershipError = { ok: false, error: 'Browser view belongs to another window' } as const;

  ipcMain.handle('wv-register-window-session', (event: IpcMainInvokeEvent, sessionId: string) => {
    const ownerWindow = BW.fromWebContents(event.sender);
    if (!ownerWindow) return { ok: false, error: 'Renderer window not found' };
    bvm.registerWindowSession(ownerWindow, String(sessionId || ''));
    return { ok: true };
  });

  ipcMain.handle('wv-create', async (event: IpcMainInvokeEvent, url: string, options?: { sessionId?: string; workspacePath?: string }) => {
    try { return { viewId: bvm.create(url, options || {}, BW.fromWebContents(event.sender)) }; }
    catch (err) { return { viewId: null, error: String(err) }; }
  });

  ipcMain.handle('wv-set-metadata', async (event: IpcMainInvokeEvent, viewId: string, options?: { sessionId?: string; workspacePath?: string }) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.setMetadata(viewId, options || {}); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-navigate', async (event: IpcMainInvokeEvent, viewId: string, url: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.navigate(viewId, url); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-set-bounds', (event: IpcMainInvokeEvent, viewId: string, x: number, y: number, w: number, h: number) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    bvm.setBounds(viewId, x, y, w, h);
    return { ok: true };
  });

  ipcMain.handle('wv-destroy', (event: IpcMainInvokeEvent, viewId: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    return { ok: bvm.destroy(viewId) };
  });

  ipcMain.handle('wv-go-back', (event: IpcMainInvokeEvent, viewId: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.goBack(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-go-forward', (event: IpcMainInvokeEvent, viewId: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.goForward(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-reload', (event: IpcMainInvokeEvent, viewId: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.reload(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-set-zoom', (event: IpcMainInvokeEvent, viewId: string, zoomFactor: number) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.setZoomFactor(viewId, zoomFactor); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-set-viewport', (event: IpcMainInvokeEvent, viewId: string, viewport: { name: string; width?: number; height?: number; mobile?: boolean; deviceScaleFactor?: number; userAgent?: string }) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.setViewport(viewId, viewport); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-dev-tools', (event: IpcMainInvokeEvent, viewId: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    bvm.devTools(viewId);
    return { ok: true };
  });

  ipcMain.handle('wv-capture-screenshot', async (event: IpcMainInvokeEvent, viewId: string, _rect?: any) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try {
      const dataUrl = await bvm.screenshot(viewId);
      return { ok: true, dataUrl };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-exec-js', async (event: IpcMainInvokeEvent, viewId: string, code: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try {
      const result = await bvm.execJs(viewId, code);
      return { ok: true, result };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-get-console', (event: IpcMainInvokeEvent, viewId: string, limit?: number) => {
    if (!rendererOwnsView(event, viewId)) return { ...viewOwnershipError, logs: [] };
    try { return { ok: true, logs: bvm.getConsoleLogs(viewId, limit) }; }
    catch (err) { return { ok: false, error: String(err), logs: [] }; }
  });

  ipcMain.handle('wv-get-network', (event: IpcMainInvokeEvent, viewId: string, limit?: number) => {
    if (!rendererOwnsView(event, viewId)) return { ...viewOwnershipError, events: [] };
    try { return { ok: true, events: bvm.getNetworkEvents(viewId, limit) }; }
    catch (err) { return { ok: false, error: String(err), events: [] }; }
  });

  ipcMain.handle('wv-get-security', (event: IpcMainInvokeEvent, viewId: string, limit?: number) => {
    if (!rendererOwnsView(event, viewId)) return { ...viewOwnershipError, events: [] };
    try { return { ok: true, events: bvm.getSecurityEvents(viewId, limit) }; }
    catch (err) { return { ok: false, error: String(err), events: [] }; }
  });

  ipcMain.handle('wv-find-in-page', (event: IpcMainInvokeEvent, viewId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => {
    if (!rendererOwnsView(event, viewId)) return { ...viewOwnershipError, requestId: 0 };
    try { return { ok: true, requestId: bvm.findInPage(viewId, text, options || {}) }; }
    catch (err) { return { ok: false, error: String(err), requestId: 0 }; }
  });

  ipcMain.handle('wv-stop-find', (event: IpcMainInvokeEvent, viewId: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    try { bvm.stopFindInPage(viewId, action || 'clearSelection'); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-resolve-permission', (event: IpcMainInvokeEvent, eventId: string, allowed: boolean) => {
    if (!bvm.isPermissionOwnedByWindow(eventId, BW.fromWebContents(event.sender))) {
      return { ok: false, error: 'Browser permission belongs to another window' };
    }
    try { return { ok: bvm.resolvePermission(eventId, allowed) }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  // Cache context-capture script (loaded once from file)
  let _ctxCaptureCode: string | null = null;
  const getCtxCaptureCode = (): string => {
    if (_ctxCaptureCode !== null) return _ctxCaptureCode;
    try {
      _ctxCaptureCode = fs.readFileSync(path.join(import.meta.dirname, 'context-capture.js'), 'utf-8');
    } catch {
      _ctxCaptureCode = '';
    }
    return _ctxCaptureCode;
  };

  ipcMain.handle('wv-enable-context-capture', (event: IpcMainInvokeEvent, viewId: string) => {
    if (!rendererOwnsView(event, viewId)) return viewOwnershipError;
    const code = getCtxCaptureCode();
    if (code) bvm.execJs(viewId, code);
    return { ok: true };
  });

  // ── Lifecycle ──
  app.whenReady().then(async () => {
    try {
      const trustedUiToken = getTrustedUiToken();
      let activeUiPort = DEFAULT_PORT;
      session.defaultSession.webRequest.onBeforeSendHeaders(
        {
          urls: [
            'http://localhost/*',
            'http://127.0.0.1/*',
          ],
        },
        (details, callback) => {
          try {
            const requestUrl = new URL(details.url);
            const requestPort = Number(requestUrl.port || '80');
            if (requestPort === activeUiPort && requestUrl.pathname.startsWith('/api/')) {
              details.requestHeaders[TRUSTED_UI_HEADER] = trustedUiToken;
            }
          } catch { /* leave unrelated requests untouched */ }
          callback({ requestHeaders: details.requestHeaders });
        },
      );
      const useServerPort = (runningServer: import('node:http').Server): void => {
        const address = runningServer.address();
        if (address && typeof address !== 'string') activeUiPort = address.port;
        WindowManager.getInstance().setServerPort(activeUiPort);
      };
      useServerPort(await startServer());

      // Check if first-run setup is needed
      initSetup(BW, ipcMain);
      if (needsSetup()) {
        // Closing the setup window briefly leaves Electron with zero windows.
        // Suppress window-all-closed until the configured main window exists.
        lifecycle.setSetupTransitionInProgress(true);
        await runSetupWizard();
        // Setup wizard saved agent config + settings — reload server to pick them up
        await shutdown();
        useServerPort(await startServer());
      }

      WindowManager.getInstance().createWindow();
      lifecycle.setSetupTransitionInProgress(false);
      TrayManager.getInstance().createTray();

      // ── Keyboard shortcuts (hidden menu) ──
      Menu.setApplicationMenu(Menu.buildFromTemplate([{
        label: 'App',
        submenu: [
          { role: 'reload', accelerator: 'CmdOrCtrl+R' },
          { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
          { type: 'separator' },
          { role: 'toggleDevTools', accelerator: 'F12' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]));
    } catch (err) {
      dialog.showErrorBox('Startup Error', `Failed to start AnoClaw:\n${(err as Error).message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => lifecycle.handleAllWindowsClosed());
  app.on('before-quit', (event) => lifecycle.handleBeforeQuit(event));
  app.on('certificate-error', (event: any, webContents: any, url: string, error: string, _certificate: unknown, callback: (allowed: boolean) => void) => {
    if (!bvm.handleCertificateError(webContents, url, error)) return;
    event.preventDefault();
    callback(false);
  });
  app.on('activate', () => {
    if (!WindowManager.getInstance().getMainWindow()) WindowManager.getInstance().createWindow();
  });
}
