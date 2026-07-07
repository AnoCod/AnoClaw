/**
 * FilePreview — standalone file preview and rendering utilities.
 *
 * Provides markdown rendering, syntax highlighting, file extension detection,
 * language detection, and file size formatting. Kept as shared helpers for
 * chat markdown rendering and workspace preview surfaces.
 *
 * All functions are pure — no DOM dependencies, no class state.
 */

// ── HTML escape (internal helper) ──

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Public API ──

/**
 * Render a Markdown string to HTML.
 *
 * Supports: headings (h1–h6), bold, italic, inline code, fenced code blocks,
 * links, unordered lists, horizontal rules, and paragraph wrapping.
 * HTML entities in the source are escaped before processing.
 */
export function renderMarkdown(content: string): string {
  let html = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Code blocks (fenced)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre style="background:var(--color-bg);padding:8px;border-radius:4px;overflow-x:auto;font-size:11px;line-height:1.5"><code${langClass}>${escapeHtml(code.trimEnd())}</code></pre>`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.06);padding:1px 4px;border-radius:3px;font-size:0.9em">$1</code>')
    // Headers
    .replace(/^###### (.+)$/gm, '<h6 style="font-size:12px;margin:8px 0 4px;color:var(--color-text-secondary)">$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5 style="font-size:13px;margin:10px 0 4px">$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4 style="font-size:14px;margin:12px 0 4px">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;margin:14px 0 4px;font-weight:600">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;margin:16px 0 4px;font-weight:600">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:18px;margin:18px 0 6px;font-weight:700">$1</h1>')
    // Bold / Italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--color-text-primary);text-decoration:none">$1</a>')
    // Unordered lists (simple)
    .replace(/^[\s]*[-*+] (.+)$/gm, '<li style="margin:2px 0">$1</li>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:12px 0">')
    // Paragraphs (double newline)
    .replace(/\n\n+/g, '</p><p style="margin:6px 0">');

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith('<')) {
    html = '<p style="margin:6px 0">' + html + '</p>';
  }
  // Wrap consecutive list items
  html = html.replace(/(<li[^>]*>.*?<\/li>\n?)+/g, '<ul style="margin:6px 0;padding-left:20px">$&</ul>');

  return html;
}

// ── Code highlighting markers (non-HTML — safe from regex collision) ──
// Phase 1: tag tokens with markers. Phase 2: replace markers with HTML spans.
// This prevents span tags generated in one pass from being regex-matched in a later pass.

const MK = {
  keyword: '\x00K',
  type: '\x00T',
  func: '\x00F',
  string: '\x00S',
  number: '\x00N',
  comment: '\x00C',
};

// ── Language-specific token tables ──

const KW_COMMON = 'if|else|for|while|return|break|continue|switch|case|default|throw|try|catch|finally|new|delete|typeof|instanceof|in|of|void|yield|await|async|export|import|from|extends|implements|class|interface|enum|type|const|let|var|function';

const TYPES_BY_LANG: Record<string, string> = {
  typescript: 'string|number|boolean|any|void|never|unknown|null|undefined|Promise|Map|Set|WeakMap|WeakSet|Array|ReadonlyArray|Record|Partial|Required|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|ConstructorParameters|InstanceType|Awaited|Error|Date|RegExp|Symbol|BigInt|Int8Array|Uint8Array|Float32Array|Float64Array|Buffer|URL|URLSearchParams|FormData|Headers|Request|Response|AbortController|AbortSignal|Event|CustomEvent|HTMLElement|Element|Node|Document|Window|console|Math|JSON|Object|Reflect|Proxy',
  javascript: 'string|number|boolean|any|void|never|null|undefined|Promise|Map|Set|WeakMap|WeakSet|Array|Error|Date|RegExp|Symbol|BigInt|Buffer|URL|console|Math|JSON|Object',
  python: 'str|int|float|bool|list|dict|tuple|set|frozenset|bytes|bytearray|memoryview|None|True|False|self|cls|Exception|ValueError|TypeError|KeyError|IndexError|RuntimeError|StopIteration|NotImplemented|Ellipsis|range|enumerate|zip|map|filter|len|print|super|isinstance|issubclass|hasattr|getattr|setattr|delattr|any|all|sorted|reversed|min|max|sum|abs|round|type|open|iter|next|lambda|yield|with|assert|raise|except|finally|import|from|as|pass|global|nonlocal',
  rust: 'fn|pub|impl|struct|enum|trait|match|self|mut|ref|where|dyn|unsafe|extern|crate|mod|use|as|move|loop|for|while|if|else|return|break|continue|let|const|static|type|Vec|String|Option|Result|Some|None|Ok|Err|Box|Rc|Arc|Mutex|RwLock|Cell|RefCell|HashMap|HashSet|BTreeMap|BTreeSet|BinaryHeap|LinkedList|VecDeque|Cow|Path|PathBuf|OsString|OsStr|CString|CStr|str|u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64|bool|char|true|false|From|Into|Iterator|IntoIterator|Clone|Copy|Debug|Display|Default|Drop|Deref|DerefMut|PartialEq|Eq|PartialOrd|Ord|Send|Sync|Sized|Fn|FnMut|FnOnce|Error|panic|assert|assert_eq|assert_ne|unimplemented|unreachable|todo|println|print|format|eprintln|write|writeln|dbg',
  json: '',
};

const KW_BY_LANG: Record<string, string> = {
  typescript: 'import|from|export|default|as|namespace|module|declare|abstract|implements|extends|super|this|constructor|get|set',
  python: 'import|from|as|def|class|return|yield|lambda|pass|raise|del|with|assert|elif|global|nonlocal',
  rust: 'use|mod|crate|super|self|pub|fn|struct|enum|trait|impl|match|if|else|loop|for|while|let|mut|ref|return|break|continue|where|dyn|unsafe|extern|async|await|move|static|const',
};

function buildRe(pipeStr: string): RegExp | null {
  if (!pipeStr) return null;
  return new RegExp(`\\b(${pipeStr})\\b`, 'g');
}

const NUM_RE = /\b(\d+\.?\d*)\b/g;
const COMMENT_RE = /(\/\/.*)$|(#.*)$/gm;
const STRING_RE = /(["'`])(?:(?!\1|\\).|\\.)*?\1/g;
const FUNC_CALL_RE = /\b(\w[\w\d]*)(\s*)(\()/g;

// Normalize lang name from file extension or code block lang tag
function normalizeLang(lang: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', typescript: 'typescript',
    js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', python: 'python',
    rs: 'rust', rust: 'rust',
    json: 'json', json5: 'json',
    go: 'go', golang: 'go',
    java: 'java',
    c: 'c', cpp: 'cpp', 'c++': 'cpp',
    cs: 'csharp', csharp: 'csharp',
    rb: 'ruby', ruby: 'ruby',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql',
    html: 'html', css: 'css', scss: 'scss',
    yaml: 'yaml', yml: 'yaml', md: 'markdown',
  };
  return map[lang.toLowerCase()] || '';
}

