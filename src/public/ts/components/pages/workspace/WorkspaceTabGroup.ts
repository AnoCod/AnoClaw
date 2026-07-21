// WorkspaceTabGroup.ts — Tab group for Workspace page.
// Code, image, PDF, markdown via local handling. Browser tabs via Electron WebContentsView.

import { ToastManager } from '../../../ToastManager.js';
import {
  hasExternalContentChange,
  workspaceModelUri,
  workspaceReadOnlyReason,
} from './WorkspaceIdeUtils.js';

const LANG_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  ts:'typescript',tsx:'typescript',mts:'typescript',cts:'typescript',
  js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',es6:'javascript',
  // Web
  json:'json',jsonc:'json',json5:'json',css:'css',scss:'scss',less:'less',sass:'sass',
  html:'html',htm:'html',xhtml:'html',xml:'xml',xsl:'xml',xslt:'xml',wsdl:'xml',svg:'xml',
  // Config / Data
  yaml:'yaml',yml:'yaml',toml:'ini',ini:'ini',cfg:'ini',conf:'ini',config:'ini',
  properties:'ini',prop:'ini',env:'ini',dotenv:'ini',editorconfig:'ini',
  rc:'ini',rcfile:'ini',npmrc:'ini',yarnrc:'ini',babelrc:'json',eslintrc:'json',
  prettierrc:'json',stylelintrc:'json',
  // Shell / Script
  sh:'shell',bash:'shell',zsh:'shell',fish:'shell',ksh:'shell',csh:'shell',
  bat:'bat',cmd:'bat',ps1:'powershell',psm1:'powershell',psd1:'powershell',
  // Markdown / Doc
  md:'markdown',mdx:'markdown',markdown:'markdown',rst:'markdown',adoc:'markdown',asciidoc:'markdown',
  org:'markdown',tex:'latex',latex:'latex',bib:'bibtex',
  // Python
  py:'python',pyw:'python',pyx:'python',pxd:'python',pxi:'python',ipynb:'json',
  // JVM
  java:'java',kt:'kotlin',kts:'kotlin',groovy:'groovy',gvy:'groovy',scala:'scala',sc:'scala',
  clj:'clojure',cljs:'clojure',cljc:'clojure',edn:'clojure',
  // C-family
  c:'c',h:'c',cpp:'cpp',cxx:'cpp',cc:'cpp','c++':'cpp',hpp:'cpp',hxx:'cpp',hh:'cpp',
  cs:'csharp',csx:'csharp',
  // Rust / Go / Swift
  rs:'rust',go:'go',swift:'swift',
  // Ruby / Crystal / Elixir / Erlang
  rb:'ruby',rake:'ruby',gemspec:'ruby',cr:'crystal',ex:'elixir',exs:'elixir',erl:'erlang',hrl:'erlang',
  // PHP / Perl / Lua / R
  php:'php',phtml:'php',php3:'php',php4:'php',php5:'php',
  pl:'perl',pm:'perl',t:'perl',pod:'perl',
  lua:'lua',r:'r',R:'r',rmd:'markdown',qmd:'markdown',
  // Haskell / OCaml / F# / Reason / PureScript
  hs:'haskell',lhs:'haskell',ml:'ocaml',mli:'ocaml',fs:'fsharp',fsx:'fsharp',fsi:'fsharp',
  re:'reason',rei:'reason',res:'reason',resi:'reason',purs:'purescript',
  // Dart / SQL / GraphQL
  dart:'dart',sql:'sql',psql:'sql',mysql:'sql',graphql:'graphql',gql:'graphql',
  // IaC / DevOps
  tf:'hcl',tfvars:'hcl',hcl:'hcl',nomad:'hcl',packer:'hcl',vagrant:'ruby',
  nix:'nix',dhall:'dhall',
  dockerfile:'dockerfile',Dockerfile:'dockerfile',Containerfile:'dockerfile',
  makefile:'makefile',Makefile:'makefile',GNUmakefile:'makefile',cmake:'cmake',CMakeLists:'cmake',
  Jenkinsfile:'groovy',gradle:'groovy',
  // Nginx / Apache / Caddy / HAProxy
  nginx:'nginx',confd:'nginx',vhost:'nginx',sites:'nginx',
  htaccess:'apacheconf',apache:'apacheconf',Caddyfile:'caddy',
  haproxy:'haproxy',cfg_haproxy:'haproxy',
  // VCL / Squid
  vcl:'vcl',squid:'squid',
  // Systemd / Desktop
  service:'ini',socket:'ini',timer:'ini',mount:'ini',automount:'ini',
  target:'ini',path_unit:'ini',slice:'ini',device:'ini',desktop:'ini',
  // Misc
  diff:'diff',patch:'diff',log:'log',csv:'csv',tsv:'csv',
  vtt:'plaintext',srt:'plaintext',sub:'plaintext',ass:'plaintext',ssa:'plaintext',
  proto:'proto',thrift:'thrift',avsc:'json',prisma:'prisma',
  vue:'html',svelte:'html',astro:'html',mjml:'html',ejs:'html',pug:'pug',jade:'pug',hbs:'handlebars',handlebars:'handlebars',mustache:'handlebars',
  blade:'html',twig:'html',jinja:'jinja',jinja2:'jinja',njk:'nunjucks',liquid:'liquid',
  haml:'haml',slim:'slim',
  // Embedded
  ino:'cpp',pde:'java',
  // Misc text
  txt:'plaintext',text:'plaintext',readme:'markdown',license:'plaintext',changelog:'markdown',contributing:'markdown',
  lock:'plaintext',toml_lock:'ini',
};

// Files matched by full name (no extension or special names)
const NAME_LANG_MAP: Record<string, string> = {
  'makefile':'makefile','gnumakefile':'makefile','dockerfile':'dockerfile','containerfile':'dockerfile',
  'jenkinsfile':'groovy','cmakelists.txt':'cmake','caddyfile':'caddy',
  'gradlew':'shell','mvnw':'shell','pom.xml':'xml','build.gradle':'groovy','build.gradle.kts':'kotlin',
  'settings.gradle':'groovy','settings.gradle.kts':'kotlin',
  'go.mod':'plaintext','go.sum':'plaintext','cargo.toml':'toml','pyproject.toml':'toml',
  'package.json':'json','tsconfig.json':'jsonc','jsconfig.json':'jsonc',
  '.gitignore':'ignore','.gitattributes':'ignore','.gitmodules':'ini',
  '.dockerignore':'ignore','.npmignore':'ignore','.eslintignore':'ignore','.prettierignore':'ignore',
  '.editorconfig':'ini','.env':'ini','.env.local':'ini','.env.example':'ini',
  '.babelrc':'json','.browserslistrc':'ini','.stylelintrc':'json','.eslintrc':'json',
  '.prettierrc':'json','.npmrc':'ini','.yarnrc':'ini',
  '.bashrc':'shell','.bash_profile':'shell','.zshrc':'shell','.profile':'shell','.zprofile':'shell',
  '.vimrc':'viml','.viminfo':'viml','.ideavimrc':'viml',
  'nginx.conf':'nginx','.htaccess':'apacheconf',
  'robots.txt':'plaintext','humans.txt':'plaintext','manifest.json':'json','manifest.webapp':'json',
};

const IMG_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','bmp','ico','tiff','tif','avif','heic','heif','jfif','pjpeg','pjp','apng','jxl','jpe']);
const AUDIO_EXTS = new Set(['mp3','wav','ogg','oga','m4a','aac','flac','opus']);
const VIDEO_EXTS = new Set(['mp4','webm','ogv','mov','m4v']);
const OFFICE_EXTS = new Set(['docx','xlsx','pptx','xls','xlsm','ppt','pptm','odt','ods','odp']);
const TABLE_EXTS = new Set(['csv','tsv']);
type FileType = 'code'|'image'|'audio'|'video'|'pdf'|'markdown'|'csv'|'binary'|'browser'|'docx'|'xlsx'|'pptx';
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
interface BrowserStateEvent {
  viewId: string;
  type: string;
  url?: string;
  title?: string;
  favicons?: string[];
  favicon?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
  zoomFactor?: number;
  consoleLog?: BrowserConsoleLog;
}

interface BrowserDownloadEvent {
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

interface BrowserConsoleLog {
  level: string;
  message: string;
  line?: number;
  sourceId?: string;
  timestamp: number;
}

interface BrowserNetworkEvent {
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

interface BrowserSecurityEvent {
  viewId: string;
  id: string;
  kind: 'popup' | 'external' | 'permission' | 'certificate';
  decision: 'prompt' | 'allowed' | 'blocked' | 'redirected';
  message: string;
  url?: string;
  permission?: string;
  timestamp: number;
}

interface BrowserFindResult {
  viewId: string;
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

interface BrowserViewportPreset {
  name: string;
  label: string;
  width?: number;
  height?: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
  userAgent?: string;
}

type BrowserPanelMode = 'network' | 'console' | 'security';

interface PersistedBrowserTab {
  url: string;
  title?: string;
  favicon?: string;
  zoomFactor?: number;
  recentUrls?: string[];
  viewportName?: string;
}

interface PersistedBrowserState {
  version: 1;
  sessionId: string;
  workspacePath: string;
  activeIndex: number;
  tabs: PersistedBrowserTab[];
  savedAt: number;
}

/**
 * Check if file content is binary (not human-readable text).
 *
 * Strategy: read the first 2000 characters. If the sample contains null bytes
 * or more than 15% non-printable characters (excluding tab/newline/carriage-return),
 * treat it as binary. Replacement characters (U+FFFD) are penalized 2x because
 * they indicate the text decoder encountered byte sequences it couldn't interpret.
 *
 * @param content - Raw file content decoded as UTF-8.
 * @returns true if the content is binary (no usable text), false if it's readable.
 */
function _isBinaryContent(content: string): boolean {
  if (!content || content.length === 0) return false;
  const sample = content.substring(0, 2000);
  // Null bytes always mean binary
  if (sample.includes('\x00')) return true;
  // Count non-printable chars (excluding common whitespace)
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) nonPrintable++;
    if (c === 65533) nonPrintable += 2; // replacement char (U+FFFD) — heavy penalty
  }
  return nonPrintable > sample.length * 0.15; // >15% garbage → binary
}

/**
 * Detect programming language from filename and content heuristics.
 *
 * Detection runs in 5 stages, returning on the first match:
 * 1. **Extension match** — `LANG_MAP` lookup (80+ extensions → Monaco language ID).
 * 2. **Full filename match** — `NAME_LANG_MAP` lookup (30+ special names like Makefile, .gitignore).
 * 3. **Double extension** — e.g. `.d.ts` → TypeScript, `.test.js` → JavaScript.
 * 4. **Content-based heuristics** (uppercase in priority order):
 *    - Shebang line: `#!/usr/bin/env python3` etc.
 *    - XML/HTML/SVG doctype declarations.
 *    - JSON: starts with `{` or `[` and parses as valid JSON.
 *    - INI: ≥60% of non-comment lines are `key=value` pairs or `[sections]`.
 *    - CSV: ≥70% of lines contain commas or tabs.
 *    - Log: lines start with ISO-8601 timestamps.
 *    - C/C++: contains `#include`, `#define`, or `#ifndef`.
 * 5. **Fallback** — returns `'plaintext'` (Monaco renders with no syntax highlighting).
 *
 * @param name - File name (may include path segments, e.g. "src/foo/test.d.ts").
 * @param content - First chunk of file content (up to server read limit, ~100KB).
 * @returns Monaco language ID string (e.g. 'typescript', 'python', 'ini', 'plaintext').
 */
function _detectLanguage(name: string, content: string): string {
  const nameLower = name.toLowerCase();
  const ext = nameLower.split('.').pop() || '';

  // 1. Extension match
  if (LANG_MAP[ext]) return LANG_MAP[ext];

  // 2. Full filename match (case-insensitive, then exact)
  if (NAME_LANG_MAP[nameLower]) return NAME_LANG_MAP[nameLower];
  if (NAME_LANG_MAP[name]) return NAME_LANG_MAP[name];

  // 3. Double extension (e.g. .d.ts → typescript, .test.ts → typescript)
  const parts = nameLower.split('.');
  if (parts.length > 2) {
    for (let i = parts.length - 2; i > 0; i--) {
      const subExt = parts.slice(i).join('.');
      if (LANG_MAP[subExt]) return LANG_MAP[subExt];
    }
  }

  // 4. Content-based detection
  if (!content || content.length === 0) return 'plaintext';

  const firstLine = content.split('\n')[0]?.trim() || '';
  const sample = content.substring(0, 500).trim();

  // Shebang
  if (firstLine.startsWith('#!')) {
    const shebang = firstLine.toLowerCase();
    if (shebang.includes('python') || shebang.includes('python3')) return 'python';
    if (shebang.includes('node') || shebang.includes('deno') || shebang.includes('bun')) return 'javascript';
    if (shebang.includes('bash') || shebang.includes('sh') || shebang.includes('zsh')) return 'shell';
    if (shebang.includes('ruby')) return 'ruby';
    if (shebang.includes('perl')) return 'perl';
    if (shebang.includes('php')) return 'php';
    if (shebang.includes('lua')) return 'lua';
    if (shebang.includes('fish')) return 'shell';
    return 'shell';
  }

  // XML/HTML/SVG
  if (/^\s*<[?!]xml/i.test(sample) || /^\s*<!DOCTYPE\s+html/i.test(sample) || /^\s*<!DOCTYPE\s+svg/i.test(sample)) {
    const lower = sample.toLowerCase();
    if (lower.includes('<html') || lower.includes('<!doctype html')) return 'html';
    if (lower.includes('<svg') || lower.includes('<!doctype svg')) return 'xml';
    return 'xml';
  }

  // JSON
  if (/^\s*[\[{]/.test(sample)) {
    try { JSON.parse(content); return 'json'; } catch { /* not JSON, continue */ }
  }

  // INI-like: key=value or [section]
  const lines = content.split('\n').filter(l => { const t = l.trim(); return t && !t.startsWith('#') && !t.startsWith(';'); });
  if (lines.length >= 3) {
    const kvLines = lines.filter(l => /^[a-zA-Z0-9_.\[\]-]+\s*[:=]\s*/.test(l.trim()));
    const sectionLines = lines.filter(l => /^\[.+\]$/.test(l.trim()));
    if (kvLines.length + sectionLines.length >= lines.length * 0.6) return 'ini';
  }

  // CSV
  if (lines.length >= 2) {
    const commaCount = lines.filter(l => l.includes(',')).length;
    const tabCount = lines.filter(l => l.includes('\t')).length;
    if (commaCount >= lines.length * 0.7) return 'csv';
    if (tabCount >= lines.length * 0.7) return 'csv';
  }

  // Log-like
  if (lines.some(l => /^\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}/.test(l))) return 'log';

  // C/C++ header-like (lots of #include, #define, #ifdef)
  if (sample.includes('#include') || sample.includes('#define') || sample.includes('#ifndef')) return 'cpp';

  return 'plaintext';
}

interface OpenTab {
  path:string; name:string; fileType:FileType; isDirty:boolean; language:string;
  model:any; viewState:any; browserUrl?:string; wvId?:string;
  readOnlyReason?:string;
  browserLoading?:boolean; browserTitle?:string; browserFavicon?:string;
  browserCanGoBack?:boolean; browserCanGoForward?:boolean;
  browserZoomFactor?:number; browserRecentUrls?:string[];
  downloads?:BrowserDownloadEvent[];
  networkEvents?:BrowserNetworkEvent[];
  consoleLogs?:BrowserConsoleLog[];
  securityEvents?:BrowserSecurityEvent[];
  browserPanel?:BrowserPanelMode|null;
  findVisible?:boolean; findQuery?:string; findMatches?:number; findActiveMatch?:number; findMatchCase?:boolean;
  browserViewport?:BrowserViewportPreset;
  agentTrace?: AgentBrowserEvent[];
  tableRows?:string[][];
  originalContent?:string; // snapshot at open — for diff detection
}

export class WorkspaceTabGroup {
  private static _groups = new Set<WorkspaceTabGroup>();
  private static _languageFeaturesRegistered = false;
  readonly element: HTMLElement;
  private _tabBar: HTMLElement; private _plusBtn: HTMLElement; private _contentArea: HTMLElement;
  private _tabs: OpenTab[] = []; private _activePath: string|null = null;
  private _editor: any = null; private _editorHost: HTMLElement | null = null; private _monacoReady = false; private _monacoInit: Promise<void>|null = null;
  private _sessionId = ''; private _workspacePath = ''; private _ro: ResizeObserver|null = null;
  private _wvStateCleanup: (()=>void)|null = null;
  private _wvDownloadCleanup: (()=>void)|null = null;
  private _wvNetworkCleanup: (()=>void)|null = null;
  private _wvSecurityCleanup: (()=>void)|null = null;
  private _wvFindCleanup: (()=>void)|null = null;
  private _globalKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _windowResizeHandler: (() => void) | null = null;
  private _findInputTimer = 0;
  private _browserStateRestored = false;
  private _browserStateSaveTimer = 0;
  private _restoringBrowserState = false;
  private _workspacePathReady = false;
  private _persistenceScope = 'primary';
  private _inlineCompletionRequestId = 0;
  private _modelSequence = 0;
  private _inlineCompletionState: 'idle' | 'waiting' | 'thinking' | 'ready' | 'empty' | 'error' = 'idle';
  private _inlineCompletionMessage = 'AI Ready';
  private _diagnosticsTimer = 0;
  private _languageStatusState: 'idle' | 'working' | 'ready' | 'error' = 'idle';
  private _languageStatusMessage = 'LS Ready';
  onOpenFile: ((path:string, name:string)=>void)|null = null;
  /** Called (throttled) whenever editor state changes — cursor, selection, tab switch. */
  onEditorContextChange: (()=>void)|null = null;

  constructor() {
    WorkspaceTabGroup._groups.add(this);
    this.element = document.createElement('div'); this.element.className = 'ws-tab-group';
    this._tabBar = document.createElement('div'); this._tabBar.className = 'ws-tab-bar';
    this._tabBar.setAttribute('role', 'tablist');
    this._tabBar.setAttribute('aria-label', 'Workspace tabs');
    this.element.appendChild(this._tabBar);

    this._plusBtn = document.createElement('button'); this._plusBtn.className = 'ws-tab-plus';
    this._plusBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    this._plusBtn.title = 'New File / Browser';
    this._plusBtn.addEventListener('click', (e) => { e.stopPropagation(); this._showPlusDialog(); });
    this._tabBar.appendChild(this._plusBtn);

    this._contentArea = document.createElement('div'); this._contentArea.className = 'ws-tab-content';
    this._showEmpty(); this.element.appendChild(this._contentArea);
    this._ro = new ResizeObserver(() => { this._editor?.layout(); this._syncWvBounds(); });
    this._ro.observe(this._contentArea);
    // Ctrl+S / Cmd+S — document-level so it works regardless of which element has focus.
    // Only saves if this tab group is mounted on the visible workspace page.
    this._globalKeyHandler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        // Guard: only handle when the workspace page is visible
        if (!this.element.isConnected || !this.element.offsetParent) return;
        e.preventDefault();
        void this.saveActiveFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (!this.element.isConnected || !this.element.offsetParent) return;
        const tab = this._tabs.find(t => t.path === this._activePath);
        if (tab?.fileType !== 'browser') return;
        e.preventDefault();
        this._showFindBar(tab);
      }
    };
    document.addEventListener('keydown', this._globalKeyHandler);
    // Sync WebContentsView bounds on window resize
    this._windowResizeHandler = () => this._syncWvBounds();
    window.addEventListener('resize', this._windowResizeHandler);

    // Listen for WebContentsView state changes (loading, title, favicon)
    const api = this._api();
    if (api?.onWvStateChange) {
      this._wvStateCleanup = api.onWvStateChange((data: BrowserStateEvent) => {
        const tab = this._tabs.find(t => t.wvId === data.viewId);
        if (!tab) return;
        this._applyBrowserState(tab, data);
        switch (data.type) {
          case 'loading-start':
            tab.browserLoading = true;
            this._updateBrowserChrome(tab);
            break;
          case 'loading-stop':
          case 'load-finish':
            tab.browserLoading = false;
            this._updateBrowserChrome(tab);
            break;
          case 'load-error':
            tab.browserLoading = false;
            this._updateBrowserChrome(tab);
            break;
          case 'title':
            if (data.title && data.title !== 'about:blank') {
              tab.browserTitle = data.title;
              tab.name = data.title.substring(0, 40);
              const nm = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"] .ws-tab-name`) as HTMLElement;
              if (nm) nm.textContent = tab.name;
              this._scheduleBrowserStateSave();
            }
            break;
          case 'favicon':
            if (data.favicons?.length) {
              tab.browserFavicon = data.favicons[0];
              this._updateTabFavicon(tab);
              this._scheduleBrowserStateSave();
            }
            break;
          case 'zoom':
            if (typeof data.zoomFactor === 'number') {
              tab.browserZoomFactor = data.zoomFactor;
              this._scheduleBrowserStateSave();
            }
            break;
          case 'console-message':
            if (data.consoleLog) {
              tab.consoleLogs = [...(tab.consoleLogs || []), data.consoleLog].slice(-200);
              if (tab.path === this._activePath) this._renderBrowserPanel(tab);
            }
            break;
        }
      });
    }

    if (api?.onWvDownload) {
      this._wvDownloadCleanup = api.onWvDownload((event: BrowserDownloadEvent) => this._handleBrowserDownload(event));
    }
    if (api?.onWvNetwork) {
      this._wvNetworkCleanup = api.onWvNetwork((event: BrowserNetworkEvent) => this._handleBrowserNetwork(event));
    }
    if (api?.onWvSecurity) {
      this._wvSecurityCleanup = api.onWvSecurity((event: BrowserSecurityEvent) => this._handleBrowserSecurity(event));
    }
    if (api?.onWvFindResult) {
      this._wvFindCleanup = api.onWvFindResult((event: BrowserFindResult) => this._handleBrowserFindResult(event));
    }
  }

