// Global type augmentations for the Electron main process.
// Frontend code should use preload.d.ts for the electronAPI interface.
export {};

type FloatingBallConnection = 'connected' | 'connecting' | 'disconnected';
type FloatingBallPhase = 'thinking' | 'tool' | 'waiting' | 'done' | 'failed' | 'idle' | 'goal' | 'paused';
type FloatingBallSession = { id: string; title: string; status?: string };
type FloatingBallActivityItem = {
  id: string;
  sessionId: string | null;
  title: string;
  detail?: string;
  status: 'completed' | 'failed';
  timestamp: number;
};
type FloatingBallHelperNotice = {
  kind: 'info' | 'success' | 'error';
  text: string;
  timestamp: number;
};
type FloatingBallGoalPulse = {
  sessionId: string | null;
  status: 'active' | 'paused' | 'blocked' | 'completed' | 'deleted';
  objective: string;
  runCount?: number;
  updatedAt?: string;
  lastRunAt?: string;
};
type FloatingBallState = {
  activeSessionId: string | null;
  activeTitle: string | null;
  connection: FloatingBallConnection;
  runningCount: number;
  waitingCount: number;
  recentSessions: FloatingBallSession[];
  activityItems?: FloatingBallActivityItem[];
  helperNotice?: FloatingBallHelperNotice | null;
  waitingInbox?: {
    count: number;
    sessionId: string | null;
    title: string;
    detail?: string;
    riskLevel?: string;
  };
  goalPulse?: FloatingBallGoalPulse | null;
  currentTask?: {
    sessionId: string;
    title: string;
    phase: FloatingBallPhase;
    detail?: string;
  };
  clipboardText?: string;
};
type FloatingBallCommand = { action: string; data?: unknown };

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
    onFloatingBallOpenSession: (cb: (payload: number | { sessionId?: string; index?: number | null }) => void) => void;
    onFloatingBallCommand: (cb: (payload: FloatingBallCommand) => void) => () => void;
    onFloatingBallStateChanged: (cb: (state: FloatingBallState) => void) => () => void;
    floatingBallAction: (action: string, data?: unknown) => void;
    floatingBallGetSessions: () => Promise<FloatingBallSession[]>;
    floatingBallGetState: () => Promise<FloatingBallState>;
    floatingBallUpdateState: (state: Partial<FloatingBallState>) => void;
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
    openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
    showNotification: (title: string, body: string) => Promise<{ ok: boolean; error?: string }>;
    saveSetup: (data: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    setupDone: () => void;
    quitSetup: () => void;
    wvCreate: (url: string, options?: { sessionId?: string; workspacePath?: string }) => Promise<{ viewId: string | null; error?: string }>;
    wvSetMetadata: (viewId: string, options?: { sessionId?: string; workspacePath?: string }) => Promise<{ ok: boolean; error?: string }>;
    wvNavigate: (viewId: string, url: string) => Promise<{ ok: boolean; error?: string }>;
    wvSetBounds: (viewId: string, x: number, y: number, w: number, h: number) => Promise<{ ok: boolean }>;
    wvDestroy: (viewId: string) => Promise<{ ok: boolean }>;
    wvGoBack: (viewId: string) => Promise<{ ok: boolean }>;
    wvGoForward: (viewId: string) => Promise<{ ok: boolean }>;
    wvReload: (viewId: string) => Promise<{ ok: boolean }>;
    wvSetZoom: (viewId: string, zoomFactor: number) => Promise<{ ok: boolean; error?: string }>;
    wvSetViewport: (viewId: string, viewport: { name: string; width?: number; height?: number; mobile?: boolean; deviceScaleFactor?: number; userAgent?: string }) => Promise<{ ok: boolean; error?: string }>;
    wvDevTools: (viewId: string) => Promise<{ ok: boolean }>;
    wvCaptureScreenshot: (viewId: string, rect?: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
    wvExecJs: (viewId: string, code: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
    wvGetConsole: (viewId: string, limit?: number) => Promise<{ ok: boolean; logs: Array<{ level: string; message: string; line?: number; sourceId?: string; timestamp: number }>; error?: string }>;
    wvGetNetwork: (viewId: string, limit?: number) => Promise<{ ok: boolean; events: Array<{ viewId: string; id: string; state: string; url: string; method: string; resourceType: string; statusCode?: number; fromCache?: boolean; error?: string; timestamp: number; durationMs?: number }>; error?: string }>;
    wvGetSecurity: (viewId: string, limit?: number) => Promise<{ ok: boolean; events: Array<{ viewId: string; id: string; kind: string; decision: string; message: string; url?: string; permission?: string; timestamp: number }>; error?: string }>;
    wvFindInPage: (viewId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => Promise<{ ok: boolean; requestId: number; error?: string }>;
    wvStopFind: (viewId: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => Promise<{ ok: boolean; error?: string }>;
    wvResolvePermission: (eventId: string, allowed: boolean) => Promise<{ ok: boolean; error?: string }>;
    wvEnableContextCapture: (viewId: string) => Promise<{ ok: boolean }>;
    onWvStateChange: (cb: (data: { viewId: string; type: string; [key: string]: unknown }) => void) => () => void;
    onWvDownload: (cb: (data: { viewId: string; id: string; state: string; filename: string; url: string; savePath: string; relativePath: string; receivedBytes: number; totalBytes: number; timestamp: number }) => void) => () => void;
    onWvNetwork: (cb: (data: { viewId: string; id: string; state: string; url: string; method: string; resourceType: string; statusCode?: number; fromCache?: boolean; error?: string; timestamp: number; durationMs?: number }) => void) => () => void;
    onWvSecurity: (cb: (data: { viewId: string; id: string; kind: string; decision: string; message: string; url?: string; permission?: string; timestamp: number }) => void) => () => void;
    onWvFindResult: (cb: (data: { viewId: string; requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean; selectionArea?: unknown }) => void) => () => void;
    onAgentBrowserEvent: (cb: (data: { sessionId: string; viewId: string; action: string; phase: 'start' | 'done' | 'error'; [key: string]: unknown }) => void) => () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
