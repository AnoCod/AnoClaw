// WorkspaceTabGroup.ts — Tab group for Workspace page.
// Code, image, PDF, markdown via local handling. Browser tabs via Electron WebContentsView.

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
const OFFICE_EXTS = new Set(['docx','xlsx','pptx','xls','xlsm','ppt','pptm','odt','ods','odp']);
type FileType = 'code'|'image'|'pdf'|'markdown'|'binary'|'browser'|'docx'|'xlsx'|'pptx';
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
  browserLoading?:boolean; browserTitle?:string; browserFavicon?:string;
  agentTrace?: AgentBrowserEvent[];
  originalContent?:string; // snapshot at open — for diff detection
}

export class WorkspaceTabGroup {
  readonly element: HTMLElement;
  private _tabBar: HTMLElement; private _plusBtn: HTMLElement; private _contentArea: HTMLElement;
  private _tabs: OpenTab[] = []; private _activePath: string|null = null;
  private _editor: any = null; private _editorHost: HTMLElement | null = null; private _monacoReady = false; private _monacoInit: Promise<void>|null = null;
  private _sessionId = ''; private _ro: ResizeObserver|null = null;
  private _wvStateCleanup: (()=>void)|null = null;
  private _globalKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  onOpenFile: ((path:string, name:string)=>void)|null = null;
  /** Called (throttled) whenever editor state changes — cursor, selection, tab switch. */
  onEditorContextChange: (()=>void)|null = null;

  constructor() {
    this.element = document.createElement('div'); this.element.className = 'ws-tab-group';
    this._tabBar = document.createElement('div'); this._tabBar.className = 'ws-tab-bar';
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
    };
    document.addEventListener('keydown', this._globalKeyHandler);
    // Sync WebContentsView bounds on window resize
    window.addEventListener('resize', () => this._syncWvBounds());