  setSessionId(id: string): void {
    if (id !== this._sessionId) this._browserStateRestored = false;
    this._sessionId = id;
    this._restoreBrowserStateIfReady();
  }

  setWorkspacePath(path: string): void {
    if (path !== this._workspacePath) this._browserStateRestored = false;
    this._workspacePathReady = true;
    this._workspacePath = path;
    for (const tab of this._tabs) {
      if (tab.fileType === 'browser' && tab.wvId) {
        this._api()?.wvSetMetadata?.(tab.wvId, { sessionId: this._sessionId, workspacePath: this._workspacePath });
      }
    }
    this._restoreBrowserStateIfReady();
  }

  setPersistenceScope(scope: string): void {
    const next = scope || 'primary';
    if (next === this._persistenceScope) return;
    this._saveBrowserStateNow();
    this._persistenceScope = next;
    this._browserStateRestored = false;
    this._restoreBrowserStateIfReady();
  }

  private _restoreBrowserStateIfReady(): void {
    if (this._browserStateRestored || !this._sessionId || !this._workspacePathReady || this._tabs.length > 0) return;
    this._browserStateRestored = true;
    const key = this._browserStorageKey();
    if (!key) return;
    let state: PersistedBrowserState | null = null;
    try {
      const raw = localStorage.getItem(key);
      state = raw ? JSON.parse(raw) as PersistedBrowserState : null;
    } catch {
      state = null;
    }
    if (!state || state.version !== 1 || !Array.isArray(state.tabs) || state.tabs.length === 0) return;

    this._restoringBrowserState = true;
    void (async () => {
      try {
        const tabs = state!.tabs.slice(0, 8).filter(t => typeof t.url === 'string' && t.url);
        for (const tab of tabs) {
          await this.newBrowserTab(tab.url, tab);
        }
        const browserTabs = this._tabs.filter(t => t.fileType === 'browser');
        const active = browserTabs[Math.max(0, Math.min(browserTabs.length - 1, state!.activeIndex || 0))] || browserTabs[0];
        if (active) this._activate(active);
      } finally {
        this._restoringBrowserState = false;
        this._scheduleBrowserStateSave();
      }
    })();
  }

  private _browserStorageKey(): string {
    if (!this._sessionId) return '';
    return `anoclaw:workspace-browser:v1:${this._sessionId}:${_hashString(this._workspacePath || 'default')}:${this._persistenceScope}`;
  }

  private _scheduleBrowserStateSave(): void {
    if (this._restoringBrowserState) return;
    if (this._browserStateSaveTimer) window.clearTimeout(this._browserStateSaveTimer);
    this._browserStateSaveTimer = window.setTimeout(() => {
      this._browserStateSaveTimer = 0;
      this._saveBrowserStateNow();
    }, 250);
  }

  private _saveBrowserStateNow(): void {
    if (!this._sessionId || !this._workspacePathReady) return;
    const key = this._browserStorageKey();
    if (!key) return;
    const browserTabs = this._tabs.filter(t => t.fileType === 'browser');
    try {
      if (browserTabs.length === 0) {
        localStorage.removeItem(key);
        return;
      }
      const state: PersistedBrowserState = {
        version: 1,
        sessionId: this._sessionId,
        workspacePath: this._workspacePath,
        activeIndex: Math.max(0, browserTabs.findIndex(t => t.path === this._activePath)),
        savedAt: Date.now(),
        tabs: browserTabs.map(tab => ({
          url: tab.browserUrl || 'about:blank',
          title: tab.browserTitle || tab.name,
          favicon: tab.browserFavicon,
          zoomFactor: tab.browserZoomFactor || 1,
          recentUrls: (tab.browserRecentUrls || []).slice(-20),
          viewportName: tab.browserViewport?.name || 'desktop',
        })),
      };
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      console.debug('WorkspaceTabGroup: browser state save failed');
    }
  }

  private _api(): any { return (window as any).electronAPI; }

  // ── Plus dialog ──

