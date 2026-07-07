/* Preload script — CommonJS, uses Electron's built-in require.
   In Electron preload context, require('electron') returns real API.

   SECURITY: Only whitelisted IPC channels are exposed. There is no generic
   send/invoke passthrough. Every function maps to exactly one IPC channel. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Window controls ──
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMinimizeAnimate: () => ipcRenderer.send('window-minimize-animate'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (cb) => {
    const handler = (_, v) => cb(v);
    ipcRenderer.on('maximize-change', handler);
    return () => ipcRenderer.removeListener('maximize-change', handler);
  },

  // ── Dialogs ──
  showOpenDialog: (opts) => ipcRenderer.invoke('dialog-open', opts),
  showSaveDialog: (opts) => ipcRenderer.invoke('dialog-save', opts),

  // ── App info ──
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAutoStart: () => ipcRenderer.invoke('get-autostart'),
  setAutoStart: (enabled) => ipcRenderer.send('set-autostart', enabled),

  // ── Floating ball IPC ──
  onFloatingBallNewSession: (cb) => {
    ipcRenderer.on('floating-ball-new-session', () => cb());
  },
  onFloatingBallOpenSession: (cb) => {
    ipcRenderer.on('floating-ball-open-session', (_, idx) => cb(idx));
  },
  // Floating ball action (renderer -> main, via send)
  floatingBallAction: (action, data) => ipcRenderer.send('floating-ball-action', action, data),
  floatingBallGetSessions: () => ipcRenderer.invoke('floating-ball-sessions'),

  // ── File/link opening ──
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),

  // ── Desktop notifications ──
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body),

  // ── Setup wizard ──
  saveSetup: (data) => ipcRenderer.invoke('save-setup', data),
  setupDone: () => ipcRenderer.send('setup-done'),
  quitSetup: () => ipcRenderer.send('quit-setup'),

  // ── WebContentsView management ──
  wvCreate: (url, options) => ipcRenderer.invoke('wv-create', url, options),
  wvSetMetadata: (viewId, options) => ipcRenderer.invoke('wv-set-metadata', viewId, options),
  wvNavigate: (viewId, url) => ipcRenderer.invoke('wv-navigate', viewId, url),
  wvSetBounds: (viewId, x, y, w, h) => ipcRenderer.invoke('wv-set-bounds', viewId, x, y, w, h),
  wvDestroy: (viewId) => ipcRenderer.invoke('wv-destroy', viewId),
  wvGoBack: (viewId) => ipcRenderer.invoke('wv-go-back', viewId),
  wvGoForward: (viewId) => ipcRenderer.invoke('wv-go-forward', viewId),
  wvReload: (viewId) => ipcRenderer.invoke('wv-reload', viewId),
  wvSetZoom: (viewId, zoomFactor) => ipcRenderer.invoke('wv-set-zoom', viewId, zoomFactor),
  wvSetViewport: (viewId, viewport) => ipcRenderer.invoke('wv-set-viewport', viewId, viewport),
  wvDevTools: (viewId) => ipcRenderer.invoke('wv-dev-tools', viewId),
  wvCaptureScreenshot: (viewId, rect) => ipcRenderer.invoke('wv-capture-screenshot', viewId, rect),
  wvExecJs: (viewId, code) => ipcRenderer.invoke('wv-exec-js', viewId, code),
  wvGetConsole: (viewId, limit) => ipcRenderer.invoke('wv-get-console', viewId, limit),
  wvGetNetwork: (viewId, limit) => ipcRenderer.invoke('wv-get-network', viewId, limit),
  wvGetSecurity: (viewId, limit) => ipcRenderer.invoke('wv-get-security', viewId, limit),
  wvFindInPage: (viewId, text, options) => ipcRenderer.invoke('wv-find-in-page', viewId, text, options),
  wvStopFind: (viewId, action) => ipcRenderer.invoke('wv-stop-find', viewId, action),
  wvResolvePermission: (eventId, allowed) => ipcRenderer.invoke('wv-resolve-permission', eventId, allowed),
  wvEnableContextCapture: (viewId) => ipcRenderer.invoke('wv-enable-context-capture', viewId),

  // ── WebContentsView state change events ──
  onWvStateChange: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('wv-state-change', handler);
    return () => ipcRenderer.removeListener('wv-state-change', handler);
  },

  onWvDownload: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('wv-download', handler);
    return () => ipcRenderer.removeListener('wv-download', handler);
  },

  onWvNetwork: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('wv-network', handler);
    return () => ipcRenderer.removeListener('wv-network', handler);
  },

  onWvSecurity: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('wv-security', handler);
    return () => ipcRenderer.removeListener('wv-security', handler);
  },

  onWvFindResult: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('wv-find-result', handler);
    return () => ipcRenderer.removeListener('wv-find-result', handler);
  },

  onAgentBrowserEvent: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('agent-browser-event', handler);
    return () => ipcRenderer.removeListener('agent-browser-event', handler);
  },
});
