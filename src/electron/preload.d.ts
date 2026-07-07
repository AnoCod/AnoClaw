// preload.d.ts — Type declarations for window.electronAPI (exposed by preload.cjs).
// This is the source of truth for the preload contract. Every method on the
// contextBridge object must have a matching declaration here.
//
// Keep this in sync with preload.cjs. If you add/remove a method in preload.cjs,
// update the ElectronAPI interface below.

interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'treatPackageAsDirectory' | 'dontAddToRecent'>;
}

interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: Array<'showHiddenFiles' | 'createDirectory' | 'treatPackageAsDirectory' | 'showOverwriteConfirmation' | 'dontAddToRecent'>;
}

interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

interface WVStateChangeData {
  viewId: string;
  type: string;
  [key: string]: unknown;
}

interface WVCreateResult {
  viewId: string | null;
  error?: string;
}

interface AgentBrowserEvent {
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

interface ApiResult {
  ok: boolean;
  error?: string;
}

interface SetupData {
  agentName: string;
  model: string;
  apiUrl: string;
  apiKey: string;
  provider: string;
  contextWindow: number;
}

interface SetupResult {
  ok: boolean;
  error?: string;
}

interface CaptureScreenshotResult {
  ok: boolean;
  dataUrl?: string;
  error?: string;
}

interface ExecJsResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ElectronAPI {
  // ── Window controls ──
  windowMinimize: () => void;
  windowMinimizeAnimate: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;

  // ── Dialogs ──
  showOpenDialog: (opts: OpenDialogOptions) => Promise<OpenDialogResult>;
  showSaveDialog: (opts: SaveDialogOptions) => Promise<SaveDialogResult>;

  // ── App info ──
  getAppVersion: () => Promise<string>;
  getAutoStart: () => Promise<boolean>;
  setAutoStart: (enabled: boolean) => void;

  // ── Floating ball events (main -> renderer listeners) ──
  onFloatingBallNewSession: (cb: () => void) => void;
  onFloatingBallOpenSession: (cb: (idx: number) => void) => void;

  // ── File/link opening ──
  openExternal: (url: string) => Promise<ApiResult>;
  openPath: (filePath: string) => Promise<ApiResult>;

  // ── Desktop notifications ──
  showNotification: (title: string, body: string) => Promise<ApiResult>;

  // ── Setup wizard ──
  saveSetup: (data: SetupData) => Promise<SetupResult>;
  setupDone: () => void;
  quitSetup: () => void;

  // ── WebContentsView management ──
  wvCreate: (url: string) => Promise<WVCreateResult>;
  wvNavigate: (viewId: string, url: string) => Promise<ApiResult>;
  wvSetBounds: (viewId: string, x: number, y: number, w: number, h: number) => Promise<ApiResult>;
  wvDestroy: (viewId: string) => Promise<ApiResult>;
  wvGoBack: (viewId: string) => Promise<ApiResult>;
  wvGoForward: (viewId: string) => Promise<ApiResult>;
  wvReload: (viewId: string) => Promise<ApiResult>;
  wvDevTools: (viewId: string) => Promise<ApiResult>;
  wvCaptureScreenshot: (viewId: string, rect?: { x: number; y: number; width: number; height: number }) => Promise<CaptureScreenshotResult>;
  wvExecJs: (viewId: string, code: string) => Promise<ExecJsResult>;
  wvEnableContextCapture: (viewId: string) => Promise<ApiResult>;

  // ── WebContentsView state change events ──
  onWvStateChange: (cb: (data: WVStateChangeData) => void) => () => void;
  onAgentBrowserEvent: (cb: (data: AgentBrowserEvent) => void) => () => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
