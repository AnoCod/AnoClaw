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

interface WVCreateOptions {
  sessionId?: string;
  workspacePath?: string;
}

interface WVConsoleLog {
  level: string;
  message: string;
  line?: number;
  sourceId?: string;
  timestamp: number;
}

interface WVConsoleResult extends ApiResult {
  logs: WVConsoleLog[];
}

interface WVNetworkEvent {
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

interface WVNetworkResult extends ApiResult {
  events: WVNetworkEvent[];
}

interface WVSecurityEvent {
  viewId: string;
  id: string;
  kind: 'popup' | 'external' | 'permission' | 'certificate';
  decision: 'prompt' | 'allowed' | 'blocked' | 'redirected';
  message: string;
  url?: string;
  permission?: string;
  timestamp: number;
}

interface WVSecurityResult extends ApiResult {
  events: WVSecurityEvent[];
}

interface WVFindResult {
  viewId: string;
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
  selectionArea?: unknown;
}

interface WVFindRequestResult extends ApiResult {
  requestId: number;
}

interface WVViewportOptions {
  name: string;
  width?: number;
  height?: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
  userAgent?: string;
}

interface WVDownloadEvent {
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

type FloatingBallSessionOpenPayload = number | { sessionId?: string; index?: number | null };
type FloatingBallConnection = 'connected' | 'connecting' | 'disconnected';
type FloatingBallPhase = 'thinking' | 'tool' | 'waiting' | 'done' | 'failed' | 'idle' | 'goal' | 'paused';

interface FloatingBallSession {
  id: string;
  title: string;
  status?: string;
}

interface FloatingBallActivityItem {
  id: string;
  sessionId: string | null;
  title: string;
  detail?: string;
  status: 'completed' | 'failed';
  timestamp: number;
}

interface FloatingBallHelperNotice {
  kind: 'info' | 'success' | 'error';
  text: string;
  timestamp: number;
}

interface FloatingBallGoalPulse {
  sessionId: string | null;
  status: 'active' | 'paused' | 'blocked' | 'completed' | 'deleted';
  objective: string;
  runCount?: number;
  updatedAt?: string;
  lastRunAt?: string;
}

interface FloatingBallState {
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
    toolCallId?: string;
    canInlineResolve?: boolean;
  };
  goalPulse?: FloatingBallGoalPulse | null;
  currentTask?: {
    sessionId: string;
    title: string;
    phase: FloatingBallPhase;
    detail?: string;
  };
  clipboardText?: string;
}

interface FloatingBallCommand {
  action: string;
  data?: unknown;
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
  onFloatingBallOpenSession: (cb: (payload: FloatingBallSessionOpenPayload) => void) => void;
  onFloatingBallCommand: (cb: (payload: FloatingBallCommand) => void) => () => void;
  onFloatingBallStateChanged: (cb: (state: FloatingBallState) => void) => () => void;
  floatingBallAction: (action: string, data?: unknown) => void;
  floatingBallGetSessions: () => Promise<FloatingBallSession[]>;
  floatingBallGetState: () => Promise<FloatingBallState>;
  floatingBallUpdateState: (state: Partial<FloatingBallState>) => void;

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
  wvCreate: (url: string, options?: WVCreateOptions) => Promise<WVCreateResult>;
  wvSetMetadata: (viewId: string, options?: WVCreateOptions) => Promise<ApiResult>;
  wvNavigate: (viewId: string, url: string) => Promise<ApiResult>;
  wvSetBounds: (viewId: string, x: number, y: number, w: number, h: number) => Promise<ApiResult>;
  wvDestroy: (viewId: string) => Promise<ApiResult>;
  wvGoBack: (viewId: string) => Promise<ApiResult>;
  wvGoForward: (viewId: string) => Promise<ApiResult>;
  wvReload: (viewId: string) => Promise<ApiResult>;
  wvSetZoom: (viewId: string, zoomFactor: number) => Promise<ApiResult>;
  wvSetViewport: (viewId: string, viewport: WVViewportOptions) => Promise<ApiResult>;
  wvDevTools: (viewId: string) => Promise<ApiResult>;
  wvCaptureScreenshot: (viewId: string, rect?: { x: number; y: number; width: number; height: number }) => Promise<CaptureScreenshotResult>;
  wvExecJs: (viewId: string, code: string) => Promise<ExecJsResult>;
  wvGetConsole: (viewId: string, limit?: number) => Promise<WVConsoleResult>;
  wvGetNetwork: (viewId: string, limit?: number) => Promise<WVNetworkResult>;
  wvGetSecurity: (viewId: string, limit?: number) => Promise<WVSecurityResult>;
  wvFindInPage: (viewId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => Promise<WVFindRequestResult>;
  wvStopFind: (viewId: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => Promise<ApiResult>;
  wvResolvePermission: (eventId: string, allowed: boolean) => Promise<ApiResult>;
  wvEnableContextCapture: (viewId: string) => Promise<ApiResult>;

  // ── WebContentsView state change events ──
  onWvStateChange: (cb: (data: WVStateChangeData) => void) => () => void;
  onWvDownload: (cb: (data: WVDownloadEvent) => void) => () => void;
  onWvNetwork: (cb: (data: WVNetworkEvent) => void) => () => void;
  onWvSecurity: (cb: (data: WVSecurityEvent) => void) => () => void;
  onWvFindResult: (cb: (data: WVFindResult) => void) => () => void;
  onAgentBrowserEvent: (cb: (data: AgentBrowserEvent) => void) => () => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