  private _showPlusDialog(): void {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); } });

    const card = document.createElement('div');
    card.className = 'dialog';
    card.innerHTML = `
      <h2 class="dialog-title">New Tab</h2>
      <div class="dialog-actions" style="flex-direction:column;gap:8px;align-items:stretch;">
        <button id="ws-plus-new-file" class="btn-dialog-confirm">New File</button>
        <button id="ws-plus-new-browser" class="btn-dialog-confirm">New Browser</button>
      </div>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    card.querySelector('#ws-plus-new-file')?.addEventListener('click', () => { overlay.remove(); this._promptNewFile(); });
    card.querySelector('#ws-plus-new-browser')?.addEventListener('click', () => { overlay.remove(); this.newBrowserTab(); });

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  private _promptNewFile(): void {
    this._showInputDialog('New File', 'File name (e.g. app.ts, style.css)', (name) => {
      if (!name) return;
      fetch('/api/v1/workspace/create-file', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sessionId:this._sessionId, path:'/', name}) })
        .then(async resp => {
          if (!resp.ok) throw new Error(await _responseError(resp, 'Create file failed'));
          await this.openFile(name, name);
        })
        .catch(err => ToastManager.getInstance().error(err instanceof Error ? err.message : 'Create file failed'));
    });
  }

  /** Create a new browser tab by spawning a new WebContentsView. */
  async newBrowserTab(initialUrl?: string, restore?: PersistedBrowserTab): Promise<void> {
    const url = initialUrl || 'about:blank';
    const api = this._api();
    const result = await api?.wvCreate?.(url, { sessionId: this._sessionId, workspacePath: this._workspacePath });

    const tabId = 'browser:' + Date.now();
    const tab: OpenTab = {
      path: tabId, name: restore?.title || (url === 'about:blank' ? 'New Tab' : url.replace(/^https?:\/\//,'').substring(0, 30)),
      fileType: 'browser', isDirty: false, language: '', model: null, viewState: null,
      browserUrl: url, wvId: result?.viewId || undefined, agentTrace: [],
      browserTitle: restore?.title, browserFavicon: restore?.favicon,
      browserZoomFactor: restore?.zoomFactor || 1,
      browserRecentUrls: restore?.recentUrls?.slice(-20) || (url !== 'about:blank' ? [url] : []),
      downloads: [], networkEvents: [], consoleLogs: [], securityEvents: [], browserPanel: null,
      findVisible: false, findQuery: '', findMatches: 0, findActiveMatch: 0, findMatchCase: false,
      browserViewport: _viewportByName(restore?.viewportName),
    };
    this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
    if (tab.browserFavicon) this._updateTabFavicon(tab);
    if (tab.wvId && tab.browserZoomFactor && tab.browserZoomFactor !== 1) {
      void this._api()?.wvSetZoom?.(tab.wvId, tab.browserZoomFactor);
    }
    const viewport = tab.browserViewport;
    if (tab.wvId && viewport && viewport.name !== 'desktop') {
      void this._api()?.wvSetViewport?.(tab.wvId, _viewportPayload(viewport));
    }
    if (!this._restoringBrowserState) this._scheduleBrowserStateSave();
  }

  /** Public entry point for agent-created browser tabs (view already created via IPC). */
  _createBrowserTab(url: string, viewId: string): void {
    const existing = this._tabs.find(t => t.wvId === viewId);
    if (existing) {
      if (url) this._updateBrowserTabUrl(existing, url);
      this._activate(existing);
      return;
    }
    const tab: OpenTab = {
      path: 'browser:' + Date.now(),
      name: url === 'about:blank' ? 'New Tab' : url.replace(/^https?:\/\//,'').substring(0, 30),
      fileType: 'browser', isDirty: false, language: '', model: null, viewState: null,
      browserUrl: url, wvId: viewId, agentTrace: [], browserZoomFactor: 1, browserRecentUrls: url !== 'about:blank' ? [url] : [], downloads: [],
      networkEvents: [], consoleLogs: [], securityEvents: [], browserPanel: null,
      findVisible: false, findQuery: '', findMatches: 0, findActiveMatch: 0, findMatchCase: false,
      browserViewport: BROWSER_VIEWPORT_PRESETS[0],
    };
    this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
    this._api()?.wvSetMetadata?.(viewId, { sessionId: this._sessionId, workspacePath: this._workspacePath });
    this._scheduleBrowserStateSave();
  }

  handleAgentBrowserEvent(event: AgentBrowserEvent): void {
    let tab = this._tabs.find(t => t.wvId === event.viewId);
    if (!tab) {
      const url = event.url || 'about:blank';
      tab = {
        path: 'browser:' + Date.now(),
        name: url === 'about:blank' ? 'Agent Browser' : url.replace(/^https?:\/\//,'').substring(0, 30),
        fileType: 'browser', isDirty: false, language: '', model: null, viewState: null,
        browserUrl: url, wvId: event.viewId, agentTrace: [], browserZoomFactor: 1, browserRecentUrls: url !== 'about:blank' ? [url] : [], downloads: [],
        networkEvents: [], consoleLogs: [], securityEvents: [], browserPanel: null,
        findVisible: false, findQuery: '', findMatches: 0, findActiveMatch: 0, findMatchCase: false,
        browserViewport: BROWSER_VIEWPORT_PRESETS[0],
      };
      this._tabs.push(tab);
      this._renderTabBtn(tab);
      this._api()?.wvSetMetadata?.(event.viewId, { sessionId: this._sessionId, workspacePath: this._workspacePath });
    }

    if (event.url) this._updateBrowserTabUrl(tab, event.url);
    tab.agentTrace = [...(tab.agentTrace || []), event].slice(-12);
    this._activate(tab);
    this._renderAgentTrace(tab);
    this._scheduleBrowserStateSave();
  }

  private _updateBrowserTabUrl(tab: OpenTab, url: string): void {
    tab.browserUrl = url;
    if (url && url !== 'about:blank') {
      const recent = (tab.browserRecentUrls || []).filter(item => item !== url);
      tab.browserRecentUrls = [...recent, url].slice(-20);
    }
    if (!tab.browserTitle) tab.name = url === 'about:blank' ? 'Agent Browser' : url.replace(/^https?:\/\//,'').substring(0, 30);
    const btn = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"] .ws-tab-name`) as HTMLElement | null;
    if (btn) btn.textContent = tab.name;
    this._scheduleBrowserStateSave();
  }

  // ── Input dialog helper (for New File) ──

  private _showInputDialog(title: string, placeholder: string, onOk: (value: string) => void): void {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const card = document.createElement('div');
    card.className = 'dialog';
    card.innerHTML = `
      <h2 class="dialog-title">${_escHtml(title)}</h2>
      <input id="ws-input-dlg-field" type="text" class="dialog-input" placeholder="${_escHtml(placeholder)}" autofocus style="width:100%;padding:6px 10px;background:var(--color-bg);border:1px solid var(--color-hairline);border-radius:6px;color:var(--color-text);font-size:13px;font-family:inherit;outline:none;margin:8px 0;box-sizing:border-box;">
      <div class="dialog-actions">
        <button class="btn-dialog-cancel" id="ws-input-dlg-cancel">Cancel</button>
        <button class="btn-dialog-confirm" id="ws-input-dlg-ok">OK</button>
      </div>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const field = card.querySelector('#ws-input-dlg-field') as HTMLInputElement;
    field.focus();
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { overlay.remove(); onOk(field.value); } });
    card.querySelector('#ws-input-dlg-ok')?.addEventListener('click', () => { overlay.remove(); onOk(field.value); });
    card.querySelector('#ws-input-dlg-cancel')?.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });
  }

  // ── Monaco init ──

  private _initMonaco(): Promise<void> {
    if (this._monacoReady) return Promise.resolve();
    if (this._monacoInit) return this._monacoInit;
    this._monacoInit = new Promise((resolve) => {
      const req = (window as any).require; if (!req) { resolve(); return; }
      req.config({ paths: { vs: 'monaco/vs' } });
      req(['vs/editor/editor.main'], () => {
        (window as any).monaco.editor.defineTheme('anoclaw-dark', {
          base:'vs-dark', inherit:true, rules:[], colors:{ 'editor.background':'#0a0a0a', 'editor.foreground':'#d4d4d4', 'editor.lineHighlightBackground':'#141414' },
        });
        this._monacoReady = true; resolve();
      });
    });
    return this._monacoInit;
  }

  // ── Open / close ──

  async openFile(path: string, name: string, line?: number, column?: number): Promise<void> {
    const existing = this._tabs.find(t => t.path === path);
    if (existing) {
      this._activate(existing);
      if (existing.fileType === 'code') this._revealEditorLocation(line, column);
      return;
    }
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const nameLower = name.toLowerCase();

    // ── Images ──
    if (IMG_EXTS.has(ext)) {
      const tab: OpenTab = { path, name, fileType:'image', isDirty:false, language:'', model:null, viewState:null };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
      return;
    }

    // ── Audio / video ──
    if (AUDIO_EXTS.has(ext)) {
      const tab: OpenTab = { path, name, fileType:'audio', isDirty:false, language:'', model:null, viewState:null };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
      return;
    }
    if (VIDEO_EXTS.has(ext)) {
      const tab: OpenTab = { path, name, fileType:'video', isDirty:false, language:'', model:null, viewState:null };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
      return;
    }

    // ── PDF ──
    if (ext === 'pdf') {
      const tab: OpenTab = { path, name, fileType:'pdf', isDirty:false, language:'', model:null, viewState:null };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
      return;
    }

    // ── Office documents ──
    if (OFFICE_EXTS.has(ext)) {
      const ft: FileType = ext === 'docx' || ext === 'doc' || ext === 'odt' ? 'docx'
        : ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'ods' ? 'xlsx'
        : 'pptx';
      const tab: OpenTab = { path, name, fileType:ft, isDirty:false, language:'', model:null, viewState:null };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
      return;
    }

    // ── Everything else: fetch content, detect language ──
    try {
      const resp = await fetch(`/api/v1/workspace/read?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(this._sessionId)}`);
      if (!resp.ok) throw new Error('Read failed');
      const data = await resp.json();
      const content = data.content || '';

      if (_isBinaryContent(content)) {
        const tab: OpenTab = { path, name, fileType:'binary', isDirty:false, language:'', model:null, viewState:null };
        this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
        return;
      }

      if (TABLE_EXTS.has(ext)) {
        const tab: OpenTab = {
          path, name, fileType:'csv', isDirty:false, language:'csv', model:null, viewState:null,
          tableRows: _parseDelimitedRows(content, ext === 'tsv' ? '\t' : ','),
          originalContent: content,
        };
        this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
        return;
      }

      const language = _detectLanguage(name, content);
      const fileType: FileType = language === 'markdown' ? 'markdown' : 'code';

      await this._initMonaco(); if (!this._monacoReady) return;
      const m = (window as any).monaco;
      const modelScope = `${this._persistenceScope}-${++this._modelSequence}`;
      const modelUri = workspaceModelUri(this._sessionId, this._workspacePath, modelScope, path);
      const model = m.editor.createModel(content, language, m.Uri.parse(modelUri));

      const tab: OpenTab = {
        path,
        name,
        fileType,
        isDirty:false,
        language,
        model,
        viewState:null,
        originalContent: content,
        readOnlyReason: workspaceReadOnlyReason(data),
      };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
      if (fileType === 'code') this._revealEditorLocation(line, column);
    } catch {
      const tab: OpenTab = { path, name, fileType:'binary', isDirty:false, language:'', model:null, viewState:null };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
    }
  }

  private _revealEditorLocation(line?: number, column?: number): void {
    if (!this._editor || !line || line < 1) return;
    const model = this._editor.getModel?.();
    if (!model) return;

    const lineNumber = Math.min(Math.max(1, Math.trunc(line)), model.getLineCount());
    const maxColumn = model.getLineMaxColumn(lineNumber);
    const safeColumn = Math.min(Math.max(1, Math.trunc(column || 1)), maxColumn);
    const position = { lineNumber, column: safeColumn };
    this._editor.setPosition(position);
    this._editor.revealPositionInCenter(position);
    this._editor.focus();
  }

  private _renderTabBtn(tab: OpenTab): void {
    const btn = document.createElement('div');
    btn.className = 'ws-tab' + (tab.fileType==='browser'?' ws-tab-browser':'');
    btn.setAttribute('data-tab-path', tab.path);
    btn.setAttribute('data-tab-kind', tab.fileType);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('tabindex', '-1');
    btn.title = tab.path;
    const nm = document.createElement('span'); nm.className = 'ws-tab-name'; nm.textContent = tab.name; btn.appendChild(nm);
    const cls = document.createElement('span');
    cls.className = 'ws-tab-close';
    cls.setAttribute('role', 'button');
    cls.setAttribute('aria-label', `Close ${tab.name}`);
    cls.setAttribute('tabindex', '-1');
    cls.innerHTML = _SVG_TAB_CLOSE;
    cls.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(tab.path); });
    cls.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.closeTab(tab.path);
      }
    });
    btn.appendChild(cls);
    btn.addEventListener('click', () => this._activate(tab));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._activate(tab);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.closeTab(tab.path);
      }
    });
    btn.addEventListener('mousedown', (e) => { if (e.button===1) { e.preventDefault(); this.closeTab(tab.path); } });
    this._tabBar.insertBefore(btn, this._plusBtn);
  }

  private _activate(tab: OpenTab): void {
    if (this._editor) { const cur = this._tabs.find(t => t.path===this._activePath); if (cur) cur.viewState = this._editor.saveViewState(); }
    this._activePath = tab.path;
    this._tabBar.querySelectorAll('.ws-tab').forEach(el => {
      const active = el.getAttribute('data-tab-path') === tab.path;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', String(active));
      el.setAttribute('tabindex', active ? '0' : '-1');
    });
    // Destroy any existing browser view before switching
    this._destroyBrowserView();
    switch (tab.fileType) {
      case 'code': this._showCodeEditor(tab); break;
      case 'image': this._showImage(tab); break;
      case 'audio': this._showMedia(tab, 'audio'); break;
      case 'video': this._showMedia(tab, 'video'); break;
      case 'pdf': this._showPdf(tab); break;
      case 'markdown': this._showMarkdown(tab); break;
      case 'csv': this._showTablePreview(tab.tableRows || [], tab.name); break;
      case 'browser': this._showBrowser(tab); break;
      case 'docx': case 'xlsx': case 'pptx': this._showOffice(tab); break;
      default: this._showBinaryNotice(tab);
    }
    this._notifyContextChange();
    if (tab.fileType === 'browser') this._scheduleBrowserStateSave();
  }

  closeTab(path: string): void {
    const idx = this._tabs.findIndex(t => t.path===path); if (idx===-1) return;
    const tab = this._tabs[idx];
    if (tab.isDirty) { this._confirmCloseDirty(tab, idx); return; }
    this._doCloseTab(tab, idx);
  }

  private async _confirmCloseDirty(tab: OpenTab, idx: number): Promise<void> {
    const action = await this._promptDirtyAction(tab, 'closing');
    if (action === 'cancel') return;
    if (action === 'save' && !await this.saveFile(tab)) return;
    this._doCloseTab(tab, idx);
  }

  private _promptDirtyAction(tab: OpenTab, actionLabel: string): Promise<'save'|'discard'|'cancel'> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      let settled = false;
      const finish = (action: 'save'|'discard'|'cancel') => {
        if (settled) return;
        settled = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(action);
      };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel'); });
      const card = document.createElement('div');
      card.className = 'dialog';
      card.innerHTML = `
        <h2 class="dialog-title">Unsaved changes</h2>
        <p class="dialog-message">Save changes to "${_escHtml(tab.name)}" before ${_escHtml(actionLabel)}?</p>
        <div class="dialog-actions">
          <button class="btn-dialog-cancel" data-action="cancel">Cancel</button>
          <button class="btn-dialog-cancel" data-action="discard">Discard</button>
          <button class="btn-dialog-confirm" data-action="save">Save</button>
        </div>`;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      card.querySelector('[data-action="cancel"]')?.addEventListener('click', () => finish('cancel'));
      card.querySelector('[data-action="discard"]')?.addEventListener('click', () => finish('discard'));
      card.querySelector('[data-action="save"]')?.addEventListener('click', () => finish('save'));
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish('cancel'); };
      document.addEventListener('keydown', onKey);
    });
  }

  private _doCloseTab(tab: OpenTab, idx: number): void {
    this._tabs.splice(idx, 1);
    const btn = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"]`); if (btn) btn.remove();
    if (tab.model) tab.model.dispose();
    if (tab.wvId) { this._api()?.wvDestroy?.(tab.wvId); }
    if (tab.path===this._activePath) {
      this._destroyBrowserView();
      const next = this._tabs[idx] || this._tabs[this._tabs.length-1] || null;
      if (next) { this._activate(next); }
      else { this._activePath = null; if (this._editor) { this._editor.dispose(); this._editor = null; } this._editorHost = null; this._showEmpty(); }
    }
    if (tab.fileType === 'browser') this._scheduleBrowserStateSave();
  }

  // ── Content renderers ──

  private _showCodeEditor(tab: OpenTab): void {
    const m = (window as any).monaco; this._destroyContent();
    this._contentArea.style.cssText = 'display:flex;flex-direction:column;';

    // Persist editor host across tab switches so Monaco isn't destroyed/recreated
    if (!this._editorHost) {
      this._editorHost = document.createElement('div');
      this._editorHost.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
    }
    this._contentArea.appendChild(this._editorHost);

    if (!this._editor) {
      this._editor = m.editor.create(this._editorHost, {
        theme:'anoclaw-dark', fontSize:13, fontFamily:"'Cascadia Code','Fira Code',Consolas,'SF Mono',Monaco,monospace",
        minimap:{enabled:true,scale:1}, automaticLayout:false, scrollBeyondLastLine:false, wordWrap:'off',
        lineNumbers:'on', renderWhitespace:'selection', tabSize:2, bracketPairColorization:{enabled:true}, folding:true, glyphMargin:true,
        quickSuggestions:{ other:true, comments:false, strings:false },
        suggestOnTriggerCharacters:true,
        acceptSuggestionOnEnter:'on',
        tabCompletion:'on',
        wordBasedSuggestions:'allDocuments',
        parameterHints:{ enabled:true },
        inlineSuggest:{ enabled:true, showToolbar:'onHover', mode:'prefix' },
      });
      this._editor.onDidChangeModelContent(() => {
        const active = this._tabs.find(t => t.path===this._activePath);
        if (active && !active.readOnlyReason && !active.isDirty) { active.isDirty = true; this._updateDirty(active); }
        this._scheduleDiagnostics(this._editor.getModel());
      });
      // Update status bar on cursor change
      this._editor.onDidChangeCursorPosition((e: { position: { lineNumber: number; column: number } }) => {
        const status = this._contentArea.querySelector('.ws-editor-status') as HTMLElement;
        if (status) {
          const cp = status.querySelector('[data-role="cursor-pos"]') as HTMLElement | null;
          if (cp) cp.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
        }
        this._notifyContextChange();
      });
      this._editor.onDidChangeCursorSelection(() => { this._notifyContextChange(); });

      // Register Agent context menu actions (once)
      this._registerAgentActions();
      // Register inline completion provider (once)
      this._registerInlineCompletion();
      this._registerLanguageFeatures();
    }
    this._editor.setModel(tab.model);
    this._editor.updateOptions({
      readOnly: Boolean(tab.readOnlyReason),
      readOnlyMessage: tab.readOnlyReason ? { value: tab.readOnlyReason } : undefined,
    });
    if (tab.viewState) this._editor.restoreViewState(tab.viewState);
    this._editor.focus();
    this._scheduleDiagnostics(tab.model, 80);

    // Add editor status bar
    const statusBar = document.createElement('div');
    statusBar.className = 'ws-editor-status';
    statusBar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:2px 10px;height:22px;flex-shrink:0;background:var(--color-surface,#0d0d0d);border-top:1px solid var(--color-hairline,#242728);font-size:11px;color:var(--color-text-secondary,#9c9c9d);font-family:var(--font-mono);';

    // Language indicator
    const langEl = document.createElement('span');
    langEl.textContent = tab.language || 'plaintext';
    langEl.style.cssText = 'text-transform:uppercase;font-size:10px;font-weight:500;';
    statusBar.appendChild(langEl);

    if (tab.readOnlyReason) {
      const readOnlyEl = document.createElement('span');
      readOnlyEl.textContent = tab.readOnlyReason;
      readOnlyEl.title = tab.readOnlyReason;
      readOnlyEl.style.cssText = 'color:#ffc533;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42%;';
      statusBar.appendChild(readOnlyEl);
    }

    // Spacer
    const spacer = document.createElement('span');
    spacer.style.cssText = 'flex:1;';
    statusBar.appendChild(spacer);

    // Cursor position
    const posEl = document.createElement('span');
    const pos = this._editor.getPosition();
    posEl.textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : 'Ln 1, Col 1';
    posEl.setAttribute('data-role', 'cursor-pos');
    statusBar.appendChild(posEl);

    // Tab size
    const tabSizeEl = document.createElement('span');
    tabSizeEl.textContent = 'Spaces: 2';
    tabSizeEl.style.cssText = 'opacity:0.5;';
    statusBar.appendChild(tabSizeEl);

    // Encoding
    const encEl = document.createElement('span');
    encEl.textContent = 'UTF-8';
    encEl.style.cssText = 'opacity:0.5;';
    statusBar.appendChild(encEl);

    const lsEl = document.createElement('button');
    lsEl.type = 'button';
    lsEl.className = `ws-editor-ls-status ${this._languageStatusState}`;
    lsEl.setAttribute('data-role', 'language-service-status');
    lsEl.title = 'Language service: completions, hover, diagnostics, definitions, and imports.';
    lsEl.textContent = this._languageStatusMessage;
    lsEl.addEventListener('click', () => { void this._goToDefinitionFromEditor(); });
    statusBar.appendChild(lsEl);

    const aiEl = document.createElement('button');
    aiEl.type = 'button';
    aiEl.className = `ws-editor-ai-status ${this._inlineCompletionState}`;
    aiEl.setAttribute('data-role', 'inline-completion-status');
    aiEl.title = 'AI completion: wait briefly after typing, or click / use Alt+\\ to complete at cursor.';
    aiEl.textContent = this._inlineCompletionMessage;
    aiEl.addEventListener('click', () => { void this._triggerInlineCompletion(true); });
    statusBar.appendChild(aiEl);

    this._contentArea.appendChild(statusBar);
    this._renderLanguageStatus();
    this._renderInlineCompletionStatus();
  }

  private _rawFileUrl(filePath: string): string {
    return `/api/v1/workspace/read?path=${encodeURIComponent(filePath)}&sessionId=${encodeURIComponent(this._sessionId)}&raw=1`;
  }

  private _showImage(tab: OpenTab): void {
    this._destroyContent();
    this._contentArea.classList.add('ws-preview-surface');
    this._contentArea.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#0a0a0a;';
    const img = document.createElement('img');
    img.className = 'ws-preview-image';
    img.src = this._rawFileUrl(tab.path);
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
    this._contentArea.appendChild(img);
  }

  private _showMedia(tab: OpenTab, kind: 'audio' | 'video'): void {
    this._destroyContent();
    this._contentArea.classList.add('ws-preview-surface');
    this._contentArea.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#0a0a0a;padding:24px;box-sizing:border-box;';
    const media = document.createElement(kind);
    media.controls = true;
    media.preload = 'metadata';
    media.src = this._rawFileUrl(tab.path);
    media.className = `ws-preview-${kind}`;
    if (kind === 'video') {
      media.style.cssText = 'max-width:100%;max-height:100%;background:#000;border-radius:6px;';
    } else {
      media.style.cssText = 'width:min(620px,100%);';
    }
    this._contentArea.appendChild(media);
  }

  private _showPdf(tab: OpenTab): void {
    this._destroyContent();
    const iframe = document.createElement('iframe');
    iframe.src = this._rawFileUrl(tab.path);
    iframe.style.cssText = 'width:100%;height:100%;border:none;';
    this._contentArea.appendChild(iframe);
  }

  private _showTablePreview(rows: string[][], title: string): void {
    this._destroyContent();
    this._contentArea.style.cssText = 'overflow:auto;background:var(--color-bg,#07080a);';
    const wrapper = document.createElement('div');
    wrapper.className = 'ws-preview-table-wrap';
    if (!rows.length) {
      wrapper.innerHTML = `<div class="ws-preview-empty">${_escHtml(title)}<span>No rows found.</span></div>`;
      this._contentArea.appendChild(wrapper);
      return;
    }

    const table = document.createElement('table');
    table.className = 'ws-preview-table';
    const maxCols = Math.min(50, Math.max(...rows.map(row => row.length)));
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (let i = 0; i < maxCols; i++) {
      const th = document.createElement('th');
      th.textContent = _columnName(i);
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    for (const row of rows.slice(0, 200)) {
      const tr = document.createElement('tr');
      for (let i = 0; i < maxCols; i++) {
        const td = document.createElement('td');
        td.textContent = row[i] || '';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrapper.appendChild(table);
    this._contentArea.appendChild(wrapper);
  }

  private async _showMarkdown(tab: OpenTab): Promise<void> {
    this._destroyContent();
    try {
      const resp = await fetch(`/api/v1/workspace/read?path=${encodeURIComponent(tab.path)}&sessionId=${encodeURIComponent(this._sessionId)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const { renderMarkdown } = await import('../../../MarkdownRenderer.js');
      const md = document.createElement('div'); md.className = 'ws-preview-markdown'; md.innerHTML = renderMarkdown(data.content||''); md.style.cssText = 'padding:16px 24px;overflow-y:auto;height:100%;';
      this._contentArea.appendChild(md);
    } catch { /* ignore */ }
  }

  // ── Browser tab (WebContentsView) ──

  private _lastWvId: string | null = null;

  private _showBrowser(tab: OpenTab): void {
    this._destroyContent();
    this._contentArea.style.cssText = 'display:flex;flex-direction:column;';

    // ── Toolbar ──
    const bar = document.createElement('div');
    bar.className = 'ws-browser-bar';

    // Left group: Back / Forward / Reload
    const leftGroup = document.createElement('div');
    leftGroup.className = 'ws-browser-group';
    const backBtn = this._browserBtn('Go Back', _SVG_BROWSER_BACK);
    backBtn.setAttribute('data-action', 'back');
    (backBtn as HTMLButtonElement).disabled = !tab.browserCanGoBack;
    const forwardBtn = this._browserBtn('Go Forward', _SVG_BROWSER_FORWARD);
    forwardBtn.setAttribute('data-action', 'forward');
    (forwardBtn as HTMLButtonElement).disabled = !tab.browserCanGoForward;
    const reloadBtn = this._browserBtn('Reload', _SVG_BROWSER_RELOAD);
    reloadBtn.setAttribute('data-action', 'reload');
    leftGroup.append(backBtn, forwardBtn, reloadBtn);
    bar.appendChild(leftGroup);

    // Address bar with SSL icon + loading spinner
    const urlWrapper = document.createElement('div');
    urlWrapper.style.cssText = 'flex:1;display:flex;align-items:center;position:relative;';
    // SSL indicator
    const sslIcon = document.createElement('span');
    sslIcon.className = 'ws-browser-ssl-icon';
    sslIcon.style.cssText = 'position:absolute;left:8px;width:13px;height:13px;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:1;color:var(--color-text-tertiary,#6a6b6c);';
    sslIcon.innerHTML = tab.browserUrl?.startsWith('https://') ? _SVG_BROWSER_LOCK : '';
    urlWrapper.appendChild(sslIcon);
    // URL input
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'ws-browser-url';
    input.value = tab.browserUrl && tab.browserUrl !== 'about:blank' ? tab.browserUrl : '';
    input.placeholder = 'Search or enter URL';
    input.style.cssText = 'flex:1;padding:4px 8px;padding-left:26px;border:1px solid var(--color-hairline,#242728);border-radius:6px;background:var(--color-bg,#07080a);color:var(--color-text,#f4f4f6);font-size:12px;font-family:inherit;outline:none;min-width:120px;';
    input.addEventListener('focus', () => input.select());
    urlWrapper.appendChild(input);
    bar.appendChild(urlWrapper);

    // Right group
    const rightGroup = document.createElement('div');
    rightGroup.className = 'ws-browser-group';

    const viewportBtn = this._browserBtn(tab.browserViewport?.label || 'Viewport Presets', _SVG_BROWSER_DEVICE);
    viewportBtn.classList.add('ws-browser-viewport-btn');
    viewportBtn.addEventListener('click', (e) => { e.stopPropagation(); this._showViewportMenu(viewportBtn, tab); });
    rightGroup.appendChild(viewportBtn);

    const panelBtn = this._browserBtn('Network / Console', _SVG_BROWSER_PANEL);
    panelBtn.classList.toggle('active', Boolean(tab.browserPanel));
    panelBtn.addEventListener('click', () => { void this._toggleBrowserPanel(tab, tab.browserPanel || 'network'); });
    rightGroup.appendChild(panelBtn);

    // Share with Agent
    const shareBtn = this._browserBtn('Share with Agent', _SVG_BROWSER_SHARE);
    shareBtn.addEventListener('click', () => { void this._sendPageContextToAgent(tab); });
    rightGroup.appendChild(shareBtn);

    // Add element to chat
    const addDropdown = this._browserBtn('Add to Chat', _SVG_BROWSER_PLUS);
    addDropdown.style.position = 'relative';
    addDropdown.addEventListener('click', (e) => { e.stopPropagation(); this._showAddToChatMenu(addDropdown, tab); });
    rightGroup.appendChild(addDropdown);

    // DevTools
    const devBtn = this._browserBtn('Developer Tools', _SVG_BROWSER_DEVTOOLS);
    devBtn.addEventListener('click', () => this._api()?.wvDevTools?.(tab.wvId));
    rightGroup.appendChild(devBtn);

    // More menu
    const moreBtn = this._browserBtn('More', _SVG_BROWSER_MORE);
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this._showBrowserMoreMenu(moreBtn, tab); });
    rightGroup.appendChild(moreBtn);

    bar.appendChild(rightGroup);
    this._contentArea.appendChild(bar);

    // Loading progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'ws-browser-progress';
    progressBar.style.cssText = 'height:2px;flex-shrink:0;background:transparent;transition:background 0.3s;';
    if (tab.browserLoading) {
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-primary,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
    }
    this._contentArea.appendChild(progressBar);

    const findBar = document.createElement('div');
    findBar.className = 'ws-browser-findbar';
    this._contentArea.appendChild(findBar);
    this._renderFindBar(tab);

    const downloads = document.createElement('div');
    downloads.className = 'ws-browser-downloads';
    this._contentArea.appendChild(downloads);
    this._renderDownloads(tab);

    const security = document.createElement('div');
    security.className = 'ws-browser-security';
    this._contentArea.appendChild(security);
    this._renderSecurityPrompts(tab);

    const trace = document.createElement('div');
    trace.className = 'ws-browser-agent-trace';
    this._contentArea.appendChild(trace);
    this._renderAgentTrace(tab);

    // Placeholder for WebContentsView
    const placeholder = document.createElement('div');
    placeholder.className = 'ws-browser-placeholder';
    placeholder.setAttribute('data-wv-view', tab.wvId || '');
    this._contentArea.appendChild(placeholder);

    const panel = document.createElement('div');
    panel.className = 'ws-browser-panel';
    this._contentArea.appendChild(panel);
    void this._hydrateBrowserPanel(tab);
    this._renderBrowserPanel(tab);

    this._lastWvId = tab.wvId || null;

    // Navigation
    const navigate = () => {
      let url = this._normalizeBrowserInput(input.value.trim());
      if (!url) return;
      tab.browserUrl = url;
      tab.name = url.replace(/^https?:\/\//, '').substring(0, 30) || 'Browser';
      const nm = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"] .ws-tab-name`);
      if (nm) nm.textContent = tab.name;
      // Update SSL icon
      sslIcon.innerHTML = url.startsWith('https://') ? _SVG_BROWSER_LOCK : '';
      if (tab.wvId) this._api()?.wvNavigate?.(tab.wvId, url);
      // Show loading bar
      tab.browserLoading = true;
      input.value = url;
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-primary,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
      this._scheduleBrowserStateSave();
      this._syncWvBounds();
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(); });

    // Action buttons
    bar.querySelector('[data-action="back"]')?.addEventListener('click', () => this._api()?.wvGoBack?.(tab.wvId));
    bar.querySelector('[data-action="forward"]')?.addEventListener('click', () => this._api()?.wvGoForward?.(tab.wvId));
    bar.querySelector('[data-action="reload"]')?.addEventListener('click', () => {
      tab.browserLoading = true;
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-primary,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
      this._api()?.wvReload?.(tab.wvId);
    });

    // Position WebContentsView
    [0, 50, 200].forEach(ms => setTimeout(() => this._syncWvBounds(), ms));

    // Auto-focus URL bar
    setTimeout(() => input.focus(), 100);

    // Enable right-click element capture
    setTimeout(() => this._api()?.wvEnableContextCapture?.(tab.wvId), 500);
    this._startContextPoll(tab);
  }

  private _renderAgentTrace(tab: OpenTab): void {
    const box = this._contentArea.querySelector('.ws-browser-agent-trace') as HTMLElement | null;
    if (!box || tab.fileType !== 'browser') return;
    const trace = (tab.agentTrace || []).slice(-8).reverse();
    if (!trace.length) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = 'flex';
    box.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'ws-browser-agent-trace-label';
    label.textContent = 'AGENT';
    box.appendChild(label);

    for (const item of trace) {
      const chip = document.createElement('span');
      chip.className = `ws-browser-agent-trace-chip ${item.phase}`;
      chip.title = this._formatAgentTraceDetail(item);
      chip.textContent = this._formatAgentTraceChip(item);
      box.appendChild(chip);
    }
  }

  private _formatAgentTraceChip(item: AgentBrowserEvent): string {
    const target = item.selector || item.valuePreview || item.url || '';
    const suffix = target ? ` ${target}` : '';
    const mark = item.phase === 'start' ? '...' : item.phase === 'error' ? '!' : 'ok';
    return `${item.action}:${mark}${suffix}`.slice(0, 80);
  }

  private _formatAgentTraceDetail(item: AgentBrowserEvent): string {
    const lines = [
      `Action: ${item.action}`,
      `Status: ${item.phase}`,
      item.url ? `URL: ${item.url}` : '',
      item.selector ? `Selector: ${item.selector}` : '',
      item.valuePreview ? `Value: ${item.valuePreview}` : '',
      item.resultPreview ? `Result: ${item.resultPreview}` : '',
      item.error ? `Error: ${item.error}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  private _handleBrowserDownload(event: BrowserDownloadEvent): void {
    const tab = this._tabs.find(t => t.wvId === event.viewId);
    if (!tab) return;
    const downloads = [...(tab.downloads || [])];
    const idx = downloads.findIndex(item => item.id === event.id);
    if (idx >= 0) downloads[idx] = event;
    else downloads.push(event);
    tab.downloads = downloads.slice(-12);
    if (tab.path === this._activePath) this._renderDownloads(tab);
    if (event.state === 'completed' && event.relativePath) {
      window.dispatchEvent(new CustomEvent('ws-workspace-download-complete', { detail: event }));
    }
  }

  private _renderDownloads(tab: OpenTab): void {
    const box = this._contentArea.querySelector('.ws-browser-downloads') as HTMLElement | null;
    if (!box || tab.fileType !== 'browser') return;
    const downloads = (tab.downloads || []).slice(-6).reverse();
    box.innerHTML = '';
    if (downloads.length === 0) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'flex';

    for (const item of downloads) {
      const row = document.createElement('div');
      row.className = `ws-browser-download-item ${item.state}`;

      const main = document.createElement('div');
      main.className = 'ws-browser-download-main';

      const title = document.createElement('div');
      title.className = 'ws-browser-download-title';
      title.textContent = item.filename || 'download';
      title.title = item.savePath || item.url || item.filename;
      main.appendChild(title);

      const status = document.createElement('div');
      status.className = 'ws-browser-download-status';
      const total = item.totalBytes || 0;
      const pct = total > 0 ? Math.min(100, Math.round((item.receivedBytes / total) * 100)) : 0;
      const stateText = item.state === 'completed' ? 'Done'
        : item.state === 'interrupted' ? 'Interrupted'
        : item.state === 'cancelled' ? 'Cancelled'
        : total > 0 ? `${pct}%`
        : 'Downloading';
      const sizeText = total > 0 ? `${_formatBytes(item.receivedBytes)} / ${_formatBytes(total)}` : _formatBytes(item.receivedBytes);
      status.textContent = `${stateText}${sizeText ? ` - ${sizeText}` : ''}`;
      main.appendChild(status);

      const track = document.createElement('div');
      track.className = 'ws-browser-download-progress';
      const fill = document.createElement('div');
      fill.style.width = item.state === 'completed' ? '100%' : `${pct}%`;
      track.appendChild(fill);
      main.appendChild(track);
      row.appendChild(main);

      const actions = document.createElement('div');
      actions.className = 'ws-browser-download-actions';
      if (item.state === 'completed') {
        const openBtn = this._downloadActionButton('Open', () => this._openDownload(item));
        const locateBtn = this._downloadActionButton('Locate', () => this._locateDownload(item));
        const agentBtn = this._downloadActionButton('Agent', () => this._sendDownloadToAgent(item));
        actions.append(openBtn, locateBtn, agentBtn);
      }
      row.appendChild(actions);
      box.appendChild(row);
    }
  }

  private _downloadActionButton(label: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-browser-download-action';
    btn.textContent = label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); action(); });
    return btn;
  }

  private _openDownload(item: BrowserDownloadEvent): void {
    if (item.relativePath) {
      this.onOpenFile?.(item.relativePath, item.filename || item.relativePath.split('/').pop() || 'download');
      return;
    }
    if (item.savePath) void this._api()?.openPath?.(item.savePath);
  }

  private _locateDownload(item: BrowserDownloadEvent): void {
    const path = item.relativePath;
    if (!path) {
      if (item.savePath) void this._api()?.openPath?.(item.savePath);
      return;
    }
    window.dispatchEvent(new CustomEvent('ws-reveal-workspace-path', { detail: { path, open: false } }));
  }

  private _sendDownloadToAgent(item: BrowserDownloadEvent): void {
    const lines = [
      '[Workspace Download]',
      `File: ${item.relativePath || item.filename}`,
      item.url ? `Source: ${item.url}` : '',
      item.savePath ? `Saved: ${item.savePath}` : '',
    ].filter(Boolean);
    this._sendToAgent(lines.join('\n'));
  }

  private _handleBrowserNetwork(event: BrowserNetworkEvent): void {
    const tab = this._tabs.find(t => t.wvId === event.viewId);
    if (!tab) return;
    const events = [...(tab.networkEvents || [])];
    const idx = events.findIndex(item => item.id === event.id);
    if (idx >= 0) events[idx] = event;
    else events.push(event);
    tab.networkEvents = events.slice(-200);
    if (tab.path === this._activePath) this._renderBrowserPanel(tab);
  }

  private _handleBrowserSecurity(event: BrowserSecurityEvent): void {
    const tab = this._tabs.find(t => t.wvId === event.viewId);
    if (!tab) return;
    const events = [...(tab.securityEvents || [])];
    const idx = events.findIndex(item => item.id === event.id);
    if (idx >= 0) events[idx] = event;
    else events.push(event);
    tab.securityEvents = events.slice(-120);
    if (tab.path === this._activePath) {
      this._renderSecurityPrompts(tab);
      this._renderBrowserPanel(tab);
    }
  }

  private _handleBrowserFindResult(event: BrowserFindResult): void {
    const tab = this._tabs.find(t => t.wvId === event.viewId);
    if (!tab) return;
    tab.findMatches = event.matches;
    tab.findActiveMatch = event.activeMatchOrdinal;
    if (tab.path === this._activePath) this._renderFindBar(tab);
  }

  private _showFindBar(tab: OpenTab): void {
    tab.findVisible = true;
    if (tab.path === this._activePath) {
      this._renderFindBar(tab);
      setTimeout(() => {
        const input = this._contentArea.querySelector('.ws-browser-find-input') as HTMLInputElement | null;
        input?.focus();
        input?.select();
      }, 0);
    }
  }

  private _renderFindBar(tab: OpenTab): void {
    const bar = this._contentArea.querySelector('.ws-browser-findbar') as HTMLElement | null;
    if (!bar || tab.fileType !== 'browser') return;
    bar.innerHTML = '';
    if (!tab.findVisible) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';

    const input = document.createElement('input');
    input.className = 'ws-browser-find-input';
    input.type = 'text';
    input.placeholder = 'Find';
    input.value = tab.findQuery || '';
    input.addEventListener('input', () => {
      tab.findQuery = input.value;
      tab.findMatches = 0;
      tab.findActiveMatch = 0;
      if (this._findInputTimer) window.clearTimeout(this._findInputTimer);
      this._findInputTimer = window.setTimeout(() => this._runFind(tab, true, false), 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._runFind(tab, !e.shiftKey, true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeFindBar(tab);
      }
    });
    bar.appendChild(input);

    const count = document.createElement('span');
    count.className = 'ws-browser-find-count';
    const matches = tab.findMatches || 0;
    const active = tab.findActiveMatch || 0;
    count.textContent = matches ? `${active}/${matches}` : '0/0';
    bar.appendChild(count);

    const prev = this._smallCommandButton('Prev', () => this._runFind(tab, false, true));
    const next = this._smallCommandButton('Next', () => this._runFind(tab, true, true));
    const matchCase = this._smallCommandButton('Aa', () => {
      tab.findMatchCase = !tab.findMatchCase;
      this._runFind(tab, true, false);
      this._renderFindBar(tab);
    });
    matchCase.classList.toggle('active', Boolean(tab.findMatchCase));
    const close = this._smallCommandButton('Close', () => this._closeFindBar(tab));
    bar.append(prev, next, matchCase, close);
  }

  private _smallCommandButton(label: string, action: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-browser-command-btn';
    btn.textContent = label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); action(); });
    return btn;
  }

  private _runFind(tab: OpenTab, forward: boolean, findNext: boolean): void {
    if (!tab.wvId) return;
    const text = (tab.findQuery || '').trim();
    if (!text) {
      tab.findMatches = 0;
      tab.findActiveMatch = 0;
      void this._api()?.wvStopFind?.(tab.wvId, 'clearSelection');
      this._renderFindBar(tab);
      return;
    }
    void this._api()?.wvFindInPage?.(tab.wvId, text, { forward, findNext, matchCase: Boolean(tab.findMatchCase) });
  }

  private _closeFindBar(tab: OpenTab): void {
    tab.findVisible = false;
    tab.findQuery = '';
    tab.findMatches = 0;
    tab.findActiveMatch = 0;
    if (tab.wvId) void this._api()?.wvStopFind?.(tab.wvId, 'clearSelection');
    this._renderFindBar(tab);
    setTimeout(() => this._syncWvBounds(), 0);
  }

  private _renderSecurityPrompts(tab: OpenTab): void {
    const box = this._contentArea.querySelector('.ws-browser-security') as HTMLElement | null;
    if (!box || tab.fileType !== 'browser') return;
    const events = (tab.securityEvents || [])
      .filter(event => event.decision === 'prompt' || event.kind === 'certificate' || event.kind === 'external' || event.kind === 'popup')
      .slice(-3)
      .reverse();
    box.innerHTML = '';
    if (!events.length) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'flex';
    for (const event of events) {
      const row = document.createElement('div');
      row.className = `ws-browser-security-row ${event.decision}`;
      const text = document.createElement('div');
      text.className = 'ws-browser-security-text';
      text.textContent = event.message;
      text.title = event.url || event.message;
      row.appendChild(text);
      if (event.decision === 'prompt') {
        const allow = this._smallCommandButton('Allow', () => this._resolvePermission(event.id, true));
        const block = this._smallCommandButton('Block', () => this._resolvePermission(event.id, false));
        row.append(allow, block);
      }
      box.appendChild(row);
    }
  }

  private _resolvePermission(eventId: string, allowed: boolean): void {
    void this._api()?.wvResolvePermission?.(eventId, allowed);
  }

  private async _hydrateBrowserPanel(tab: OpenTab): Promise<void> {
    if (!tab.wvId) return;
    try {
      const [network, logs, security] = await Promise.all([
        this._api()?.wvGetNetwork?.(tab.wvId, 120),
        this._api()?.wvGetConsole?.(tab.wvId, 120),
        this._api()?.wvGetSecurity?.(tab.wvId, 80),
      ]);
      if (Array.isArray(network?.events)) tab.networkEvents = network.events;
      if (Array.isArray(logs?.logs)) tab.consoleLogs = logs.logs;
      if (Array.isArray(security?.events)) tab.securityEvents = security.events;
      if (tab.path === this._activePath) {
        this._renderSecurityPrompts(tab);
        this._renderBrowserPanel(tab);
      }
    } catch { console.debug('WorkspaceTabGroup: browser panel hydrate failed'); }
  }

  private async _toggleBrowserPanel(tab: OpenTab, mode: BrowserPanelMode): Promise<void> {
    tab.browserPanel = tab.browserPanel === mode ? null : mode;
    await this._hydrateBrowserPanel(tab);
    this._renderBrowserPanel(tab);
    setTimeout(() => this._syncWvBounds(), 0);
  }

  private _switchBrowserPanel(tab: OpenTab, mode: BrowserPanelMode): void {
    tab.browserPanel = mode;
    this._renderBrowserPanel(tab);
    setTimeout(() => this._syncWvBounds(), 0);
  }

  private _renderBrowserPanel(tab: OpenTab): void {
    const panel = this._contentArea.querySelector('.ws-browser-panel') as HTMLElement | null;
    if (!panel || tab.fileType !== 'browser') return;
    panel.innerHTML = '';
    if (!tab.browserPanel) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'flex';

    const header = document.createElement('div');
    header.className = 'ws-browser-panel-header';
    for (const mode of ['network', 'console', 'security'] as BrowserPanelMode[]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-browser-panel-tab';
      btn.classList.toggle('active', tab.browserPanel === mode);
      btn.textContent = mode === 'network' ? 'Network' : mode === 'console' ? 'Console' : 'Security';
      btn.addEventListener('click', () => this._switchBrowserPanel(tab, mode));
      header.appendChild(btn);
    }
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    header.appendChild(spacer);
    header.appendChild(this._smallCommandButton('Close', () => { tab.browserPanel = null; this._renderBrowserPanel(tab); setTimeout(() => this._syncWvBounds(), 0); }));
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'ws-browser-panel-body';
    panel.appendChild(body);
    if (tab.browserPanel === 'network') this._renderNetworkRows(tab, body);
    if (tab.browserPanel === 'console') this._renderConsoleRows(tab, body);
    if (tab.browserPanel === 'security') this._renderSecurityRows(tab, body);
  }

  private _renderNetworkRows(tab: OpenTab, body: HTMLElement): void {
    const rows = (tab.networkEvents || []).slice(-80).reverse();
    if (!rows.length) { this._renderPanelEmpty(body, 'No network activity yet'); return; }
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = `ws-browser-panel-row ${item.state === 'failed' ? 'error' : ''}`;
      const status = item.state === 'failed' ? 'ERR' : item.statusCode ? String(item.statusCode) : item.state.toUpperCase();
      this._appendPanelCell(row, item.method || 'GET', 'method');
      this._appendPanelCell(row, status, 'status');
      this._appendPanelCell(row, item.resourceType || 'other', 'type');
      this._appendPanelCell(row, _compactUrl(item.url), 'url');
      this._appendPanelCell(row, item.durationMs !== undefined ? `${item.durationMs}ms` : '', 'time');
      row.title = item.error || item.url;
      body.appendChild(row);
    }
  }

  private _renderConsoleRows(tab: OpenTab, body: HTMLElement): void {
    const rows = (tab.consoleLogs || []).slice(-100).reverse();
    if (!rows.length) { this._renderPanelEmpty(body, 'No console output yet'); return; }
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = `ws-browser-panel-row ${item.level === 'error' ? 'error' : item.level === 'warning' || item.level === 'warn' ? 'warn' : ''}`;
      this._appendPanelCell(row, item.level || 'log', 'method');
      this._appendPanelCell(row, item.message || '', 'url');
      this._appendPanelCell(row, item.sourceId ? `${_compactUrl(item.sourceId)}${item.line ? ':' + item.line : ''}` : '', 'time');
      body.appendChild(row);
    }
  }

  private _renderSecurityRows(tab: OpenTab, body: HTMLElement): void {
    const rows = (tab.securityEvents || []).slice(-80).reverse();
    if (!rows.length) { this._renderPanelEmpty(body, 'No security events yet'); return; }
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = `ws-browser-panel-row ${item.decision === 'blocked' ? 'warn' : ''}`;
      this._appendPanelCell(row, item.kind, 'method');
      this._appendPanelCell(row, item.decision, 'status');
      this._appendPanelCell(row, item.message, 'url');
      if (item.decision === 'prompt') {
        const actions = document.createElement('div');
        actions.className = 'ws-browser-panel-actions';
        actions.append(this._smallCommandButton('Allow', () => this._resolvePermission(item.id, true)));
        actions.append(this._smallCommandButton('Block', () => this._resolvePermission(item.id, false)));
        row.appendChild(actions);
      }
      row.title = item.url || item.message;
      body.appendChild(row);
    }
  }

  private _appendPanelCell(row: HTMLElement, text: string, cls: string): void {
    const cell = document.createElement('span');
    cell.className = `ws-browser-panel-cell ${cls}`;
    cell.textContent = text;
    row.appendChild(cell);
  }

  private _renderPanelEmpty(body: HTMLElement, text: string): void {
    const empty = document.createElement('div');
    empty.className = 'ws-browser-panel-empty';
    empty.textContent = text;
    body.appendChild(empty);
  }

  private _showViewportMenu(anchor: HTMLElement, tab: OpenTab): void {
    this._closeAllMenus();
    const menu = document.createElement('div');
    menu.className = 'ws-browser-menu ws-browser-viewport-menu';
    for (const preset of BROWSER_VIEWPORT_PRESETS) {
      const item = document.createElement('div');
      item.className = 'ws-browser-menu-item';
      item.textContent = preset.width && preset.height ? `${preset.label} ${preset.width}x${preset.height}` : preset.label;
      item.addEventListener('click', () => {
        this._closeAllMenus();
        void this._setViewportPreset(tab, preset);
      });
      menu.appendChild(item);
    }
    anchor.appendChild(menu);
    (this as any)._openMenu = menu;
    setTimeout(() => document.addEventListener('click', () => this._closeAllMenus(), { once: true }), 0);
  }

  private async _setViewportPreset(tab: OpenTab, preset: BrowserViewportPreset): Promise<void> {
    tab.browserViewport = preset;
    if (tab.wvId) await this._api()?.wvSetViewport?.(tab.wvId, _viewportPayload(preset));
    this._scheduleBrowserStateSave();
    if (tab.path === this._activePath) {
      const btn = this._contentArea.querySelector('.ws-browser-viewport-btn') as HTMLButtonElement | null;
      if (btn) btn.title = preset.label;
    }
  }

  private _browserBtn(title: string, icon: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'ws-browser-nav-btn ws-browser-action';
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = icon;
    return btn;
  }

  private _normalizeBrowserInput(value: string): string {
    if (!value) return '';
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
    if (/^[\w.-]+:\d+(\/.*)?$/i.test(value)) return `http://${value}`;
    if (/\s/.test(value) || !value.includes('.')) return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
    return `https://${value}`;
  }

  private _applyBrowserState(tab: OpenTab, data: BrowserStateEvent): void {
    if (typeof data.url === 'string' && data.url) this._updateBrowserTabUrl(tab, data.url);
    if (typeof data.canGoBack === 'boolean') tab.browserCanGoBack = data.canGoBack;
    if (typeof data.canGoForward === 'boolean') tab.browserCanGoForward = data.canGoForward;
    if (typeof data.isLoading === 'boolean') tab.browserLoading = data.isLoading;
    if (typeof data.zoomFactor === 'number') tab.browserZoomFactor = data.zoomFactor;
    this._updateBrowserChrome(tab);
  }

  private _updateBrowserChrome(tab: OpenTab): void {
    if (tab.path !== this._activePath || tab.fileType !== 'browser') return;
    const input = this._contentArea.querySelector('.ws-browser-url') as HTMLInputElement | null;
    if (input && document.activeElement !== input) {
      input.value = tab.browserUrl && tab.browserUrl !== 'about:blank' ? tab.browserUrl : '';
    }
    const sslIcon = this._contentArea.querySelector('.ws-browser-ssl-icon') as HTMLElement | null;
    if (sslIcon) sslIcon.innerHTML = tab.browserUrl?.startsWith('https://') ? _SVG_BROWSER_LOCK : '';

    const back = this._contentArea.querySelector('[data-action="back"]') as HTMLButtonElement | null;
    const forward = this._contentArea.querySelector('[data-action="forward"]') as HTMLButtonElement | null;
    if (back) back.disabled = !tab.browserCanGoBack;
    if (forward) forward.disabled = !tab.browserCanGoForward;

    this._updateBrowserLoading(tab);
  }

  private _shareUrlWithAgent(tab: OpenTab): void {
    const url = tab.browserUrl || '';
    if (!url || url === 'about:blank') return;
    this._sendToAgent(`[Browser: ${url}]\n`);
  }

  private _showAddToChatMenu(anchor: HTMLElement, tab: OpenTab): void {
    this._closeAllMenus();
    const menu = document.createElement('div');
    menu.className = 'ws-browser-menu';
    menu.innerHTML = `
      <div class="ws-browser-menu-item" data-action="add-page-context">Add Page Context to Chat</div>
      <div class="ws-browser-menu-item" data-action="add-element">Add Element to Chat</div>
      <div class="ws-browser-menu-item" data-action="add-console">Add Console Logs to Chat</div>
      <div class="ws-browser-menu-item" data-action="add-screenshot">Add Screenshot to Chat</div>
      <div class="ws-browser-menu-item" data-action="add-area-screenshot">Add Area Screenshot to Chat</div>`;
    anchor.appendChild(menu);
    (this as any)._openMenu = menu;

    menu.querySelector('[data-action="add-page-context"]')?.addEventListener('click', () => { this._closeAllMenus(); void this._sendPageContextToAgent(tab); });
    menu.querySelector('[data-action="add-element"]')?.addEventListener('click', () => { this._closeAllMenus(); this._addElementToChat(tab); });
    menu.querySelector('[data-action="add-console"]')?.addEventListener('click', () => { this._closeAllMenus(); this._addConsoleToChat(tab); });
    menu.querySelector('[data-action="add-screenshot"]')?.addEventListener('click', () => { this._closeAllMenus(); this._addScreenshotToChat(tab, false); });
    menu.querySelector('[data-action="add-area-screenshot"]')?.addEventListener('click', () => { this._closeAllMenus(); this._addScreenshotToChat(tab, true); });

    setTimeout(() => document.addEventListener('click', () => this._closeAllMenus(), { once: true }), 0);
  }

  private _showBrowserMoreMenu(anchor: HTMLElement, tab: OpenTab): void {
    this._closeAllMenus();
    const menu = document.createElement('div');
    menu.className = 'ws-browser-menu';
    menu.innerHTML = `
      <div class="ws-browser-menu-item" data-action="zoom-in">Zoom In</div>
      <div class="ws-browser-menu-item" data-action="zoom-out">Zoom Out</div>
      <div class="ws-browser-menu-item" data-action="zoom-reset">Reset Zoom</div>
      <div class="ws-browser-menu-divider"></div>
      <div class="ws-browser-menu-item" data-action="find">Find in Page</div>
      <div class="ws-browser-menu-item" data-action="view-source">View Page Source</div>`;
    anchor.appendChild(menu);
    (this as any)._openMenu = menu;

    menu.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => { this._closeAllMenus(); this._wvZoom(tab, 0.5); });
    menu.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => { this._closeAllMenus(); this._wvZoom(tab, -0.5); });
    menu.querySelector('[data-action="zoom-reset"]')?.addEventListener('click', () => { this._closeAllMenus(); this._wvZoomReset(tab); });
    menu.querySelector('[data-action="find"]')?.addEventListener('click', () => { this._closeAllMenus(); this._wvFind(tab); });
    menu.querySelector('[data-action="view-source"]')?.addEventListener('click', () => { this._closeAllMenus(); this._wvViewSource(tab); });

    setTimeout(() => document.addEventListener('click', () => this._closeAllMenus(), { once: true }), 0);
  }

  private _closeAllMenus(): void {
    if ((this as any)._openMenu) { (this as any)._openMenu.remove(); (this as any)._openMenu = null; }
  }

  private _sendToAgent(content: string, attachments: { name: string; path: string; type: string; size: number; content?: string }[] = []): void {
    const app = (window as any).__anoclawApp;
    if (!app) return;
    const sid = app.sessionVM?.activeSessionId;
    if (!sid) return;
    const agent = app.conversationVM?.getAgent(sid);
    if (agent) {
      agent.sendMessage(content, app.conversationVM.permissionMode, app.conversationVM.effortMode, attachments).catch(() => {});
    }
  }

  private _sendImageToAgent(dataUrl: string): void {
    const app = (window as any).__anoclawApp;
    if (!app) return;
    app.conversationVM?.addAttachment({ name: 'screenshot.png', path: '', type: 'image', size: 0, content: dataUrl });
  }

  private async _sendPageContextToAgent(tab: OpenTab): Promise<void> {
    if (!tab.wvId) {
      this._shareUrlWithAgent(tab);
      return;
    }

    const code = `
      (() => {
        const limit = (value, max) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
        const textLimit = (value, max) => String(value || '').replace(/\\r/g, '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, max);
        const selectorFor = (el) => {
          if (!el || !el.tagName) return '';
          if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
          const cls = String(el.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
          return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
        };
        const main = document.querySelector('main,[role="main"],article') || document.body || document.documentElement;
        const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        const selectedText = String(window.getSelection ? window.getSelection() : '').trim();
        const headings = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 12).map((el) => ({
          level: el.tagName.toLowerCase(),
          text: limit(el.textContent, 180),
        })).filter((item) => item.text);
        return JSON.stringify({
          title: document.title || '',
          url: location.href,
          description: limit(document.querySelector('meta[name="description"]')?.getAttribute('content'), 500),
          selectedText: textLimit(selectedText, 1500),
          headings,
          bodyText: textLimit((document.body && document.body.innerText) || '', 4500),
          domSnippet: String((main && main.outerHTML) || document.documentElement.outerHTML || '').slice(0, 2500),
          activeElement: active ? {
            selector: selectorFor(active),
            text: textLimit(active.innerText || active.value || active.textContent || '', 1000),
            html: String(active.outerHTML || '').slice(0, 1800),
          } : null,
          counts: {
            links: document.links.length,
            buttons: document.querySelectorAll('button,[role="button"]').length,
            inputs: document.querySelectorAll('input,textarea,select').length,
            images: document.images.length,
          },
        });
      })()
    `;

    let page: any = null;
    try {
      const result = await this._api()?.wvExecJs?.(tab.wvId, code);
      const raw = result?.result;
      page = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      page = null;
    }
    if (!page) {
      this._shareUrlWithAgent(tab);
      return;
    }

    const consoleResult = await this._api()?.wvGetConsole?.(tab.wvId, 30);
    const logs = Array.isArray(consoleResult?.logs) ? consoleResult.logs as BrowserConsoleLog[] : [];
    const screenshot = await this._api()?.wvCaptureScreenshot?.(tab.wvId);
    const attachments = screenshot?.ok && screenshot.dataUrl
      ? [{ name: 'browser-screenshot.png', path: '', type: 'image', size: 0, content: screenshot.dataUrl }]
      : [];

    const headings = Array.isArray(page.headings) && page.headings.length
      ? page.headings.map((h: { level: string; text: string }) => `- ${h.level}: ${h.text}`).join('\n')
      : '(none)';
    const counts = page.counts || {};
    const activeElement = page.activeElement
      ? [
          `Selector: ${page.activeElement.selector || '(unknown)'}`,
          page.activeElement.text ? `Text: ${page.activeElement.text}` : '',
          page.activeElement.html ? `HTML:\n\`\`\`html\n${_safeFence(page.activeElement.html)}\n\`\`\`` : '',
        ].filter(Boolean).join('\n')
      : '(none)';

    const content = [
      '[Browser Page Context]',
      `URL: ${page.url || tab.browserUrl || ''}`,
      `Title: ${page.title || tab.browserTitle || tab.name || ''}`,
      page.description ? `Description: ${page.description}` : '',
      `Elements: links=${counts.links ?? 0}, buttons=${counts.buttons ?? 0}, inputs=${counts.inputs ?? 0}, images=${counts.images ?? 0}`,
      '',
      'Selected Text:',
      page.selectedText || '(none)',
      '',
      'Headings:',
      headings,
      '',
      'Body Excerpt:',
      page.bodyText || '(empty)',
      '',
      'Active Element:',
      activeElement,
      '',
      'DOM Snippet:',
      `\`\`\`html\n${_safeFence(page.domSnippet || '')}\n\`\`\``,
      '',
      'Recent Console:',
      this._formatConsoleLogs(logs),
    ].filter(line => line !== '').join('\n');

    this._sendToAgent(content, attachments);
  }

  private _formatConsoleLogs(logs: BrowserConsoleLog[]): string {
    if (!logs.length) return '(none)';
    return logs.slice(-20).map(log => {
      const source = log.sourceId ? ` ${log.sourceId}${log.line ? ':' + log.line : ''}` : '';
      return `[${log.level}]${source} ${log.message}`;
    }).join('\n');
  }

  private async _addElementToChat(tab: OpenTab): Promise<void> {
    // Inject element picker JS into the page
    const code = `
      (function() {
        if (window.__anoclawPicker) return;
        window.__anoclawPicker = true;
        let hoverEl = null;
        const onMove = (e) => {
          if (hoverEl) hoverEl.style.outline = hoverEl.__anoclawPrevOutline || '';
          hoverEl = e.target;
          hoverEl.__anoclawPrevOutline = hoverEl.style.outline;
          hoverEl.style.outline = '2px solid #ffc533';
        };
        const onClick = (e) => {
          e.preventDefault(); e.stopPropagation();
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('click', onClick, true);
          window.__anoclawElem = { tag: e.target.tagName, id: e.target.id, class: e.target.className, text: e.target.textContent?.substring(0,200) };
          document.title = '__ANOCLAW_DONE__';
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.title = '__ANOCLAW_PICKING__';
      })();
    `;
    await this._api()?.wvExecJs?.(tab.wvId, code);

    // Poll for picked element
    const interval = setInterval(async () => {
      try {
        const result = await this._api()?.wvExecJs?.(tab.wvId, 'JSON.stringify(window.__anoclawElem)');
        if (result?.ok && result.result !== 'undefined') {
          clearInterval(interval);
          const el = JSON.parse(result.result);
          this._sendToAgent(`[Browser Element] ${el.tag}${el.id ? '#' + el.id : ''}${el.class ? '.' + el.class.split(' ').join('.') : ''}: "${el.text}"`);
        }
      } catch { console.debug('WorkspaceTabGroup: browser element extraction failed'); }
    }, 500);
    setTimeout(() => clearInterval(interval), 15000);
  }

  private async _addConsoleToChat(tab: OpenTab): Promise<void> {
    const result = await this._api()?.wvGetConsole?.(tab.wvId, 80);
    const logs = Array.isArray(result?.logs) ? result.logs as BrowserConsoleLog[] : [];
    if (logs.length > 0) this._sendToAgent(`[Browser Console]\n${this._formatConsoleLogs(logs)}`);
  }

  private async _addScreenshotToChat(tab: OpenTab, area: boolean): Promise<void> {
    const rect = area ? undefined : undefined; // Full page for now, area mode toggles a draggable overlay
    const result = await this._api()?.wvCaptureScreenshot?.(tab.wvId, rect);
    if (result?.ok && result.dataUrl) {
      this._sendImageToAgent(result.dataUrl);
    }
  }

  private async _wvZoom(tab: OpenTab, delta: number): Promise<void> {
    const next = Math.max(0.25, Math.min(3, (tab.browserZoomFactor || 1) + delta));
    tab.browserZoomFactor = next;
    await this._api()?.wvSetZoom?.(tab.wvId, next);
    this._scheduleBrowserStateSave();
  }

  private async _wvZoomReset(tab: OpenTab): Promise<void> {
    tab.browserZoomFactor = 1;
    await this._api()?.wvSetZoom?.(tab.wvId, 1);
    this._scheduleBrowserStateSave();
  }

  private async _wvFind(tab: OpenTab): Promise<void> {
    this._showFindBar(tab);
  }

  private async _wvViewSource(tab: OpenTab): Promise<void> {
    await this._api()?.wvExecJs?.(tab.wvId, 'document.location.href="view-source:"+document.location.href');
  }

  private _ctxPollTimer: ReturnType<typeof setInterval> | null = null;

  private _startContextPoll(tab: OpenTab): void {
    this._stopContextPoll();
    this._ctxPollTimer = setInterval(async () => {
      if (!tab.wvId) return;
      // Poll for __anoclawCtxResult — set by in-page overlay when user clicks an action
      const r = await this._api()?.wvExecJs?.(tab.wvId,
        '(function(){var v=window.__anoclawCtxResult;window.__anoclawCtxResult=null;return v;})()');
      if (!r?.ok || !r.result) return;
      const raw = r.result;
      if (typeof raw !== 'string') return;
      try {
        const data = JSON.parse(raw);
        this._handleContextAction(data, tab);
      } catch { console.debug('WorkspaceTabGroup: context action parse failed'); }
    }, 400);
  }

  private _stopContextPoll(): void {
    if (this._ctxPollTimer) { clearInterval(this._ctxPollTimer); this._ctxPollTimer = null; }
  }

  private _handleContextAction(data: {
    type: string; text?: string; url?: string; selector?: string;
    title?: string; tag?: string; id?: string; class?: string;
    action?: string; href?: string; src?: string; html?: string;
  }, tab: OpenTab): void {
    const info = `[Browser Element]\nURL: ${data.url || tab.browserUrl}\nTitle: ${data.title || ''}\nElement: ${data.tag}${data.id?'#'+data.id:''}${data.class?'.'+data.class.split(' ').slice(0,3).join('.'):''}`;

    switch (data.action) {
      case 'add-info':
        this._sendToAgent(`${info}\nText: "${data.text}"\nHref: ${data.href}\nSrc: ${data.src}`);
        break;
      case 'add-text':
        this._sendToAgent(`${info}\nText Content: "${data.text}"`);
        break;
      case 'add-html':
        this._sendToAgent(`${info}\nOuter HTML:\n\`\`\`html\n${data.html}\n\`\`\``);
        break;
      case 'screenshot':
        this._addScreenshotToChat(tab, false);
        break;
      case 'inspect':
        this._api()?.wvExecJs?.(tab.wvId,
          `(()=>{var e=document.querySelector('${data.tag+(data.id?'#'+data.id:'')+(data.class?'.'+data.class.split(' ').join('.'):'')}');if(e){e.style.outline='2px solid #ffc533';setTimeout(()=>e.style.outline='',2000);e.scrollIntoView({behavior:'smooth',block:'center'});}})()`);
        break;
    }
  }

  private _syncWvBounds(): void {
    if (!this._lastWvId) return;
    const placeholder = this._contentArea.querySelector('[data-wv-view]') as HTMLElement;
    if (!placeholder) return;
    const r = placeholder.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    this._api()?.wvSetBounds?.(this._lastWvId, r.left, r.top, r.width, r.height);
  }

  private _destroyBrowserView(): void {
    this._stopContextPoll();
    this._closeAllMenus();
    // Hide old view before switching away
    if (this._lastWvId) { this._api()?.wvSetBounds?.(this._lastWvId, -1, -1, 0, 0); }
    this._lastWvId = null;
  }

  private _updateBrowserLoading(tab: OpenTab): void {
    const progressBar = this._contentArea.querySelector('.ws-browser-progress') as HTMLElement;
    if (!progressBar) return;
    if (tab.browserLoading) {
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-primary,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
    } else {
      // Brief green flash to indicate done
      progressBar.innerHTML = '<div style="height:100%;width:100%;background:#4ade80;border-radius:1px;transition:opacity 0.5s;opacity:1;"></div>';
      setTimeout(() => { progressBar.innerHTML = ''; }, 500);
    }
  }

  private _updateTabFavicon(tab: OpenTab): void {
    const btn = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"]`) as HTMLElement;
    if (!btn || !tab.browserFavicon) return;
    let fav = btn.querySelector('.ws-tab-favicon') as HTMLImageElement;
    if (!fav) {
      fav = document.createElement('img');
      fav.className = 'ws-tab-favicon';
      fav.style.cssText = 'width:14px;height:14px;flex-shrink:0;margin-right:2px;';
      const nm = btn.querySelector('.ws-tab-name');
      if (nm) nm.before(fav);
    }
    fav.src = tab.browserFavicon;
  }

  private _showBinaryNotice(tab: OpenTab): void { this._destroyContent(); this._contentArea.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--color-text-secondary,#9c9c9d);font-size:13px;'; this._contentArea.innerHTML = `<div>${_escHtml(tab.name)}</div><div style="font-size:11px;opacity:0.5;">Binary file — cannot preview</div>`; }

  // ── Office document preview ──

  /**
   * Render Office document preview via server-side conversion.
   *
   * Calls GET /api/v1/workspace/convert-office which:
   * - .docx → mammoth library (HTML with tables, headings, images)
   * - .xlsx/.xlsm → pure-JS ZIP parser extracts sheet text
   * - .pptx/.pptm → slide text extraction from ppt/slides/slideN.xml
   * - .odt/.ods/.odp → OpenDocument content.xml text
   *
   * Three response shapes handled:
   * - `{type:'html'}` → rendered in a styled wrapper (tables, headings, images styled).
   * - `{type:'text'}` → displayed in a monospace `<pre>` block.
   * - `{type:'image'}` → shown as a full-size image (e.g. chart embedded in xlsx).
   *
   * Falls back to "Preview not available" on conversion error.
   *
   * @param tab - The OpenTab with fileType 'docx' / 'xlsx' / 'pptx'.
   */
  private async _showOffice(tab: OpenTab): Promise<void> {
    this._destroyContent();
    this._contentArea.style.cssText = 'display:flex;align-items:center;justify-content:center;';
    this._contentArea.innerHTML = '<div style="color:var(--color-text-secondary,#9c9c9d);font-size:13px;">Loading preview...</div>';

    try {
      const resp = await fetch(`/api/v1/workspace/convert-office?path=${encodeURIComponent(tab.path)}&sessionId=${encodeURIComponent(this._sessionId)}`);
      if (!resp.ok) throw new Error('Conversion failed');
      const data = await resp.json();

      this._contentArea.innerHTML = '';
      this._contentArea.style.cssText = 'overflow-y:auto;';

      if (data.type === 'table' && Array.isArray(data.rows)) {
        this._showTablePreview(data.rows, tab.name);
      } else if (data.type === 'html') {
        const { sanitizeHtml } = await import('../../../MarkdownRenderer.js');
        const wrapper = document.createElement('div');
        wrapper.className = 'ws-preview-office';
        wrapper.style.cssText = 'padding:20px 28px;font-size:13px;line-height:1.7;color:var(--color-text,#f4f4f6);max-width:860px;margin:0 auto;';
        wrapper.innerHTML = sanitizeHtml(String(data.html || ''));
        // Style tables, headings, lists
        wrapper.querySelectorAll('table').forEach(t => {
          (t as HTMLElement).style.cssText = 'border-collapse:collapse;width:100%;margin:12px 0;';
        });
        wrapper.querySelectorAll('th,td').forEach(c => {
          (c as HTMLElement).style.cssText = 'border:1px solid var(--color-hairline,#242728);padding:6px 10px;text-align:left;';
        });
        wrapper.querySelectorAll('th').forEach(c => {
          (c as HTMLElement).style.background = 'var(--color-surface,#0d0d0d)';
        });
        wrapper.querySelectorAll('h1,h2,h3,h4').forEach(h => {
          (h as HTMLElement).style.cssText = 'margin:16px 0 8px;';
        });
        wrapper.querySelectorAll('img').forEach(img => {
          (img as HTMLElement).style.cssText = 'max-width:100%;border-radius:6px;';
        });
        this._contentArea.appendChild(wrapper);
      } else if (data.type === 'text') {
        const pre = document.createElement('pre');
        pre.style.cssText = 'padding:20px 28px;font-size:12px;line-height:1.6;color:var(--color-text,#f4f4f6);white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);';
        pre.textContent = data.content || 'No readable content found.';
        this._contentArea.appendChild(pre);
      } else if (data.type === 'image') {
        const img = document.createElement('img');
        img.className = 'ws-preview-image';
        img.src = data.dataUrl || this._rawFileUrl(tab.path);
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
        this._contentArea.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#0a0a0a;';
        this._contentArea.appendChild(img);
      }
    } catch {
      this._contentArea.innerHTML = `<div style="color:var(--color-text-secondary,#9c9c9d);font-size:13px;">${_escHtml(tab.name)}</div><div style="font-size:11px;opacity:0.5;margin-top:8px;">Preview not available</div>`;
      this._contentArea.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-direction:column;';
    }
  }

  // ── Save ──

  async saveActiveFile(): Promise<boolean> {
    const tab = this._tabs.find(t => t.path===this._activePath);
    return tab ? this.saveFile(tab) : true;
  }

  async saveFile(tab: OpenTab): Promise<boolean> {
    if (!tab.isDirty || tab.fileType!=='code') return true;
    if (tab.readOnlyReason) {
      ToastManager.getInstance().error(tab.readOnlyReason);
      return false;
    }
    try {
      const content = tab.model.getValue();
      const resp = await fetch('/api/v1/workspace/write', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sessionId:this._sessionId, path:tab.path, content}) });
      if (!resp.ok) throw new Error(await _responseError(resp, `Save failed (${resp.status})`));
      tab.originalContent = content;
      tab.isDirty = false; this._updateDirty(tab);
      return true;
    } catch (err) {
      ToastManager.getInstance().error(err instanceof Error ? err.message : `Failed to save ${tab.name}`);
      return false;
    }
  }

  private _updateDirty(tab: OpenTab): void { const btn = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"]`); if (btn) btn.classList.toggle('dirty', tab.isDirty); }

  get hasDirtyTabs(): boolean { return this._tabs.some(tab => tab.isDirty); }

  async prepareToDiscardAll(actionLabel: string): Promise<boolean> {
    for (const tab of this._tabs.filter(item => item.isDirty)) {
      const action = await this._promptDirtyAction(tab, actionLabel);
      if (action === 'cancel') return false;
      if (action === 'save' && !await this.saveFile(tab)) return false;
    }
    return true;
  }

  async prepareForPathRemoval(targetPath: string): Promise<boolean> {
    const impacted = this._tabs.filter(tab => _pathMatches(tab.path, targetPath) && tab.isDirty);
    for (const tab of impacted) {
      const action = await this._promptDirtyAction(tab, `deleting ${targetPath}`);
      if (action === 'cancel') return false;
      if (action === 'save' && !await this.saveFile(tab)) return false;
    }
    return true;
  }

  handlePathRenamed(oldPath: string, newPath: string): void {
    for (const tab of this._tabs) {
      if (!_pathMatches(tab.path, oldPath)) continue;
      const previousPath = tab.path;
      const suffix = previousPath === oldPath ? '' : previousPath.slice(oldPath.length);
      const nextPath = `${newPath}${suffix}`;
      const btn = this._tabBar.querySelector(`[data-tab-path="${_escAttr(previousPath)}"]`) as HTMLElement | null;
      tab.path = nextPath;
      tab.name = _baseName(nextPath);
      if (this._activePath === previousPath) this._activePath = nextPath;
      if (btn) {
        btn.setAttribute('data-tab-path', nextPath);
        btn.title = nextPath;
        const name = btn.querySelector('.ws-tab-name');
        if (name) name.textContent = tab.name;
      }
    }
    this._notifyContextChange();
  }

  handlePathDeleted(targetPath: string): void {
    const impacted = this._tabs.filter(tab => _pathMatches(tab.path, targetPath));
    for (const tab of impacted) {
      const idx = this._tabs.indexOf(tab);
      if (idx >= 0) this._doCloseTab(tab, idx);
    }
  }

  suspend(): void {
    this._saveBrowserStateNow();
    this._destroyBrowserView();
  }

  resume(): void {
    const active = this._tabs.find(tab => tab.path === this._activePath);
    if (active) this._activate(active);
  }

  // ── Agent integration: context menu + editor state ──

  private _agentActionsRegistered = false;
  private _inlineCompletionRegistered = false;

  private _registerAgentActions(): void {
    if (this._agentActionsRegistered) return;
    const m = (window as any).monaco; if (!m) return;
    this._agentActionsRegistered = true;

    // "Ask Agent about selection" — with selection
    m.editor.addEditorAction({
      id: 'anoclaw-ask-agent',
      label: 'Ask Agent',
      contextMenuGroupId: 'anoclaw-agent',
      contextMenuOrder: 1,
      run: (ed: any) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || '' : ''; this._dispatchAskAgent(text, 'Ask'); },
    });

    // "Agent: Explain This" — with or without selection
    m.editor.addEditorAction({
      id: 'anoclaw-explain-code',
      label: 'Agent: Explain This',
      contextMenuGroupId: 'anoclaw-agent',
      contextMenuOrder: 2,
      run: (ed: any) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || '' : ''; this._dispatchAskAgent(text, 'Explain'); },
    });

    // "Agent: Find Bugs" — with or without selection
    m.editor.addEditorAction({
      id: 'anoclaw-find-bugs',
      label: 'Agent: Find Bugs',
      contextMenuGroupId: 'anoclaw-agent',
      contextMenuOrder: 3,
      run: (ed: any) => { const sel = ed.getSelection(); const text = sel && !sel.isEmpty() ? ed.getModel()?.getValueInRange(sel) || '' : ''; this._dispatchAskAgent(text, 'FindBugs'); },
    });

    const aiKeybindings = m.KeyCode?.Backslash ? [m.KeyMod.Alt | m.KeyCode.Backslash] : undefined;
    m.editor.addEditorAction({
      id: 'anoclaw-ai-complete',
      label: 'AI: Complete at Cursor',
      keybindings: aiKeybindings,
      contextMenuGroupId: 'anoclaw-agent',
      contextMenuOrder: 0,
      run: () => { void this._triggerInlineCompletion(true); },
    });

    const goToDefinitionKey = m.KeyCode?.F12 ? [m.KeyCode.F12] : undefined;
    m.editor.addEditorAction({
      id: 'anoclaw-ls-definition',
      label: 'IDE: Go to Definition',
      keybindings: goToDefinitionKey,
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => { void this._goToDefinitionFromEditor(); },
    });

    const organizeKey = m.KeyCode?.KeyO ? [m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyO] : undefined;
    m.editor.addEditorAction({
      id: 'anoclaw-ls-organize-imports',
      label: 'IDE: Organize Imports',
      keybindings: organizeKey,
      contextMenuGroupId: 'anoclaw-agent',
      contextMenuOrder: 4,
      run: () => { void this._organizeImports(); },
    });
  }

  private _registerLanguageFeatures(): void {
    if (WorkspaceTabGroup._languageFeaturesRegistered) return;
    const m = (window as any).monaco; if (!m) return;
    WorkspaceTabGroup._languageFeaturesRegistered = true;
    const languages = ['typescript', 'javascript', 'python'];
    for (const language of languages) {
      m.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.', '"', '\'', '/', '@', '<'],
        provideCompletionItems: async (model: any, position: any) => {
          const group = WorkspaceTabGroup._groupForModel(model);
          if (!group) return { suggestions: [] };
          return group._provideLanguageCompletions(model, position);
        },
      });
      m.languages.registerHoverProvider(language, {
        provideHover: async (model: any, position: any) => {
          const group = WorkspaceTabGroup._groupForModel(model);
          if (!group) return null;
          return group._provideLanguageHover(model, position);
        },
      });
      m.languages.registerDefinitionProvider(language, {
        provideDefinition: async (model: any, position: any) => {
          const group = WorkspaceTabGroup._groupForModel(model);
          if (!group) return [];
          return group._provideLanguageDefinitions(model, position);
        },
      });
    }
  }

  private static _groupForModel(model: any): WorkspaceTabGroup | null {
    for (const group of WorkspaceTabGroup._groups) {
      if (group._tabs.some(tab => tab.model === model)) return group;
    }
    return null;
  }

  private _tabForModel(model: any): OpenTab | null {
    return this._tabs.find(tab => tab.model === model) || null;
  }

  private async _provideLanguageCompletions(model: any, position: any): Promise<{ suggestions: any[] }> {
    const m = (window as any).monaco;
    const tab = this._tabForModel(model);
    if (!tab) return { suggestions: [] };
    try {
      this._setLanguageStatus('working', 'LS Completing');
      const word = model.getWordUntilPosition(position);
      const fallbackRange = new m.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const data = await this._languageFetch('completions', model, position);
      const suggestions = (data.items || []).map((item: any) => ({
        label: item.label,
        kind: this._monacoCompletionKind(item.kind),
        detail: item.detail,
        documentation: item.documentation ? { value: item.documentation } : undefined,
        insertText: item.insertText || item.label,
        sortText: item.sortText,
        range: item.range ? this._monacoRange(item.range) : fallbackRange,
        additionalTextEdits: (item.additionalTextEdits || [])
          .filter((edit: any) => edit.path === tab.path)
          .map((edit: any) => ({ range: this._monacoRange(edit.range), text: edit.text })),
      }));
      this._setLanguageStatus('ready', suggestions.length ? `LS ${suggestions.length}` : 'LS Ready');
      return { suggestions };
    } catch {
      this._setLanguageStatus('error', 'LS Error');
      return { suggestions: [] };
    }
  }

  private async _provideLanguageHover(model: any, position: any): Promise<any | null> {
    try {
      const data = await this._languageFetch('hover', model, position);
      const hover = data.hover;
      if (!hover?.contents) return null;
      return {
        contents: [{ value: hover.contents }],
        range: hover.range ? this._monacoRange(hover.range) : undefined,
      };
    } catch {
      this._setLanguageStatus('error', 'LS Error');
      return null;
    }
  }

  private async _provideLanguageDefinitions(model: any, position: any): Promise<any[]> {
    const m = (window as any).monaco;
    try {
      const data = await this._languageFetch('definition', model, position);
      const locations = data.locations || [];
      return locations.map((loc: any) => ({
        uri: m.Uri.parse('file:///' + String(loc.absolutePath || loc.path).replace(/\\/g, '/')),
        range: this._monacoRange(loc.range),
      }));
    } catch {
      this._setLanguageStatus('error', 'LS Error');
      return [];
    }
  }

  private _scheduleDiagnostics(model: any, delay = 650): void {
    if (!model || !this._tabForModel(model)) return;
    if (this._diagnosticsTimer) window.clearTimeout(this._diagnosticsTimer);
    this._diagnosticsTimer = window.setTimeout(() => {
      this._diagnosticsTimer = 0;
      void this._refreshDiagnostics(model);
    }, delay);
  }

  private async _refreshDiagnostics(model: any): Promise<void> {
    const m = (window as any).monaco;
    const tab = this._tabForModel(model);
    if (!m || !tab) return;
    try {
      this._setLanguageStatus('working', 'LS Checking');
      const data = await this._languageFetch('diagnostics', model);
      const markers = (data.diagnostics || []).map((d: any) => ({
        severity: this._monacoMarkerSeverity(d.severity),
        message: d.message || '',
        source: d.source || 'language',
        code: d.code,
        startLineNumber: d.range?.startLineNumber || 1,
        startColumn: d.range?.startColumn || 1,
        endLineNumber: d.range?.endLineNumber || d.range?.startLineNumber || 1,
        endColumn: d.range?.endColumn || d.range?.startColumn || 2,
      }));
      m.editor.setModelMarkers(model, 'anoclaw-language', markers);
      this._setLanguageStatus('ready', markers.length ? `LS ${markers.length} issue${markers.length === 1 ? '' : 's'}` : 'LS Ready');
    } catch {
      this._setLanguageStatus('error', 'LS Error');
    }
  }

  private async _goToDefinitionFromEditor(): Promise<void> {
    if (!this._editor) return;
    const model = this._editor.getModel();
    const position = this._editor.getPosition();
    if (!model || !position) return;
    try {
      this._setLanguageStatus('working', 'LS Definition');
      const data = await this._languageFetch('definition', model, position);
      const target = (data.locations || []).find((loc: any) => !loc.external) || (data.locations || [])[0];
      if (!target) { this._setLanguageStatus('ready', 'LS No definition'); return; }
      if (target.external) { this._setLanguageStatus('ready', 'LS External'); return; }
      await this.openFile(target.path, _baseName(target.path));
      if (this._editor && target.range) {
        this._editor.setSelection(this._monacoRange(target.range));
        this._editor.revealLineInCenter(target.range.startLineNumber);
        this._editor.focus();
      }
      this._setLanguageStatus('ready', 'LS Definition');
    } catch {
      this._setLanguageStatus('error', 'LS Error');
    }
  }

  private async _organizeImports(): Promise<void> {
    if (!this._editor) return;
    const model = this._editor.getModel();
    if (!model || !this._tabForModel(model)) return;
    try {
      this._setLanguageStatus('working', 'LS Imports');
      const data = await this._languageFetch('organize-imports', model);
      const edits = (data.edits || [])
        .filter((edit: any) => edit.path === this._tabForModel(model)?.path)
        .sort((a: any, b: any) => {
          if (a.range.startLineNumber !== b.range.startLineNumber) return b.range.startLineNumber - a.range.startLineNumber;
          return b.range.startColumn - a.range.startColumn;
        })
        .map((edit: any) => ({ range: this._monacoRange(edit.range), text: edit.text, forceMoveMarkers: true }));
      if (edits.length) this._editor.executeEdits('anoclaw-organize-imports', edits);
      this._setLanguageStatus('ready', edits.length ? 'LS Imports done' : 'LS Imports clean');
      this._editor.focus();
    } catch {
      this._setLanguageStatus('error', 'LS Error');
    }
  }

  private async _languageFetch(operation: string, model: any, position?: any): Promise<any> {
    const tab = this._tabForModel(model);
    if (!tab) throw new Error('No workspace tab for model');
    const endpoint = LANGUAGE_ENDPOINTS[operation];
    if (!endpoint) throw new Error(`Unsupported language operation: ${operation}`);
    const body = {
      sessionId: this._sessionId,
      path: tab.path,
      content: model.getValue(),
      language: model.getLanguageId(),
      line: position?.lineNumber || 1,
      column: position?.column || 1,
    };
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `Language service failed (${resp.status})`);
    return data;
  }

  private _monacoCompletionKind(kind: string): number {
    const m = (window as any).monaco;
    const K = m?.languages?.CompletionItemKind || {};
    const key = String(kind || '').toLowerCase();
    if (key.includes('method')) return K.Method;
    if (key.includes('function')) return K.Function;
    if (key.includes('constructor')) return K.Constructor;
    if (key.includes('field')) return K.Field;
    if (key.includes('property')) return K.Property;
    if (key.includes('variable')) return K.Variable;
    if (key.includes('class')) return K.Class;
    if (key.includes('interface')) return K.Interface;
    if (key.includes('module')) return K.Module;
    if (key.includes('enum')) return K.Enum;
    if (key.includes('keyword')) return K.Keyword;
    if (key.includes('snippet')) return K.Snippet;
    if (key.includes('file')) return K.File;
    if (key.includes('constant')) return K.Constant;
    if (key.includes('type')) return K.TypeParameter;
    return K.Text;
  }

  private _monacoMarkerSeverity(severity: string): number {
    const m = (window as any).monaco;
    const S = m?.MarkerSeverity || {};
    if (severity === 'error') return S.Error;
    if (severity === 'warning') return S.Warning;
    if (severity === 'hint') return S.Hint;
    return S.Info;
  }

  private _monacoRange(range: any): any {
    const m = (window as any).monaco;
    return new m.Range(
      range.startLineNumber || 1,
      range.startColumn || 1,
      range.endLineNumber || range.startLineNumber || 1,
      range.endColumn || range.startColumn || 1,
    );
  }

  private _setLanguageStatus(state: typeof this._languageStatusState, message: string): void {
    this._languageStatusState = state;
    this._languageStatusMessage = message;
    this._renderLanguageStatus();
    if (state === 'ready') {
      window.setTimeout(() => {
        if (this._languageStatusState === state && this._languageStatusMessage === message) {
          this._setLanguageStatus('idle', 'LS Ready');
        }
      }, 2600);
    }
  }

  private _renderLanguageStatus(): void {
    const el = this._contentArea.querySelector('[data-role="language-service-status"]') as HTMLElement | null;
    if (!el) return;
    el.className = `ws-editor-ls-status ${this._languageStatusState}`;
    el.textContent = this._languageStatusMessage;
  }

  private _registerInlineCompletion(): void {
    if (this._inlineCompletionRegistered) return;
    const m = (window as any).monaco; if (!m) return;
    this._inlineCompletionRegistered = true;

    m.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (model: any, position: any, _context: any, _token: any) => {
        const lineContent = model.getLineContent(position.lineNumber);
        const textBeforeCursor = lineContent.substring(0, position.column - 1);
        if (textBeforeCursor.trim().length < 2) return { items: [] };

        // Debounce after typing; manual completion uses _triggerInlineCompletion().
        const key = `${model.uri.path}_${position.lineNumber}_${position.column}`;
        (this as any)._lastInlineKey = key;
        const requestId = ++this._inlineCompletionRequestId;
        this._setInlineCompletionStatus('waiting', 'AI Waiting');
        await new Promise(r => setTimeout(r, 750));
        if ((this as any)._lastInlineKey !== key) return { items: [] };
        if (requestId !== this._inlineCompletionRequestId) return { items: [] };

        try {
          this._setInlineCompletionStatus('thinking', 'AI Thinking');
          const completion = await this._requestInlineCompletion(model, position);
          if (requestId !== this._inlineCompletionRequestId) return { items: [] };
          if (!completion) {
            this._setInlineCompletionStatus('empty', 'AI No suggestion');
            return { items: [] };
          }
          this._setInlineCompletionStatus('ready', 'AI Suggested');

          return {
            items: [{
              insertText: completion,
              range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
            }],
          };
        } catch (err) {
          this._setInlineCompletionStatus('error', this._inlineCompletionErrorMessage(err));
          return { items: [] };
        }
      },
      freeInlineCompletions: () => {},
    } as any);
  }

  private async _triggerInlineCompletion(manual: boolean): Promise<void> {
    if (!this._editor) return;
    const model = this._editor.getModel();
    const position = this._editor.getPosition();
    if (!model || !position) return;

    const lineContent = model.getLineContent(position.lineNumber);
    const textBeforeCursor = lineContent.substring(0, position.column - 1);
    if (textBeforeCursor.trim().length < 2) {
      this._setInlineCompletionStatus('empty', 'AI Type more');
      return;
    }

    const requestId = ++this._inlineCompletionRequestId;
    this._setInlineCompletionStatus('thinking', manual ? 'AI Completing' : 'AI Thinking');
    try {
      const completion = await this._requestInlineCompletion(model, position);
      if (requestId !== this._inlineCompletionRequestId) return;
      if (!completion) {
        this._setInlineCompletionStatus('empty', 'AI No suggestion');
        return;
      }
      this._editor.executeEdits('anoclaw-ai-complete', [{
        range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
        text: completion,
        forceMoveMarkers: true,
      }]);
      this._setInlineCompletionStatus('ready', 'AI Inserted');
      this._editor.focus();
    } catch (err) {
      if (requestId !== this._inlineCompletionRequestId) return;
      this._setInlineCompletionStatus('error', this._inlineCompletionErrorMessage(err));
    }
  }

  private async _requestInlineCompletion(model: any, position: any): Promise<string> {
    const prefix = model.getValueInRange({
      startLineNumber: Math.max(1, position.lineNumber - 24),
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    const totalLines = model.getLineCount();
    const suffix = position.lineNumber < totalLines ? model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: Math.min(totalLines, position.lineNumber + 8),
      endColumn: model.getLineMaxColumn(Math.min(totalLines, position.lineNumber + 8)),
    }) : '';

    const resp = await fetch('/api/v1/inline-suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, suffix, language: model.getLanguageId(), sessionId: this._sessionId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || data.error || `Suggest failed (${resp.status})`);
    return String(data.completion || '').replace(/^\r?\n/, '').replace(/[ \t\r\n]+$/, '');
  }

  private _setInlineCompletionStatus(state: typeof this._inlineCompletionState, message: string): void {
    this._inlineCompletionState = state;
    this._inlineCompletionMessage = message;
    this._renderInlineCompletionStatus();
    if (state === 'ready' || state === 'empty') {
      window.setTimeout(() => {
        if (this._inlineCompletionState === state && this._inlineCompletionMessage === message) {
          this._setInlineCompletionStatus('idle', 'AI Ready');
        }
      }, 2200);
    }
  }

  private _renderInlineCompletionStatus(): void {
    const el = this._contentArea.querySelector('[data-role="inline-completion-status"]') as HTMLElement | null;
    if (!el) return;
    el.className = `ws-editor-ai-status ${this._inlineCompletionState}`;
    el.textContent = this._inlineCompletionMessage;
  }

  private _inlineCompletionErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err || 'error');
    if (/api url|configured|missing/i.test(raw)) return 'AI Not configured';
    if (/401|403|api key|unauthorized/i.test(raw)) return 'AI Auth error';
    if (/fetch|network|ECONN|ENOTFOUND|timeout/i.test(raw)) return 'AI Offline';
    return 'AI Error';
  }

  private _dispatchAskAgent(selectedText: string, action: string): void {
    const tab = this.activeTab;
    const ctx = {
      action,
      activeFile: tab?.path || '',
      fileName: tab?.name || '',
      language: tab?.language || '',
      selectedText,
    };
    window.dispatchEvent(new CustomEvent('ws-ask-agent', { detail: ctx }));
  }

  private _ctxThrottle = 0;
  private _notifyContextChange(): void {
    if (this._ctxThrottle) return;
    this._ctxThrottle = window.setTimeout(() => { this._ctxThrottle = 0; this.onEditorContextChange?.(); }, 400);
  }

  /** Collect current editor context for WS push. */
  getEditorContext(): { openFiles: string[]; activeFile: string; cursorLine: number; cursorColumn: number; selectedText: string; selectedStartLine: number; selectedEndLine: number } | null {
    const openFiles = this._tabs.filter(t => t.fileType === 'code' || t.fileType === 'markdown').map(t => t.path);
    const tab = this.activeTab;
    if (!tab) return null;
    const ec: NonNullable<ReturnType<typeof this.getEditorContext>> = { openFiles: openFiles.slice(0, 20), activeFile: tab.path, cursorLine: 1, cursorColumn: 1, selectedText: '', selectedStartLine: 0, selectedEndLine: 0 };
    if (this._editor) {
      const pos = this._editor.getPosition();
      if (pos) { ec.cursorLine = pos.lineNumber; ec.cursorColumn = pos.column; }
      const sel = this._editor.getSelection();
      if (sel && !sel.isEmpty()) {
        ec.selectedText = this._editor.getModel()?.getValueInRange(sel) || '';
        ec.selectedStartLine = sel.startLineNumber;
        ec.selectedEndLine = sel.endLineNumber;
      }
    }
    return ec;
  }

  get activeTab(): OpenTab|null { return this._tabs.find(t => t.path===this._activePath)||null; }
  get activePath(): string|null { return this._activePath; }
  get hasTabs(): boolean { return this._tabs.length > 0; }

  // ── External change detection (Agent edits) ──

  private _diffBanner: HTMLElement | null = null;

  /** Check if any open code file was modified externally (by Agent). If so, show diff banner. */
  async checkForExternalChanges(): Promise<void> {
    for (const tab of this._tabs) {
      if (tab.fileType !== 'code' || tab.isDirty) continue;
      try {
        const resp = await fetch(`/api/v1/workspace/read?path=${encodeURIComponent(tab.path)}&sessionId=${encodeURIComponent(this._sessionId)}`);
        if (!resp.ok) continue;
        const data = await resp.json();
        const diskContent = data.content || '';
        const editorContent = tab.model?.getValue() || '';
        if (hasExternalContentChange(diskContent, editorContent)) {
          this._showDiffBanner(tab, editorContent, diskContent);
          return; // Only show one banner at a time
        }
      } catch { console.debug('WorkspaceTabGroup: inline completion resolve failed'); }
    }
  }

  private _showDiffBanner(tab: OpenTab, oldContent: string, newContent: string): void {
    this._hideDiffBanner();
    if (tab.path !== this._activePath) return; // Only show for active tab

    const bar = document.createElement('div');
    bar.className = 'ws-diff-banner';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;background:rgba(255,197,51,0.1);border-bottom:1px solid rgba(255,197,51,0.25);font-size:12px;color:#ffc533;flex-shrink:0;';
    bar.innerHTML = `<span>Agent modified this file</span><span style="flex:1;"></span>`;

    const reviewBtn = document.createElement('button');
    reviewBtn.textContent = 'Review Changes';
    reviewBtn.style.cssText = 'padding:3px 8px;border:1px solid rgba(255,197,51,0.4);border-radius:4px;background:transparent;color:#ffc533;cursor:pointer;font-size:11px;font-family:inherit;';
    reviewBtn.addEventListener('click', () => { this._hideDiffBanner(); this._showInlineDiff(tab, oldContent, newContent); });
    bar.appendChild(reviewBtn);

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.style.cssText = 'padding:3px 8px;border:1px solid rgba(74,222,128,0.4);border-radius:4px;background:rgba(74,222,128,0.1);color:#4ade80;cursor:pointer;font-size:11px;font-family:inherit;';
    acceptBtn.addEventListener('click', () => { this._acceptExternalChange(tab, newContent); });
    bar.appendChild(acceptBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.textContent = 'Revert';
    rejectBtn.style.cssText = 'padding:3px 8px;border:1px solid rgba(248,113,113,0.4);border-radius:4px;background:rgba(248,113,113,0.1);color:#f87171;cursor:pointer;font-size:11px;font-family:inherit;';
    rejectBtn.addEventListener('click', () => { this._revertExternalChange(tab, oldContent); });
    bar.appendChild(rejectBtn);

    this._contentArea.insertBefore(bar, this._contentArea.firstChild);
    this._diffBanner = bar;
  }

  private _hideDiffBanner(): void {
    if (this._diffBanner) { this._diffBanner.remove(); this._diffBanner = null; }
  }

  private _showInlineDiff(tab: OpenTab, oldContent: string, newContent: string): void {
    const m = (window as any).monaco;
    this._destroyContent();
    this._contentArea.style.cssText = 'display:flex;flex-direction:column;';

    const diffHost = document.createElement('div');
    diffHost.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
    this._contentArea.appendChild(diffHost);

    const oldModel = m.editor.createModel(oldContent, tab.language);
    const newModel = m.editor.createModel(newContent, tab.language);
    const diffEditor = m.editor.createDiffEditor(diffHost, {
      theme: 'anoclaw-dark', fontSize: 13,
      fontFamily: "'Cascadia Code','Fira Code',Consolas,'SF Mono',Monaco,monospace",
      readOnly: true, automaticLayout: false, renderSideBySide: true,
    });
    diffEditor.setModel({ original: oldModel, modified: newModel });

    // Action bar
    const actionBar = document.createElement('div');
    actionBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--color-hairline,#242728);flex-shrink:0;background:var(--color-surface,#0d0d0d);';
    const revertBtn = document.createElement('button');
    revertBtn.textContent = 'Revert to Original';
    revertBtn.style.cssText = 'padding:4px 10px;border:1px solid rgba(248,113,113,0.3);border-radius:4px;background:transparent;color:#f87171;cursor:pointer;font-size:11px;font-family:inherit;';
    revertBtn.addEventListener('click', () => {
      oldModel.dispose(); newModel.dispose(); diffEditor.dispose();
      this._revertExternalChange(tab, oldContent);
    });
    actionBar.appendChild(revertBtn);

    const spacer = document.createElement('span'); spacer.style.cssText = 'flex:1;'; actionBar.appendChild(spacer);

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept Changes';
    acceptBtn.style.cssText = 'padding:4px 10px;border:1px solid rgba(74,222,128,0.4);border-radius:4px;background:rgba(74,222,128,0.1);color:#4ade80;cursor:pointer;font-size:11px;font-family:inherit;';
    acceptBtn.addEventListener('click', () => {
      oldModel.dispose(); newModel.dispose(); diffEditor.dispose();
      this._acceptExternalChange(tab, newContent);
    });
    actionBar.appendChild(acceptBtn);

    this._contentArea.appendChild(actionBar);
  }

  private async _acceptExternalChange(tab: OpenTab, newContent: string): Promise<void> {
    this._hideDiffBanner();
    tab.model.setValue(newContent);
    tab.originalContent = newContent;
    tab.isDirty = false;
    this._updateDirty(tab);
    // Re-render active tab to restore normal editor view
    if (tab.path === this._activePath) this._activate(tab);
  }

  private async _revertExternalChange(tab: OpenTab, originalContent: string): Promise<void> {
    this._hideDiffBanner();
    // Write original content back to disk
    try {
      await fetch('/api/v1/workspace/write', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId:this._sessionId, path: tab.path, content: originalContent }) });
    } catch { console.debug('WorkspaceTabGroup: undo write failed for', tab.path); }
    tab.model.setValue(originalContent);
    tab.originalContent = originalContent;
    tab.isDirty = false;
    this._updateDirty(tab);
    if (tab.path === this._activePath) this._activate(tab);
  }

  private _destroyContent(): void { this._destroyBrowserView(); if (this._editorHost && this._editorHost.parentElement) this._editorHost.remove(); this._contentArea.innerHTML = ''; this._contentArea.style.cssText = ''; this._contentArea.classList.remove('ws-preview-surface'); }
  private _showEmpty(): void {
    this._contentArea.innerHTML = `
      <div class="ws-editor-empty">
        <div class="ws-editor-empty-panel">
          <div class="ws-editor-empty-mark"></div>
          <div class="ws-editor-empty-title">No file open</div>
          <div class="ws-editor-empty-meta">Workspace editor idle</div>
        </div>
      </div>`;
  }

  dispose(): void {
    this._saveBrowserStateNow();
    if (this._browserStateSaveTimer) {
      window.clearTimeout(this._browserStateSaveTimer);
      this._browserStateSaveTimer = 0;
    }
    if (this._findInputTimer) {
      window.clearTimeout(this._findInputTimer);
      this._findInputTimer = 0;
    }
    if (this._diagnosticsTimer) {
      window.clearTimeout(this._diagnosticsTimer);
      this._diagnosticsTimer = 0;
    }
    WorkspaceTabGroup._groups.delete(this);
    this._ro?.disconnect();
    this._destroyBrowserView();
    this._wvStateCleanup?.();
    this._wvDownloadCleanup?.();
    this._wvNetworkCleanup?.();
    this._wvSecurityCleanup?.();
    this._wvFindCleanup?.();
    if (this._globalKeyHandler) {
      document.removeEventListener('keydown', this._globalKeyHandler);
      this._globalKeyHandler = null;
    }
    if (this._windowResizeHandler) {
      window.removeEventListener('resize', this._windowResizeHandler);
      this._windowResizeHandler = null;
    }
    for (const tab of this._tabs) { if (tab.model) tab.model.dispose(); if (tab.wvId) this._api()?.wvDestroy?.(tab.wvId); }
    this._tabs = [];
    if (this._editor) { this._editor.dispose(); this._editor = null; }
    this._editorHost = null;
    this._activePath = null;
  }
}