// Capitalized word followed by non-paren chars — likely a type/class name
const TYPE_NAME_RE = /\b([A-Z][a-z]+[A-Z]?[a-zA-Z]*)\b/g;

/**
 * Apply syntax highlighting with language-aware keyword and type tables.
 * Uses marker-based tokenization to prevent regex cross-contamination.
 */
export function highlightCode(code: string, lang: string): string {
  const normLang = normalizeLang(lang);
  const escaped = escapeHtml(code);
  const lines: string[] = [];

  // Build language-specific regexes
  const commonKwRe = buildRe(KW_COMMON);
  const typeRe = normLang ? buildRe(TYPES_BY_LANG[normLang] || '') : null;
  const langKwRe = normLang ? buildRe(KW_BY_LANG[normLang] || '') : null;

  for (const line of escaped.split('\n')) {
    let hl = line;

    // Phase 1: mark tokens with inert markers
    hl = hl.replace(STRING_RE, (_m) => `${MK.string}${_m}${MK.string}`);
    hl = hl.replace(COMMENT_RE, (_m, c1, c2) => {
      const c = c1 || c2;
      return c ? `${MK.comment}${c}${MK.comment}` : _m;
    });

    // Type/class names — capitalize pattern, only outside markers
    hl = hl.replace(TYPE_NAME_RE, (m) => {
      // Skip if it touches a marker
      if (m.includes('\x00')) return m;
      return `${MK.type}${m}${MK.type}`;
    });

    // Language-specific built-in types (lowercase like str, int, Vec)
    if (typeRe) hl = hl.replace(typeRe, (m) => {
      if (m.includes('\x00')) return m;
      return `${MK.type}${m}${MK.type}`;
    });

    // Function calls: word followed by (
    hl = hl.replace(FUNC_CALL_RE, (_m, name, sp, paren) => {
      if (name.includes('\x00')) return _m;
      return `${MK.func}${name}${MK.func}${sp}${paren}`;
    });

    // Keywords
    if (commonKwRe) hl = hl.replace(commonKwRe, (m) => {
      if (m.includes('\x00')) return m;
      return `${MK.keyword}${m}${MK.keyword}`;
    });
    if (langKwRe) hl = hl.replace(langKwRe, (m) => {
      if (m.includes('\x00')) return m;
      return `${MK.keyword}${m}${MK.keyword}`;
    });

    hl = hl.replace(NUM_RE, (m) => {
      if (m.includes('\x00')) return m;
      return `${MK.number}${m}${MK.number}`;
    });

    // Phase 2: replace markers with styled spans
    hl = hl.replace(new RegExp(`${MK.keyword}(.+?)${MK.keyword}`, 'g'),
      '<span style="color:var(--hl-keyword,#569CD6)">$1</span>');
    hl = hl.replace(new RegExp(`${MK.type}(.+?)${MK.type}`, 'g'),
      '<span style="color:var(--hl-type,#4EC9B0)">$1</span>');
    hl = hl.replace(new RegExp(`${MK.func}(.+?)${MK.func}`, 'g'),
      '<span style="color:var(--hl-function,#DCDCAA)">$1</span>');
    hl = hl.replace(new RegExp(`${MK.string}(.+?)${MK.string}`, 'g'),
      '<span style="color:var(--hl-string,#CE9178)">$1</span>');
    hl = hl.replace(new RegExp(`${MK.number}(.+?)${MK.number}`, 'g'),
      '<span style="color:var(--hl-number,#B5CEA8)">$1</span>');
    hl = hl.replace(new RegExp(`${MK.comment}(.+?)${MK.comment}`, 'g'),
      '<span style="color:var(--hl-comment,#6A9955);font-style:italic">$1</span>');

    lines.push(hl);
  }

  return lines.join('\n');
}

/**
 * Return the lowercase file extension from a path (without the leading dot).
 * Returns an empty string if there is no extension.
 */
export function getFileExtension(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i + 1).toLowerCase() : '';
}

/**
 * Map a filename (by its extension) to a language identifier for syntax highlighting.
 */
export function detectLanguage(filename: string): string {
  const ext = getFileExtension(filename);
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', php: 'php', swift: 'swift', kt: 'kotlin',
    md: 'markdown', r: 'r',
  };
  return map[ext] || '';
}

/**
 * Format a byte count into a human-readable string (B / KB / MB).
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
