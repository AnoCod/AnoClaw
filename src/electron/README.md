# src/electron — Electron Main Process

## Overview

Windows desktop shell: single-instance lock, frameless main window, system tray, floating ball (minimize animation), WebContentsView management (browser tabs with CDP port 9222), first-run setup wizard, and a contextBridge preload script exposing 34 IPC channels to the renderer.

## Entry Point

### bridge.js

The true Electron entry point (`"main"` in `package.json`).

- Sets GPU flags: `disable-gpu-vsync`, `enable-gpu-rasterization`, `use-angle=direct-composition`
- Enables remote debugging: `--remote-debugging-port=9222`
- **Single-instance lock:** `app.requestSingleInstanceLock()`; second instance focuses existing window
- Dynamically imports `main.js` → `createApp(electron)`

---

## Core Managers

### main.ts — App Lifecycle

```ts
export async function createApp(electron: typeof Electron): Promise<void>;
```

**Initialization order:**
1. Initialize `WindowManager`, `TrayManager`, `FloatingBallManager` with Electron constructors
2. Wire all IPC handlers (window control, dialog, file opening, notifications, WebContentsView, app info)
3. `app.whenReady()` → start HTTP server → check `needsSetup()` → run wizard if needed → create main window → create tray → set application menu

**IPC handlers registered in main.ts:**

| Channel | Direction | Description |
|---------|-----------|-------------|
| `window-minimize` | on | Hide window, show floating ball |
| `window-minimize-animate` | on | Shrink to 56×56 then show ball (250ms, 10 steps) |
| `window-maximize` | on | Toggle maximize/unmaximize |
| `window-close` | on | Set `_quitting`, hide ball, quit |
| `window-is-maximized` | handle | Returns boolean |
| `dialog-open` | handle | Native file open dialog |
| `dialog-save` | handle | Native file save dialog |
| `get-app-version` | handle | `app.getVersion()` |
| `get-autostart` | handle | Login-item setting |
| `set-autostart` | on | Set login-item |
| `open-external` | handle | `shell.openExternal()` (http/https only) |
| `open-path` | handle | `shell.openPath()` |
| `show-notification` | handle | Native Notification with click-to-focus |
| `wv-*` (11 channels) | handle | Delegated to BrowserViewManager |

**Close behavior:** `×` quits the app, `─` minimizes to floating ball (handled by frontend title bar calling `window-minimize-animate`).

---

### WindowManager (Singleton)

```ts
class WindowManager {
  static getInstance(): WindowManager;
  init(BrowserWindow: typeof Electron.BrowserWindow): void;
  createWindow(sessionId?: string): BrowserWindow;
  getMainWindow(): BrowserWindow | null;
  getAllWindows(): BrowserWindow[];
}
```

**Window config:** `titleBarStyle: 'hidden'`, `icon: build/icon.ico`, `backgroundColor: '#0a0a0a'`, `enableLargerThanScreen: true`, `backgroundThrottling: false`, min 800×600.

**State persistence:** saves position/size/maximized to `userData/window-state.json`, restores on next launch. Debounced at 500ms.

**Preload:** `src/electron/preload.cjs` via `contextBridge`.

---

### TrayManager (Singleton)

```ts
class TrayManager {
  static getInstance(): TrayManager;
  init(Tray, Menu, app, nativeImage): void;
  createTray(): void;
}
```

System tray icon from `build/icon.ico` (16×16). Context menu: "Open AnoClaw", "New Session Window", separator, "Quit". Tray click shows main window.

---

### FloatingBallManager (Singleton)

Transparent 400×400 frameless always-on-top window shown when main window is minimized.

```ts
class FloatingBallManager {
  static getInstance(): FloatingBallManager;
  init(BrowserWindow, ipcMain): void;
  setSessionProvider(fn: () => Promise<SessionInfo[]>): void;

  show(): void;
  hide(): void;
  destroy(): void;
  animateMinimize(mainWin: BrowserWindow): void;  // Shrinks 10-step ease-in over 250ms
  isVisible: boolean;
}
```

**Ball window:** 400×400, transparent, frameless, always-on-top, skip taskbar, `backgroundColor: '#00000000'`. Loads `http://localhost:3456/floating-ball/index.html`.

**IPC:** Handles `floating-ball-action` (new/open session) and `floating-ball-sessions` (session list).

---

### BrowserViewManager (Singleton)