function _escAttr(s: string): string { return s.replace(/"/g,'\\"'); }
function _escHtml(s: string): string { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function _baseName(filePath: string): string { return String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || String(filePath || ''); }
function _pathMatches(filePath: string, targetPath: string): boolean {
  const file = String(filePath || '').replace(/\\/g, '/').replace(/\/$/, '');
  const target = String(targetPath || '').replace(/\\/g, '/').replace(/\/$/, '');
  return file === target || file.startsWith(`${target}/`);
}
async function _responseError(resp: Response, fallback: string): Promise<string> {
  const body = await resp.json().catch(() => ({})) as { message?: string; error?: string };
  return body.message || body.error || fallback;
}
function _safeFence(s: string): string { return String(s || '').replace(/```/g, '`` `'); }
function _formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
function _hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function _compactUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}`.slice(0, 180);
  } catch {
    return url.slice(0, 180);
  }
}

function _viewportByName(name?: string): BrowserViewportPreset {
  return BROWSER_VIEWPORT_PRESETS.find(preset => preset.name === name) || BROWSER_VIEWPORT_PRESETS[0];
}

function _viewportPayload(preset: BrowserViewportPreset): { name: string; width?: number; height?: number; mobile?: boolean; deviceScaleFactor?: number; userAgent?: string } {
  return {
    name: preset.name,
    width: preset.width,
    height: preset.height,
    mobile: preset.mobile,
    deviceScaleFactor: preset.deviceScaleFactor,
    userAgent: preset.userAgent,
  };
}

function _columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function _parseDelimitedRows(content: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => {
    pushCell();
    if (row.some(value => value.trim())) rows.push(row.slice(0, 50));
    row = [];
  };

  for (let i = 0; i < content.length && rows.length < 200; i++) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"' && content[i + 1] === '"') { cell += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { pushCell(); continue; }
    if (ch === '\n') { pushRow(); continue; }
    if (ch === '\r') {
      if (content[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    cell += ch;
  }
  if (cell || row.length) pushRow();
  return rows;
}

const _SVG_BROWSER_BACK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;
const _SVG_BROWSER_FORWARD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
const _SVG_BROWSER_RELOAD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 16v5h5"/><path d="M3 12A9 9 0 0 1 18.4 5.6L21 8"/><path d="M21 8V3h-5"/></svg>`;
const _SVG_BROWSER_LOCK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const _SVG_BROWSER_SHARE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>`;
const _SVG_BROWSER_PLUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
const _SVG_BROWSER_DEVTOOLS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 9-4 3 4 3"/><path d="m16 9 4 3-4 3"/><path d="m14 5-4 14"/></svg>`;
const _SVG_BROWSER_MORE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;
const _SVG_BROWSER_PANEL = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 10v10"/></svg>`;
const _SVG_BROWSER_DEVICE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M11 18h2"/></svg>`;
const _SVG_TAB_CLOSE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

const BROWSER_VIEWPORT_PRESETS: BrowserViewportPreset[] = [
  { name: 'desktop', label: 'Desktop' },
  { name: 'desktop-small', label: 'Small', width: 1024, height: 768, mobile: false },
  {
    name: 'iphone',
    label: 'iPhone',
    width: 390,
    height: 844,
    mobile: true,
    deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  {
    name: 'ipad',
    label: 'iPad',
    width: 820,
    height: 1180,
    mobile: true,
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
];

const LANGUAGE_ENDPOINTS: Record<string, string> = {
  completions: '/api/v1/workspace/language/completions',
  hover: '/api/v1/workspace/language/hover',
  definition: '/api/v1/workspace/language/definition',
  diagnostics: '/api/v1/workspace/language/diagnostics',
  'organize-imports': '/api/v1/workspace/language/organize-imports',
};
