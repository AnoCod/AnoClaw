// Global type augmentations for the Electron main process.
// Frontend code should use preload.d.ts for the electronAPI interface.
export {};

declare global {
  var _quitting: boolean | undefined;

  // Re-export ElectronAPI so frontend TypeScript can reference it
  interface ElectronAPI {
    windowMinimize: () => void;
    windowMinimizeAnimate: () => void;
    windowMaximize: () => void;
    windowClose: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
    showOpenDialog: (opts: Record<string, unknown>) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog: (opts: Record<string, unknown>) => Promise<{ canceled: boolean; filePath?: string }>;
    getAppVersion: () => Promise<string>;
    getAutoStart: () => Promise<boolean>;
    setAutoStart: (enabled: boolean) => void;
    onFloatingBallNewSession: (cb: () => void) => void;
    onFloatingBallOpenSession: (cb: (idx: number) => void) => void;
    floatingBallAction: (action: string, data?: unknown) => void;
    floatingBallGetSessions: () => Promise<Array<{ id: string; title: string }>>;
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
    openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
    showNotification: (title: string, body: string) => Promise<{ ok: boolean; error?: string }>;
    saveSetup: (data: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    setupDone: () => void;
    quitSetup: () => void;
    wvCreate: (url: string) => Promise<{ viewId: string | null; error?: string }>;
    wvNavigate: (viewId: string, url: string) => Promise<{ ok: boolean; error?: string }>;
    wvSetBounds: (viewId: string, x: number, y: number, w: number, h: number) => Promise<{ ok: boolean }>;
    wvDestroy: (viewId: string) => Promise<{ ok: boolean }>;
    wvGoBack: (viewId: string) => Promise<{ ok: boolean }>;
    wvGoForward: (viewId: string) => Promise<{ ok: boolean }>;
    wvReload: (viewId: string) => Promise<{ ok: boolean }>;
    wvDevTools: (viewId: string) => Promise<{ ok: boolean }>;
    wvCaptureScreenshot: (viewId: string, rect?: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
    wvExecJs: (viewId: string, code: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
    wvEnableContextCapture: (viewId: string) => Promise<{ ok: boolean }>;
    onWvStateChange: (cb: (data: { viewId: string; type: string; [key: string]: unknown }) => void) => () => void;
    onAgentBrowserEvent: (cb: (data: { sessionId: string; viewId: string; action: string; phase: 'start' | 'done' | 'error'; [key: string]: unknown }) => void) => () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