    // Listen for WebContentsView state changes (loading, title, favicon)
    const api = this._api();
    if (api?.onWvStateChange) {
      this._wvStateCleanup = api.onWvStateChange((data: { viewId: string; type: string; url?: string; title?: string; favicons?: string[]; favicon?: string }) => {
        const tab = this._tabs.find(t => t.wvId === data.viewId);
        if (!tab) return;
        switch (data.type) {
          case 'loading-start':
            tab.browserLoading = true;
            this._updateBrowserLoading(tab);
            break;
          case 'loading-stop':
          case 'load-finish':
            tab.browserLoading = false;
            this._updateBrowserLoading(tab);
            break;
          case 'load-error':
            tab.browserLoading = false;
            this._updateBrowserLoading(tab);
            break;
          case 'title':
            if (data.title && data.title !== 'about:blank') {
              tab.browserTitle = data.title;
              tab.name = data.title.substring(0, 40);
              const nm = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"] .ws-tab-name`) as HTMLElement;
              if (nm) nm.textContent = tab.name;
            }
            break;
          case 'favicon':
            if (data.favicons?.length) {
              tab.browserFavicon = data.favicons[0];
              this._updateTabFavicon(tab);
            }
            break;
        }
      });
    }
  }

  setSessionId(id: string): void { this._sessionId = id; }

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
        .then(() => this.openFile(name, name)).catch(() => {});
    });
  }

  /** Create a new browser tab by spawning a new WebContentsView. */
  async newBrowserTab(initialUrl?: string): Promise<void> {
    const url = initialUrl || 'about:blank';
    const api = this._api();
    const result = await api?.wvCreate?.(url);

    const tabId = 'browser:' + Date.now();
    const tab: OpenTab = {
      path: tabId, name: url === 'about:blank' ? 'New Tab' : url.replace(/^https?:\/\//,'').substring(0, 30),
      fileType: 'browser', isDirty: false, language: '', model: null, viewState: null,
      browserUrl: url, wvId: result?.viewId || undefined, agentTrace: [],
    };
    this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
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
      browserUrl: url, wvId: viewId, agentTrace: [],
    };
    this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
  }

  handleAgentBrowserEvent(event: AgentBrowserEvent): void {
    let tab = this._tabs.find(t => t.wvId === event.viewId);
    if (!tab) {
      const url = event.url || 'about:blank';
      tab = {
        path: 'browser:' + Date.now(),
        name: url === 'about:blank' ? 'Agent Browser' : url.replace(/^https?:\/\//,'').substring(0, 30),
        fileType: 'browser', isDirty: false, language: '', model: null, viewState: null,
        browserUrl: url, wvId: event.viewId, agentTrace: [],
      };
      this._tabs.push(tab);
      this._renderTabBtn(tab);
    }

    if (event.url) this._updateBrowserTabUrl(tab, event.url);
    tab.agentTrace = [...(tab.agentTrace || []), event].slice(-12);
    this._activate(tab);
    this._renderAgentTrace(tab);
  }

  private _updateBrowserTabUrl(tab: OpenTab, url: string): void {
    tab.browserUrl = url;
    if (!tab.browserTitle) tab.name = url === 'about:blank' ? 'Agent Browser' : url.replace(/^https?:\/\//,'').substring(0, 30);
    const btn = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"] .ws-tab-name`) as HTMLElement | null;
    if (btn) btn.textContent = tab.name;
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

  async openFile(path: string, name: string): Promise<void> {
    const existing = this._tabs.find(t => t.path === path);
    if (existing) { this._activate(existing); return; }
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const nameLower = name.toLowerCase();

    // ── Images ──
    if (IMG_EXTS.has(ext)) {
      const tab: OpenTab = { path, name, fileType:'image', isDirty:false, language:'', model:null, viewState:null };
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

      const language = _detectLanguage(name, content);
      const fileType: FileType = language === 'markdown' ? 'markdown' : 'code';

      await this._initMonaco(); if (!this._monacoReady) return;
      const m = (window as any).monaco;
      const model = m.editor.createModel(content, language, m.Uri.parse('file:///'+path));

      const tab: OpenTab = { path, name, fileType, isDirty:false, language, model, viewState:null, originalContent: content };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
    } catch {
      const tab: OpenTab = { path, name, fileType:'binary', isDirty:false, language:'', model:null, viewState:null };
      this._tabs.push(tab); this._renderTabBtn(tab); this._activate(tab);
    }
  }

  private _renderTabBtn(tab: OpenTab): void {
    const btn = document.createElement('div');
    btn.className = 'ws-tab' + (tab.fileType==='browser'?' ws-tab-browser':'');
    btn.setAttribute('data-tab-path', tab.path);
    const nm = document.createElement('span'); nm.className = 'ws-tab-name'; nm.textContent = tab.name; btn.appendChild(nm);
    const cls = document.createElement('span'); cls.className = 'ws-tab-close'; cls.textContent = '\xD7';
    cls.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(tab.path); });
    btn.appendChild(cls);
    btn.addEventListener('click', () => this._activate(tab));
    btn.addEventListener('mousedown', (e) => { if (e.button===1) { e.preventDefault(); this.closeTab(tab.path); } });
    this._tabBar.insertBefore(btn, this._plusBtn);
  }

  private _activate(tab: OpenTab): void {
    if (this._editor) { const cur = this._tabs.find(t => t.path===this._activePath); if (cur) cur.viewState = this._editor.saveViewState(); }
    this._activePath = tab.path;
    this._tabBar.querySelectorAll('.ws-tab').forEach(el => el.classList.toggle('active', el.getAttribute('data-tab-path')===tab.path));
    // Destroy any existing browser view before switching
    this._destroyBrowserView();
    switch (tab.fileType) {
      case 'code': this._showCodeEditor(tab); break;
      case 'image': this._showImage(tab); break;
      case 'pdf': this._showPdf(tab); break;
      case 'markdown': this._showMarkdown(tab); break;
      case 'browser': this._showBrowser(tab); break;
      case 'docx': case 'xlsx': case 'pptx': this._showOffice(tab); break;
      default: this._showBinaryNotice(tab);
    }
    this._notifyContextChange();
  }

  closeTab(path: string): void {
    const idx = this._tabs.findIndex(t => t.path===path); if (idx===-1) return;
    const tab = this._tabs[idx];
    if (tab.isDirty) { this._confirmCloseDirty(tab, idx); return; }
    this._doCloseTab(tab, idx);
  }

  private async _confirmCloseDirty(tab: OpenTab, idx: number): Promise<void> {
    const ok = await new Promise<boolean>((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'dialog-overlay';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
      const card = document.createElement('div');
      card.className = 'dialog';
      card.innerHTML = `
        <h2 class="dialog-title">Unsaved changes</h2>
        <p class="dialog-message">Save changes to "${tab.name}" before closing?</p>
        <div class="dialog-actions">
          <button class="btn-dialog-cancel" data-action="discard">Discard</button>
          <button class="btn-dialog-confirm" data-action="save">Save</button>
        </div>`;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      card.querySelector('[data-action="discard"]')?.addEventListener('click', () => { overlay.remove(); resolve(false); });
      card.querySelector('[data-action="save"]')?.addEventListener('click', () => { overlay.remove(); resolve(true); });
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(false); } };
      document.addEventListener('keydown', onKey);
    });
    if (ok) await this.saveFile(tab);
    this._doCloseTab(tab, idx);
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
      });
      this._editor.onDidChangeModelContent(() => {
        const active = this._tabs.find(t => t.path===this._activePath);
        if (active && !active.isDirty) { active.isDirty = true; this._updateDirty(active); }
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
    }
    this._editor.setModel(tab.model);
    if (tab.viewState) this._editor.restoreViewState(tab.viewState);
    this._editor.focus();

    // Add editor status bar
    const statusBar = document.createElement('div');
    statusBar.className = 'ws-editor-status';
    statusBar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:2px 10px;height:22px;flex-shrink:0;background:var(--color-surface,#0d0d0d);border-top:1px solid var(--color-hairline,#242728);font-size:11px;color:var(--color-text-secondary,#9c9c9d);font-family:var(--font-mono);';

    // Language indicator
    const langEl = document.createElement('span');
    langEl.textContent = tab.language || 'plaintext';
    langEl.style.cssText = 'text-transform:uppercase;font-size:10px;font-weight:500;';
    statusBar.appendChild(langEl);

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

    this._contentArea.appendChild(statusBar);
  }

  private _showImage(tab: OpenTab): void { this._destroyContent(); this._contentArea.style.cssText = 'display:flex;align-items:center;justify-content:center;background:#0a0a0a;'; const img = document.createElement('img'); img.className = 'ws-preview-image'; img.src = `/api/v1/workspace/read?path=${encodeURIComponent(tab.path)}&sessionId=${encodeURIComponent(this._sessionId)}&raw=1`; img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;'; this._contentArea.appendChild(img); }
  private _showPdf(tab: OpenTab): void { this._destroyContent(); const iframe = document.createElement('iframe'); iframe.src = `/api/v1/workspace/read?path=${encodeURIComponent(tab.path)}&sessionId=${encodeURIComponent(this._sessionId)}&raw=1`; iframe.style.cssText = 'width:100%;height:100%;border:none;'; this._contentArea.appendChild(iframe); }

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
    leftGroup.innerHTML = `
      <button class="ws-browser-nav-btn" data-action="back" title="Go Back" disabled>◂</button>
      <button class="ws-browser-nav-btn" data-action="forward" title="Go Forward" disabled>▸</button>
      <button class="ws-browser-nav-btn" data-action="reload" title="Reload">↻</button>`;
    bar.appendChild(leftGroup);

    // Address bar with SSL icon + loading spinner
    const urlWrapper = document.createElement('div');
    urlWrapper.style.cssText = 'flex:1;display:flex;align-items:center;position:relative;';
    // SSL indicator
    const sslIcon = document.createElement('span');
    sslIcon.className = 'ws-browser-ssl-icon';
    sslIcon.style.cssText = 'position:absolute;left:8px;font-size:12px;pointer-events:none;z-index:1;';
    sslIcon.textContent = tab.browserUrl?.startsWith('https://') ? '🔒' : '';
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

    // Share with Agent
    const shareBtn = this._browserBtn('Share with Agent', '↗');
    shareBtn.addEventListener('click', () => this._shareUrlWithAgent(tab));
    rightGroup.appendChild(shareBtn);

    // Add element to chat
    const addDropdown = this._browserBtn('Add to Chat', '+');
    addDropdown.style.position = 'relative';
    addDropdown.addEventListener('click', (e) => { e.stopPropagation(); this._showAddToChatMenu(addDropdown, tab); });
    rightGroup.appendChild(addDropdown);

    // DevTools
    const devBtn = this._browserBtn('Developer Tools', '◇');
    devBtn.addEventListener('click', () => this._api()?.wvDevTools?.(tab.wvId));
    rightGroup.appendChild(devBtn);

    // More menu
    const moreBtn = this._browserBtn('More', '…');
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); this._showBrowserMoreMenu(moreBtn, tab); });
    rightGroup.appendChild(moreBtn);

    bar.appendChild(rightGroup);
    this._contentArea.appendChild(bar);

    // Loading progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'ws-browser-progress';
    progressBar.style.cssText = 'height:2px;flex-shrink:0;background:transparent;transition:background 0.3s;';
    if (tab.browserLoading) {
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-accent,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
    }
    this._contentArea.appendChild(progressBar);

    const trace = document.createElement('div');
    trace.className = 'ws-browser-agent-trace';
    this._contentArea.appendChild(trace);
    this._renderAgentTrace(tab);

    // Placeholder for WebContentsView
    const placeholder = document.createElement('div');
    placeholder.className = 'ws-browser-placeholder';
    placeholder.setAttribute('data-wv-view', tab.wvId || '');
    this._contentArea.appendChild(placeholder);

    this._lastWvId = tab.wvId || null;

    // Navigation
    const navigate = () => {
      let url = input.value.trim();
      if (!url) return;
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('about:') && !url.startsWith('file://')) {
        url = 'https://' + url;
      }
      tab.browserUrl = url;
      tab.name = url.replace(/^https?:\/\//, '').substring(0, 30) || 'Browser';
      const nm = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"] .ws-tab-name`);
      if (nm) nm.textContent = tab.name;
      // Update SSL icon
      sslIcon.textContent = url.startsWith('https://') ? '🔒' : '';
      if (tab.wvId) this._api()?.wvNavigate?.(tab.wvId, url);
      // Show loading bar
      tab.browserLoading = true;
      input.value = url;
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-accent,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
      this._syncWvBounds();
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(); });

    // Action buttons
    bar.querySelector('[data-action="back"]')?.addEventListener('click', () => this._api()?.wvGoBack?.(tab.wvId));
    bar.querySelector('[data-action="forward"]')?.addEventListener('click', () => this._api()?.wvGoForward?.(tab.wvId));
    bar.querySelector('[data-action="reload"]')?.addEventListener('click', () => {
      tab.browserLoading = true;
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-accent,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
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

  private _browserBtn(title: string, label: string): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'ws-browser-nav-btn ws-browser-action';
    btn.title = title; btn.textContent = label;
    return btn;
  }

  private _shareUrlWithAgent(tab: OpenTab): void {
    const url = tab.browserUrl || '';
    if (!url || url === 'about:blank') return;
    const app = (window as any).__anoclawApp;
    if (!app) return;
    const sid = app.sessionVM?.activeSessionId;
    if (!sid) return;
    const agent = app.conversationVM?.getAgent(sid);
    if (agent) {
      const content = `[Browser: ${url}]\n`;
      agent.sendMessage(content, app.conversationVM.permissionMode, app.conversationVM.effortMode, []).catch(() => {});
    }
  }

  private _showAddToChatMenu(anchor: HTMLElement, tab: OpenTab): void {
    this._closeAllMenus();
    const menu = document.createElement('div');
    menu.className = 'ws-browser-menu';
    menu.innerHTML = `
      <div class="ws-browser-menu-item" data-action="add-element">Add Element to Chat</div>
      <div class="ws-browser-menu-item" data-action="add-console">Add Console Logs to Chat</div>
      <div class="ws-browser-menu-item" data-action="add-screenshot">Add Screenshot to Chat</div>
      <div class="ws-browser-menu-item" data-action="add-area-screenshot">Add Area Screenshot to Chat</div>`;
    anchor.appendChild(menu);
    (this as any)._openMenu = menu;

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

  private _sendToAgent(content: string): void {
    const app = (window as any).__anoclawApp;
    if (!app) return;
    const sid = app.sessionVM?.activeSessionId;
    if (!sid) return;
    const agent = app.conversationVM?.getAgent(sid);
    if (agent) {
      agent.sendMessage(content, app.conversationVM.permissionMode, app.conversationVM.effortMode, []).catch(() => {});
    }
  }

  private _sendImageToAgent(dataUrl: string): void {
    const app = (window as any).__anoclawApp;
    if (!app) return;
    app.conversationVM?.addAttachment({ name: 'screenshot.png', path: '', type: 'image', size: 0, content: dataUrl });
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
    await this._api()?.wvExecJs?.(tab.wvId, `
      (function() {
        if (!window.__anoclawLogs) { window.__anoclawLogs = []; }
        const orig = { log: console.log, warn: console.warn, error: console.error };
        ['log','warn','error'].forEach(l => { console[l] = (...a) => { window.__anoclawLogs.push({level:l,msg:a.join(' ')}); orig[l](...a); }; });
      })();
    `);
    const result = await this._api()?.wvExecJs?.(tab.wvId, 'JSON.stringify(window.__anoclawLogs||[])');
    const logs = result?.ok ? JSON.parse(result.result) : [];
    if (logs.length > 0) {
      this._sendToAgent(`[Browser Console]\n${logs.map((l: { level: string; msg: string }) => `[${l.level}] ${l.msg}`).join('\n')}`);
    }
  }

  private async _addScreenshotToChat(tab: OpenTab, area: boolean): Promise<void> {
    const rect = area ? undefined : undefined; // Full page for now, area mode toggles a draggable overlay
    const result = await this._api()?.wvCaptureScreenshot?.(tab.wvId, rect);
    if (result?.ok && result.dataUrl) {
      this._sendImageToAgent(result.dataUrl);
    }
  }

  private async _wvZoom(tab: OpenTab, delta: number): Promise<void> {
    await this._api()?.wvExecJs?.(tab.wvId, `(()=>{const z=parseFloat(document.body.style.zoom||1)+${delta};document.body.style.zoom=Math.max(0.25,Math.min(3,z));})()`);
  }

  private async _wvZoomReset(tab: OpenTab): Promise<void> {
    await this._api()?.wvExecJs?.(tab.wvId, 'document.body.style.zoom=1');
  }

  private async _wvFind(tab: OpenTab): Promise<void> {
    await this._api()?.wvExecJs?.(tab.wvId, 'window.find(prompt("Find in page:"))');
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
      progressBar.innerHTML = '<div style="height:100%;width:30%;background:var(--color-accent,#fff);animation:ws-progress-indeterminate 1.5s ease-in-out infinite;border-radius:1px;"></div>';
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

      if (data.type === 'html') {
        const wrapper = document.createElement('div');
        wrapper.className = 'ws-preview-office';
        wrapper.style.cssText = 'padding:20px 28px;font-size:13px;line-height:1.7;color:var(--color-text,#f4f4f6);max-width:860px;margin:0 auto;';
        wrapper.innerHTML = data.html;
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
        img.src = data.dataUrl || `/api/v1/workspace/read?path=${encodeURIComponent(tab.path)}&sessionId=${encodeURIComponent(this._sessionId)}&raw=1`;
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

  async saveActiveFile(): Promise<void> {
    const tab = this._tabs.find(t => t.path===this._activePath);
    if (tab) await this.saveFile(tab);
  }

  async saveFile(tab: OpenTab): Promise<void> {
    if (!tab.isDirty || tab.fileType!=='code') return;
    try {
      await fetch('/api/v1/workspace/write', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sessionId:this._sessionId, path:tab.path, content:tab.model.getValue()}) });
      tab.isDirty = false; this._updateDirty(tab);
    } catch { /* ignore */ }
  }

  private _updateDirty(tab: OpenTab): void { const btn = this._tabBar.querySelector(`[data-tab-path="${_escAttr(tab.path)}"]`); if (btn) btn.classList.toggle('dirty', tab.isDirty); }

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
  }

  private _registerInlineCompletion(): void {
    if (this._inlineCompletionRegistered) return;
    const m = (window as any).monaco; if (!m) return;
    this._inlineCompletionRegistered = true;

    m.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (model: any, position: any, _context: any, _token: any) => {
        // Only trigger if there's content to complete (cursor at end of a line with code)
        const lineContent = model.getLineContent(position.lineNumber);
        const textBeforeCursor = lineContent.substring(0, position.column - 1);
        if (textBeforeCursor.trim().length < 2) return { items: [] };

        // Debounce — wait 1.5s since last keystroke
        const key = `${model.uri.path}_${position.lineNumber}_${position.column}`;
        (this as any)._lastInlineKey = key;
        await new Promise(r => setTimeout(r, 1500));
        if ((this as any)._lastInlineKey !== key) return { items: [] };

        try {
          const prefix = model.getValueInRange({
            startLineNumber: Math.max(1, position.lineNumber - 15),
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          const totalLines = model.getLineCount();
          const suffix = position.lineNumber < totalLines ? model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: Math.min(totalLines, position.lineNumber + 3),
            endColumn: model.getLineMaxColumn(Math.min(totalLines, position.lineNumber + 3)),
          }) : '';

          const resp = await fetch('/api/v1/inline-suggest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix, suffix, language: model.getLanguageId(), sessionId: this._sessionId }),
          });
          if (!resp.ok) return { items: [] };
          const data = await resp.json();
          const completion = (data.completion || '').trim();
          if (!completion || completion.length < 1) return { items: [] };

          return {
            items: [{
              insertText: completion,
              range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
            }],
          };
        } catch {
          return { items: [] };
        }
      },
      freeInlineCompletions: () => {},
    } as any);
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
        if (diskContent && diskContent !== editorContent) {
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

  private _destroyContent(): void { this._destroyBrowserView(); if (this._editorHost && this._editorHost.parentElement) this._editorHost.remove(); this._contentArea.innerHTML = ''; this._contentArea.style.cssText = ''; }
  private _showEmpty(): void {
    this._contentArea.innerHTML = `<div class="ws-editor-empty" style="flex-direction:column;gap:4px;">
      <div style="font-size:13px;margin-bottom:8px;">Open a file from the tree</div>
      <div style="font-size:10px;opacity:0.5;">Ctrl+F Find &nbsp;|&nbsp; Ctrl+H Replace &nbsp;|&nbsp; Ctrl+G Go to Line &nbsp;|&nbsp; Ctrl+S Save</div>
    </div>`;
  }

  dispose(): void {
    this._ro?.disconnect();
    this._destroyBrowserView();
    this._wvStateCleanup?.();
    if (this._globalKeyHandler) {
      document.removeEventListener('keydown', this._globalKeyHandler);
      this._globalKeyHandler = null;
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
