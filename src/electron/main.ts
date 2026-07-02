import { WindowManager } from './WindowManager.js';
import { TrayManager } from './TrayManager.js';
import { FloatingBallManager } from './FloatingBallManager.js';
import { BrowserViewManager } from './BrowserViewManager.js';
import { getAutoStart, setAutoStart } from './AutoStart.js';
import { init as initSetup, needsSetup, runSetupWizard } from './SetupWizard.js';
import { startServer, shutdown } from '../server/main.js';
import * as fs from 'fs';
import * as path from 'path';

export async function createApp(electron: any) {
  const { app, ipcMain, BrowserWindow, WebContentsView, dialog, Tray, Menu, nativeImage, shell, Notification } = electron;

  // Init singletons with Electron deps
  WindowManager.init(BrowserWindow);
  TrayManager.init(Tray, Menu, app, nativeImage);
  FloatingBallManager.init(BrowserWindow, ipcMain);

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
  ipcMain.on('window-minimize', (e: any) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !globalThis._quitting) {
      const bounds = win.getBounds();
      FloatingBallManager.getInstance().saveMainWindowBounds(bounds);
      win.hide();
      FloatingBallManager.getInstance().show();
    }
  });
  ipcMain.on('window-maximize', (e: any) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('window-close', () => {
    // Close → truly quit the process
    globalThis._quitting = true;
    FloatingBallManager.getInstance().hide();
    app.quit();
  });
  ipcMain.handle('window-is-maximized', (e: any) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);
  ipcMain.handle('dialog-open', async (e: any, opts: any) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    return dialog.showOpenDialog(win!, opts);
  });
  ipcMain.handle('dialog-save', async (e: any, opts: any) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    return dialog.showSaveDialog(win!, opts);
  });
  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-autostart', () => getAutoStart(app));
  ipcMain.on('set-autostart', (_: any, enabled: boolean) => setAutoStart(app, enabled));

  // ── File/link opening IPC ──
  ipcMain.handle('open-external', async (_: any, url: string) => {
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
  ipcMain.handle('open-path', async (_: any, filePath: string) => {
    // Basic safety validation
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, error: 'Invalid path: must be a non-empty string' };
    }
    const resolved = path.resolve(filePath);
    // Block path traversal to sensitive system directories
    const dangerousPrefixes = ['C:\\Windows', 'C:\\Windows\\System32', '/etc', '/sys', '/proc'];
    for (const prefix of dangerousPrefixes) {
      if (resolved.startsWith(prefix + path.sep) || resolved === prefix) {
        return { ok: false, error: 'Access denied: path is in a protected system directory' };
      }
    }
    // Check existence
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `Path not found: ${filePath}` };
    }
    const err = await shell.openPath(resolved);
    if (err) return { ok: false, error: err };
    return { ok: true };
  });

  // ── Desktop notification IPC ──
  ipcMain.handle('show-notification', (_event: any, title: string, body: string) => {
    if (Notification.isSupported()) {
      try {
        const n = new Notification({ title, body, urgency: 'normal' as const });
        n.on('click', () => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
          }
        });
        n.show();
      } catch {
        // Notification may not be supported in some environments
      }
    }
  });

  // ── WebContentsView management IPC (delegates to BrowserViewManager) ──
  const bvm = BrowserViewManager.getInstance();

  ipcMain.handle('wv-create', async (_e: any, url: string) => {
    try { return { viewId: bvm.create(url) }; }
    catch (err) { return { viewId: null, error: String(err) }; }
  });

  ipcMain.handle('wv-navigate', async (_e: any, viewId: string, url: string) => {
    try { bvm.navigate(viewId, url); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-set-bounds', (_e: any, viewId: string, x: number, y: number, w: number, h: number) => {
    bvm.setBounds(viewId, x, y, w, h);
    return { ok: true };
  });

  ipcMain.handle('wv-destroy', (_e: any, viewId: string) => {
    return { ok: bvm.destroy(viewId) };
  });

  ipcMain.handle('wv-go-back', (_e: any, viewId: string) => {
    try { bvm.goBack(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-go-forward', (_e: any, viewId: string) => {
    try { bvm.goForward(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-reload', (_e: any, viewId: string) => {
    try { bvm.reload(viewId); return { ok: true }; }
    catch { return { ok: false }; }
  });

  ipcMain.handle('wv-dev-tools', (_e: any, viewId: string) => {
    bvm.devTools(viewId);
    return { ok: true };
  });

  ipcMain.handle('wv-capture-screenshot', async (_e: any, viewId: string, _rect?: any) => {
    try {
      const dataUrl = await bvm.screenshot(viewId);
      return { ok: true, dataUrl };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-exec-js', async (_e: any, viewId: string, code: string) => {
    try {
      const result = await bvm.execJs(viewId, code);
      return { ok: true, result };
    } catch (err) { return { ok: false, error: String(err) }; }
  });

  ipcMain.handle('wv-enable-context-capture', (_e: any, viewId: string) => {
    const code = `(function(){
      if(window.__anoclawCtxEnabled) return;
      window.__anoclawCtxEnabled=true;
      window.__anoclawCtxResult=null;
      function rm(){var o=document.getElementById('__anoclaw_ctx_overlay');if(o)o.remove();}
      function show(el,x,y){
        rm();
        var tag=el.tagName||'',id=el.id||'';
        var cls=(el.className&&typeof el.className==='string')?el.className.split(' ').slice(0,3).join('.'):'';
        var text=(el.textContent||'').substring(0,200),href=el.href||'',src=el.src||'';
        var label=tag+(id?'#'+id:'')+(cls?'.'+cls:'');
        var preview=text||href||src||'(empty)';
        if(preview.length>100)preview=preview.substring(0,100)+'…';
        var rect=el.getBoundingClientRect();
        var sz=Math.round(rect.width)+' × '+Math.round(rect.height);
        var overlay=document.createElement('div');
        overlay.id='__anoclaw_ctx_overlay';
        overlay.style.cssText='position:fixed;z-index:2147483647;background:#121212;border:1px solid rgba(255,255,255,0.16);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.6);padding:8px 0;min-width:240px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;color:#f4f4f6;';
        var html='<div style="padding:6px 12px;font-size:11px;color:#9c9c9d;word-break:break-all;border-bottom:1px solid rgba(255,255,255,0.06);">'+
          '<span style="color:#ffc533;font-weight:600;">'+label+'</span>'+
          '<span style="margin-left:8px;opacity:0.6;">'+sz+'</span><br>'+
          '<span style="opacity:0.5;font-size:10px;">'+preview.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</span></div>'+
          '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);">'+
            '<div class="__ac_act" data-action="add-info" style="padding:6px 14px;cursor:pointer;">📋 Add Element Info</div>'+
            '<div class="__ac_act" data-action="add-text" style="padding:6px 14px;cursor:pointer;">📝 Add Text Content</div>'+
            '<div class="__ac_act" data-action="add-html" style="padding:6px 14px;cursor:pointer;">🔧 Add Outer HTML</div></div>'+
          '<div style="padding:4px 0;">'+
            '<div class="__ac_act" data-action="screenshot" style="padding:6px 14px;cursor:pointer;">📸 Screenshot Page</div>'+
            '<div class="__ac_act" data-action="inspect" style="padding:6px 14px;cursor:pointer;">🔍 Highlight Element</div></div>';
        overlay.innerHTML=html;
        overlay.style.left=Math.min(x,window.innerWidth-260)+'px';
        overlay.style.top=Math.min(y,window.innerHeight-280)+'px';
        var ss=document.createElement('style');
        ss.textContent='.__ac_act:hover{background:rgba(255,255,255,0.06);}';
        overlay.appendChild(ss);
        document.body.appendChild(overlay);
        overlay.querySelectorAll('.__ac_act').forEach(function(item){
          item.addEventListener('click',function(e){
            e.stopPropagation();e.preventDefault();
            var action=item.getAttribute('data-action');
            window.__anoclawCtxResult=JSON.stringify({
              tag:tag,id:id,class:(typeof el.className==='string')?el.className:'',
              text:(el.textContent||'').substring(0,500),html:el.outerHTML?el.outerHTML.substring(0,1000):'',
              href:href,src:src,action:action,url:window.location.href,title:document.title
            });
            rm();
          });
        });
      }
      document.addEventListener('contextmenu',function(e){
        window.__anoclawCtxResult=null;rm();
        var el=e.target;
        window.__anoclawCtxPick={tag:el.tagName,id:el.id||'',class:(typeof el.className==='string')?el.className:'',text:(el.textContent||'').substring(0,300),href:el.href||'',src:el.src||'',x:e.clientX,y:e.clientY,ts:Date.now()};
        setTimeout(function(){show(el,e.clientX,e.clientY);},10);
      },true);
      document.addEventListener('click',function(e){if(!e.target.closest('#__anoclaw_ctx_overlay'))rm();},true);
      document.addEventListener('keydown',function(e){if(e.key==='Escape')rm();},true);
    })()`;
    bvm.execJs(viewId, code);
    return { ok: true };
  });

  // ── Lifecycle ──
  app.whenReady().then(async () => {
    try {
      await startServer();

      // Check if first-run setup is needed
      initSetup(BrowserWindow, ipcMain);
      if (needsSetup()) {
        await runSetupWizard();
        // Setup wizard saved agent config + settings — reload server to pick them up
        await shutdown();
        await startServer();
      }

      WindowManager.getInstance().createWindow();
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
  app.on('activate', () => {
    if (!WindowManager.getInstance().getMainWindow()) WindowManager.getInstance().createWindow();
  });
}
