/* Preload script — CommonJS, uses Electron's built-in require.
   In Electron preload context, require('electron') returns real API. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
  showOpenDialog: (opts) => ipcRenderer.invoke('dialog-open', opts),
  // Floating ball IPC
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onFloatingBallNewSession: (cb) => {
    ipcRenderer.on('floating-ball-new-session', () => cb());
  },
  onFloatingBallOpenSession: (cb) => {
    ipcRenderer.on('floating-ball-open-session', (_, idx) => cb(idx));
  },
  // File/link opening
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', title, body),
  // Setup wizard
  saveSetup: (data) => ipcRenderer.invoke('save-setup', data),
  setupDone: () => ipcRenderer.send('setup-done'),
  quitSetup: () => ipcRenderer.send('quit-setup'),
  // WebContentsView management
  wvCreate: (url) => ipcRenderer.invoke('wv-create', url),
  wvNavigate: (viewId, url) => ipcRenderer.invoke('wv-navigate', viewId, url),
  wvSetBounds: (viewId, x, y, w, h) => ipcRenderer.invoke('wv-set-bounds', viewId, x, y, w, h),
  wvDestroy: (viewId) => ipcRenderer.invoke('wv-destroy', viewId),
  wvGoBack: (viewId) => ipcRenderer.invoke('wv-go-back', viewId),
  wvGoForward: (viewId) => ipcRenderer.invoke('wv-go-forward', viewId),
  wvReload: (viewId) => ipcRenderer.invoke('wv-reload', viewId),
  wvDevTools: (viewId) => ipcRenderer.invoke('wv-dev-tools', viewId),
  wvCaptureScreenshot: (viewId, rect) => ipcRenderer.invoke('wv-capture-screenshot', viewId, rect),
  wvExecJs: (viewId, code) => ipcRenderer.invoke('wv-exec-js', viewId, code),
  wvEnableContextCapture: (viewId) => ipcRenderer.invoke('wv-enable-context-capture', viewId),
  // WebContentsView state change events (loading, title, favicon)
  onWvStateChange: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('wv-state-change', handler);
    return () => ipcRenderer.removeListener('wv-state-change', handler);
  },
});