```ts
class BrowserViewManager {
  static getInstance(): BrowserViewManager;

  create(url: string): string;                    // Returns viewId
  destroy(viewId: string): boolean;
  get(viewId: string): WebContentsView | null;

  // Positioning
  setBounds(viewId: string, x: number, y: number, w: number, h: number): void;

  // Navigation
  navigate(viewId: string, url: string): void;
  reload(viewId: string): void;
  goBack(viewId: string): void;
  goForward(viewId: string): void;

  // Inspection & capture
  devTools(viewId: string): void;
  screenshot(viewId: string): Promise<string>;    // Returns data URL
  execJs(viewId: string, code: string): Promise<any>;

  // State query
  getUrl(viewId: string): string;
  getTitle(viewId: string): string;
  allIds(): string[];
  allEntries(): Array<{ id: string; url: string; title: string }>;
  count(): number;

  // Async helpers
  waitForLoad(viewId: string, timeoutMs?: number): Promise<void>;
  waitForSelector(viewId: string, selector: string, timeoutMs?: number): Promise<boolean>;
}
```

**CDP port:** 9222 (set via `--remote-debugging-port` in bridge.js).

**Event forwarding:** Forwards 6 webContents events (`did-start-loading`, `did-stop-loading`, `did-finish-load`, `did-fail-load`, `page-title-updated`, `page-favicon-updated`) to the renderer via `wv-state-change` IPC events.

---

### SetupWizard

First-run LLM configuration modal.

```ts
function init(BrowserWindow, ipcMain): void;
function needsSetup(): boolean;
function runSetupWizard(): Promise<void>;
```

**Checks:** `config/settings.yaml` missing apiKey, or `data/agents/ceo.json` does not exist.

**Wizard window:** 520×680, frameless, modal until completed. Fields: agent name, model, API URL, API key, context window. Tests connection via fetch before saving.

**IPC:** `save-setup` (writes config + encrypts API key), `setup-done` (close + resolve), `quit-setup` (close + app.quit()).

---

### preload.cjs — contextBridge API

Exposes `window.electronAPI` to renderer:

```ts
interface ElectronAPI {
  // Window control
  windowMinimize(): void;
  windowMinimizeAnimate(): void;
  windowMaximize(): void;
  windowClose(): void;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;

  // Dialogs
  showOpenDialog(opts?: any): Promise<any>;
  showSaveDialog(opts?: any): Promise<any>;

  // App info
  getAppVersion(): Promise<string>;
  getAutoStart(): Promise<boolean>;
  setAutoStart(enabled: boolean): void;

  // File/external opening
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<string>;

  // Notifications
  showNotification(title: string, body: string): Promise<void>;

  // Setup wizard
  saveSetup(data: SetupData): Promise<any>;
  setupDone(): void;
  quitSetup(): void;

  // Floating ball events
  onFloatingBallNewSession(cb: () => void): () => void;
  onFloatingBallOpenSession(cb: (index: number) => void): () => void;

  // WebContentsView management (11 channels)
  wvCreate(url: string): Promise<{ viewId: string }>;
  wvNavigate(viewId: string, url: string): Promise<void>;
  wvSetBounds(viewId: string, x: number, y: number, w: number, h: number): Promise<void>;
  wvDestroy(viewId: string): Promise<void>;
  wvGoBack(viewId: string): Promise<void>;
  wvGoForward(viewId: string): Promise<void>;
  wvReload(viewId: string): Promise<void>;
  wvDevTools(viewId: string): Promise<void>;
  wvCaptureScreenshot(viewId: string, rect?: any): Promise<string>;
  wvExecJs(viewId: string, code: string): Promise<any>;
  wvEnableContextCapture(viewId: string): Promise<void>;
  onWvStateChange(cb: (state: WvState) => void): () => void;

  // Generic IPC passthrough
  send(channel: string, ...args: any[]): void;
  invoke(channel: string, ...args: any[]): Promise<any>;
}
```

All `wv-*` channels delegate to `BrowserViewManager`. Cleanup functions returned for all event listeners.

---

### Supporting Files

| File | Description |
|------|-------------|
| `AutoStart.ts` | `getAutoStart(app)` / `setAutoStart(app, enabled)` — login-item wrapper |
| `global.d.ts` | Ambient declaration for `globalThis._quitting` flag |
| `setup-wizard.html` | Self-contained setup wizard UI (embedded CSS + JS, no build step) |

---

## Dependencies

```
bridge.js     → main.js (dynamic import), electron
main.ts       → WindowManager, TrayManager, FloatingBallManager,
                BrowserViewManager, AutoStart, SetupWizard,
                ../server/main (startServer/shutdown)
All managers  → electron (BrowserWindow, Tray, Menu, app, etc.)
preload.cjs   → electron (contextBridge, ipcRenderer)
```

No external npm dependencies beyond `electron`. All Node.js APIs used: `fs`, `path`, `child_process`.

## Usage

The Electron shell is started by the packaged `AnoClaw.exe` (or `electron .` in development). `bridge.js` is the configured `"main"` entry point. The renderer accesses native capabilities exclusively through `window.electronAPI` exposed by `preload.cjs`.
