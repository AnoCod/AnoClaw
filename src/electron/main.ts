import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
} from 'electron';
import { WindowManager } from './WindowManager.js';
import { TrayManager } from './TrayManager.js';
import { FloatingBallManager } from './FloatingBallManager.js';
import { BrowserViewManager } from './BrowserViewManager.js';
import { getAutoStart, setAutoStart } from './AutoStart.js';
import { init as initSetup, needsSetup, runSetupWizard } from './SetupWizard.js';
import { startServer, shutdown } from '../server/main.js';
import * as fs from 'fs';
import * as path from 'path';

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
  const { app, ipcMain, BrowserWindow: BW, WebContentsView, dialog, Tray, Menu, nativeImage, shell, Notification } = electron;

  // Init singletons with Electron deps
  WindowManager.init(BW);
  TrayManager.init(Tray, Menu, app, nativeImage);
  FloatingBallManager.init(BW, ipcMain);
  BrowserViewManager.init(() => WindowManager.getInstance().getMainWindow());

  // Provide recent sessions to the floating ball
  let sessionManager: any = null;
  FloatingBallManager.getInstance().setSessionProvider(async () => {
    try {
      const { SessionManager } = await import('../server/core/session/SessionManager.js');
      sessionManager = SessionManager.getInstance();
      const all = sessionManager.getAllSessions();
      // Return recent sessions (last 5 active)
      const recent = all
        .sort((a: any, b: any) => new Date(b.lastActiveAt || 0).getTime() - new Date(a.lastActiveAt || 0).getTime())
        .slice(0, 5)
        .map((s: any) => ({ id: s.id, title: s.title || 'Session' }));
      return recent;
    } catch { return []; }
  });

  // ── Window control IPC ──
  // window-minimize-animate: triggered by TitleBar ─ shrink main window to 56x56, then show floating ball.
  ipcMain.on('window-minimize-animate', () => {
    const mainWin = WindowManager.getInstance().getMainWindow();
    if (mainWin && !globalThis._quitting) {
      FloatingBallManager.getInstance().animateMinimize(mainWin);
    }
  });
  // window-minimize: direct hide (no animation) + show floating ball.
  ipcMain.on('window-minimize', (e: IpcMainEvent) => {
    const win = BW.fromWebContents(e.sender);
    if (win && !globalThis._quitting) {
      const bounds = win.getBounds();
      FloatingBallManager.getInstance().saveMainWindowBounds(bounds);
      win.hide();
      FloatingBallManager.getInstance().show();
    }
  });
  ipcMain.on('window-maximize', (e: IpcMainEvent) => {
    const win = BW.fromWebContents(e.sender);
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('window-close', () => {
    // Close → truly quit the process
    globalThis._quitting = true;
    FloatingBallManager.getInstance().hide();
    app.quit();
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

  const wireFloatingBallMinimize = (win: any): void => {
    if (!win || win.__floatingBallMinimizeWired) return;
    win.__floatingBallMinimizeWired = true;
    win.on('minimize', (event: { preventDefault: () => void }) => {
      if (globalThis._quitting) return;
      event.preventDefault();
      FloatingBallManager.getInstance().saveMainWindowBounds(win.getBounds());
      win.hide();
      FloatingBallManager.getInstance().show();
    });
  };

  ipcMain.handle('wv-create', async (_e: IpcMainInvokeEvent, url: string, options?: { sessionId?: string; workspacePath?: string }) => {
    try { return { viewId: bvm.create(url, options || {}) }; }
    catch (err) { return { viewId: null, error: String(err) }; }
  });

  ipcMain.handle('wv-set-metadata', async (_e: IpcMainInvokeEvent, viewId: string, options?: { sessionId?: string; workspacePath?: string }) => {
    try { bvm.setMetadata(viewId, options || {}); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-navigate', async (_e: IpcMainInvokeEvent, viewId: string, url: string) => {
    try { bvm.navigate(viewId, url); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-set-bounds', (_e: IpcMainInvokeEvent, viewId: string, x: number, y: number, w: number, h: number) => {
    bvm.setBounds(viewId, x, y, w, h);
    return { ok: true };
  });

  ipcMain.handle('wv-destroy', (_e: IpcMainInvokeEvent, viewId: string) => {
    return { ok: bvm.destroy(viewId) };
  });

  ipcMain.handle('wv-go-back', (_e: IpcMainInvokeEvent, viewId: string) => {
    try { bvm.goBack(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-go-forward', (_e: IpcMainInvokeEvent, viewId: string) => {
    try { bvm.goForward(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-reload', (_e: IpcMainInvokeEvent, viewId: string) => {
    try { bvm.reload(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-set-zoom', (_e: IpcMainInvokeEvent, viewId: string, zoomFactor: number) => {
    try { bvm.setZoomFactor(viewId, zoomFactor); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-set-viewport', (_e: IpcMainInvokeEvent, viewId: string, viewport: { name: string; width?: number; height?: number; mobile?: boolean; deviceScaleFactor?: number; userAgent?: string }) => {
    try { bvm.setViewport(viewId, viewport); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-dev-tools', (_e: IpcMainInvokeEvent, viewId: string) => {
    bvm.devTools(viewId);
    return { ok: true };
  });

  ipcMain.handle('wv-capture-screenshot', async (_e: IpcMainInvokeEvent, viewId: string, _rect?: any) => {
    try {
      const dataUrl = await bvm.screenshot(viewId);
      return { ok: true, dataUrl };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-exec-js', async (_e: IpcMainInvokeEvent, viewId: string, code: string) => {
    try {
      const result = await bvm.execJs(viewId, code);
      return { ok: true, result };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-get-console', (_e: IpcMainInvokeEvent, viewId: string, limit?: number) => {
    try { return { ok: true, logs: bvm.getConsoleLogs(viewId, limit) }; }
    catch (err) { return { ok: false, error: String(err), logs: [] }; }
  });

  ipcMain.handle('wv-get-network', (_e: IpcMainInvokeEvent, viewId: string, limit?: number) => {
    try { return { ok: true, events: bvm.getNetworkEvents(viewId, limit) }; }
    catch (err) { return { ok: false, error: String(err), events: [] }; }
  });

  ipcMain.handle('wv-get-security', (_e: IpcMainInvokeEvent, viewId: string, limit?: number) => {
    try { return { ok: true, events: bvm.getSecurityEvents(viewId, limit) }; }
    catch (err) { return { ok: false, error: String(err), events: [] }; }
  });

  ipcMain.handle('wv-find-in-page', (_e: IpcMainInvokeEvent, viewId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => {
    try { return { ok: true, requestId: bvm.findInPage(viewId, text, options || {}) }; }
    catch (err) { return { ok: false, error: String(err), requestId: 0 }; }
  });

  ipcMain.handle('wv-stop-find', (_e: IpcMainInvokeEvent, viewId: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => {
    try { bvm.stopFindInPage(viewId, action || 'clearSelection'); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-resolve-permission', (_e: IpcMainInvokeEvent, eventId: string, allowed: boolean) => {
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

  ipcMain.handle('wv-enable-context-capture', (_e: IpcMainInvokeEvent, viewId: string) => {
    const code = getCtxCaptureCode();
    if (code) bvm.execJs(viewId, code);
    return { ok: true };
  });

  // ── Lifecycle ──
  app.whenReady().then(async () => {
    try {
      await startServer();

      // Check if first-run setup is needed
      initSetup(BW, ipcMain);
      if (needsSetup()) {
        await runSetupWizard();
        // Setup wizard saved agent config + settings — reload server to pick them up
        await shutdown();
        await startServer();
      }

      wireFloatingBallMinimize(WindowManager.getInstance().createWindow());
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

  app.on('window-all-closed', () => { app.quit(); });
  app.on('before-quit', async () => { globalThis._quitting = true; await shutdown(); });
  app.on('certificate-error', (event: any, webContents: any, url: string, error: string, _certificate: unknown, callback: (allowed: boolean) => void) => {
    if (!bvm.handleCertificateError(webContents, url, error)) return;
    event.preventDefault();
    callback(false);
  });
  app.on('activate', () => {
    if (!WindowManager.getInstance().getMainWindow()) wireFloatingBallMinimize(WindowManager.getInstance().createWindow());
  });
}
