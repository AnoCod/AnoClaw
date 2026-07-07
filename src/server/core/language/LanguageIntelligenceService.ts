// LanguageIntelligenceService — workspace-scoped code intelligence for Monaco.
// TS/JS uses the TypeScript language service; Python uses Pyright over LSP stdio.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export type LanguageKind = 'typescript' | 'javascript' | 'python' | 'unknown';

export interface LanguagePosition {
  line: number;
  column: number;
}

export interface LanguageRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface LanguageCompletionItem {
  label: string;
  kind: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  range?: LanguageRange;
  additionalTextEdits?: LanguageEdit[];
}

export interface LanguageHover {
  contents: string;
  range?: LanguageRange;
}

export interface LanguageLocation {
  path: string;
  absolutePath: string;
  external: boolean;
  range: LanguageRange;
  preview?: string;
}

export interface LanguageDiagnostic {
  path: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string | number;
  message: string;
  range: LanguageRange;
  source: 'typescript' | 'pyright';
}

export interface LanguageEdit {
  path: string;
  range: LanguageRange;
  text: string;
}

export interface LanguageRequest {
  workspaceRoot: string;
  filePath: string;
  content: string;
  line: number;
  column: number;
  language?: string;
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXTENSIONS = new Set(['.py', '.pyi']);
const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.venv', 'venv', '__pycache__', '.mypy_cache',
  '.pytest_cache', 'release8', 'release9', 'win-unpacked',
]);

function detectLanguage(filePath: string, explicit?: string): LanguageKind {
  const lang = String(explicit || '').toLowerCase();
  if (lang.includes('python')) return 'python';
  if (lang.includes('typescript') || lang === 'ts' || lang === 'tsx') return 'typescript';
  if (lang.includes('javascript') || lang === 'js' || lang === 'jsx') return 'javascript';
  const ext = path.extname(filePath).toLowerCase();
  if (PY_EXTENSIONS.has(ext)) return 'python';
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  return 'unknown';
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function relativeToRoot(root: string, filePath: string): string {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  return rel || path.basename(filePath);
}

function isInside(root: string, filePath: string): boolean {
  const rel = path.relative(root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function positionToOffset(text: string, line: number, column: number): number {
  const safeLine = Math.max(1, line);
  const safeColumn = Math.max(1, column);
  let offset = 0;
  let currentLine = 1;
  while (currentLine < safeLine && offset < text.length) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
    currentLine++;
  }
  return Math.min(text.length, offset + safeColumn - 1);
}

function rangeFromOffsets(source: ts.SourceFile, start: number, length: number): LanguageRange {
  const a = ts.getLineAndCharacterOfPosition(source, Math.max(0, start));
  const b = ts.getLineAndCharacterOfPosition(source, Math.max(0, start + Math.max(0, length)));
  return {
    startLineNumber: a.line + 1,
    startColumn: a.character + 1,
    endLineNumber: b.line + 1,
    endColumn: b.character + 1,
  };
}

function oneCharRange(line: number, column: number): LanguageRange {
  return {
    startLineNumber: Math.max(1, line),
    startColumn: Math.max(1, column),
    endLineNumber: Math.max(1, line),
    endColumn: Math.max(1, column + 1),
  };
}

function lspRangeToMonaco(range: LspRange): LanguageRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function flattenMessage(message: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, '\n');
}

function textParts(parts: ts.SymbolDisplayPart[] | undefined): string {
  return (parts || []).map(part => part.text).join('');
}

function findNearestProjectConfig(root: string): string | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function scanProjectFiles(root: string, extensions: Set<string>, maxFiles: number): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') {
        if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(normalizePath(full));
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

class TsWorkspaceService {
  private readonly _root: string;
  private readonly _service: ts.LanguageService;
  private readonly _overlays = new Map<string, { content: string; version: number }>();
  private _fileNames = new Set<string>();
  private _compilerOptions: ts.CompilerOptions;
  private _lastScan = 0;

  constructor(root: string) {
    this._root = normalizePath(root);
    const config = this._loadConfig();
    this._compilerOptions = config.options;
    this._fileNames = new Set(config.fileNames);
    this._refreshFiles();

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this._compilerOptions,
      getScriptFileNames: () => Array.from(new Set([...this._fileNames, ...this._overlays.keys()])),
      getScriptVersion: fileName => this._scriptVersion(fileName),
      getScriptSnapshot: fileName => this._scriptSnapshot(fileName),
      getCurrentDirectory: () => this._root,
      getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
    };
    this._service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  updateFile(fileName: string, content: string): void {
    const abs = normalizePath(fileName);
    const current = this._overlays.get(abs);
    if (!current || current.content !== content) {
      this._overlays.set(abs, { content, version: (current?.version || 0) + 1 });
    }
    this._fileNames.add(abs);
  }

  completions(fileName: string, content: string, pos: LanguagePosition): LanguageCompletionItem[] {
    const abs = normalizePath(fileName);
    this.updateFile(abs, content);
    this._refreshFiles(false);
    const offset = positionToOffset(content, pos.line, pos.column);
    const info = this._service.getCompletionsAtPosition(abs, offset, {
      includeCompletionsForModuleExports: true,
      includeCompletionsForImportStatements: true,
      includeCompletionsWithInsertText: true,
      includeAutomaticOptionalChainCompletions: true,
      includeCompletionsWithSnippetText: true,
    });
    if (!info) return [];
    const source = this._sourceFile(abs, content);
    return info.entries.slice(0, 160).map(entry => {
      const span = entry.replacementSpan;
      const range = span ? rangeFromOffsets(source, span.start, span.length) : undefined;
      const details = this._completionDetails(abs, offset, entry);
      const detail = details?.displayParts?.length ? textParts(details.displayParts)
        : entry.source ? `Auto import from ${entry.source}`
        : entry.kindModifiers || undefined;
      return {
        label: entry.name,
        kind: entry.kind,
        detail,
        documentation: details?.documentation?.length ? textParts(details.documentation) : undefined,
        insertText: entry.insertText || entry.name,
        sortText: entry.sortText,
        range,
        additionalTextEdits: details ? this._completionAdditionalEdits(details) : undefined,
      };
    });
  }

  hover(fileName: string, content: string, pos: LanguagePosition): LanguageHover | null {
    const abs = normalizePath(fileName);
    this.updateFile(abs, content);
    const offset = positionToOffset(content, pos.line, pos.column);
    const info = this._service.getQuickInfoAtPosition(abs, offset);
    if (!info) return null;
    const source = this._sourceFile(abs, content);
    const signature = textParts(info.displayParts);
    const docs = textParts(info.documentation);
    const tags = (info.tags || []).map(tag => `@${tag.name} ${textParts(tag.text as ts.SymbolDisplayPart[] | undefined)}`.trim()).join('\n');
    const blocks = [signature ? `\`\`\`ts\n${signature}\n\`\`\`` : '', docs, tags].filter(Boolean);
    return {
      contents: blocks.join('\n\n'),
      range: rangeFromOffsets(source, info.textSpan.start, info.textSpan.length),
    };
  }

  definition(fileName: string, content: string, pos: LanguagePosition): LanguageLocation[] {
    const abs = normalizePath(fileName);
    this.updateFile(abs, content);
    const offset = positionToOffset(content, pos.line, pos.column);
    const info = this._service.getDefinitionAndBoundSpan(abs, offset);
    if (!info?.definitions?.length) return [];
    return info.definitions.slice(0, 20).map(def => this._definitionToLocation(def.fileName, def.textSpan));
  }

  diagnostics(fileName: string, content: string): LanguageDiagnostic[] {
    const abs = normalizePath(fileName);
    this.updateFile(abs, content);
    const all = [
      ...this._service.getSyntacticDiagnostics(abs),
      ...this._service.getSemanticDiagnostics(abs),
      ...this._service.getSuggestionDiagnostics(abs),
    ];
    const source = this._sourceFile(abs, content);
    return all.slice(0, 220).map(diagnostic => {
      const start = typeof diagnostic.start === 'number' ? diagnostic.start : 0;
      const length = typeof diagnostic.length === 'number' ? diagnostic.length : 1;
      return {
        path: relativeToRoot(this._root, abs),
        severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'error'
          : diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning'
          : diagnostic.category === ts.DiagnosticCategory.Suggestion ? 'hint'
          : 'info',
        code: diagnostic.code,
        message: flattenMessage(diagnostic.messageText),
        range: rangeFromOffsets(source, start, length),
        source: 'typescript',
      };
    });
  }

  organizeImports(fileName: string, content: string): LanguageEdit[] {
    const abs = normalizePath(fileName);
    this.updateFile(abs, content);
    const changes = this._service.organizeImports({ type: 'file', fileName: abs }, {}, {});
    return changes.flatMap(change => {
      const changedPath = normalizePath(change.fileName);
      const currentContent = this._overlays.get(changedPath)?.content || ts.sys.readFile(changedPath) || '';
      const source = this._sourceFile(changedPath, currentContent);
      return change.textChanges.map(textChange => ({
        path: relativeToRoot(this._root, changedPath),
        range: rangeFromOffsets(source, textChange.span.start, textChange.span.length),
        text: textChange.newText,
      }));
    });
  }

  private _loadConfig(): { options: ts.CompilerOptions; fileNames: string[] } {
    const configPath = findNearestProjectConfig(this._root);
    if (configPath) {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, this._root);
        return {
          options: {
            allowJs: true,
            checkJs: false,
            noEmit: true,
            skipLibCheck: true,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            target: ts.ScriptTarget.ES2022,
            ...parsed.options,
          },
          fileNames: parsed.fileNames.map(normalizePath).filter(file => TS_EXTENSIONS.has(path.extname(file).toLowerCase())),
        };
      }
    }
    return {
      options: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      },
      fileNames: [],
    };
  }

  private _refreshFiles(force = false): void {
    const now = Date.now();
    if (!force && now - this._lastScan < 5000) return;
    this._lastScan = now;
    for (const file of scanProjectFiles(this._root, TS_EXTENSIONS, 1200)) {
      this._fileNames.add(file);
    }
  }

  private _scriptVersion(fileName: string): string {
    const abs = normalizePath(fileName);
    const overlay = this._overlays.get(abs);
    if (overlay) return String(overlay.version);
    try { return String(fs.statSync(abs).mtimeMs); }
    catch { return '0'; }
  }

  private _scriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const abs = normalizePath(fileName);
    const overlay = this._overlays.get(abs);
    if (overlay) return ts.ScriptSnapshot.fromString(overlay.content);
    if (!fs.existsSync(abs)) return undefined;
    const content = ts.sys.readFile(abs);
    return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
  }

  private _sourceFile(fileName: string, content: string): ts.SourceFile {
    const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
      : fileName.endsWith('.jsx') ? ts.ScriptKind.JSX
      : fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs') ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
    return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, kind);
  }

  private _definitionToLocation(fileName: string, span: ts.TextSpan): LanguageLocation {
    const abs = normalizePath(fileName);
    const content = this._overlays.get(abs)?.content || ts.sys.readFile(abs) || '';
    const source = this._sourceFile(abs, content);
    const range = rangeFromOffsets(source, span.start, span.length);
    const preview = content.split(/\r?\n/).slice(Math.max(0, range.startLineNumber - 2), range.startLineNumber + 2).join('\n');
    return {
      path: isInside(this._root, abs) ? relativeToRoot(this._root, abs) : abs,
      absolutePath: abs,
      external: !isInside(this._root, abs),
      range,
      preview,
    };
  }

  private _completionDetails(fileName: string, offset: number, entry: ts.CompletionEntry): ts.CompletionEntryDetails | undefined {
    if (!entry.source && !(entry as { hasAction?: boolean }).hasAction) return undefined;
    try {
      return this._service.getCompletionEntryDetails(
        fileName,
        offset,
        entry.name,
        {},
        entry.source,
        {
          includeCompletionsForModuleExports: true,
          includeCompletionsForImportStatements: true,
          includeCompletionsWithInsertText: true,
        },
        (entry as { data?: ts.CompletionEntryData }).data,
      ) || undefined;
    } catch {
      return undefined;
    }
  }

  private _completionAdditionalEdits(details: ts.CompletionEntryDetails): LanguageEdit[] {
    const edits: LanguageEdit[] = [];
    for (const action of details.codeActions || []) {
      for (const change of action.changes || []) {
        const changedPath = normalizePath(change.fileName);
        const currentContent = this._overlays.get(changedPath)?.content || ts.sys.readFile(changedPath) || '';
        const source = this._sourceFile(changedPath, currentContent);
        for (const textChange of change.textChanges) {
          edits.push({
            path: relativeToRoot(this._root, changedPath),
            range: rangeFromOffsets(source, textChange.span.start, textChange.span.length),
            text: textChange.newText,
          });
        }
      }
    }
    return edits;
  }
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
interface LspLocation { uri: string; range: LspRange }
interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value?: string };
  insertText?: string;
  sortText?: string;
  textEdit?: { range?: LspRange; newText?: string } | { insert?: LspRange; replace?: LspRange; newText?: string };
}

class PyrightLspClient {
  private readonly _root: string;
  private _child: ChildProcessWithoutNullStreams | null = null;
  private _buffer = Buffer.alloc(0);
  private _nextId = 1;
  private _ready: Promise<void> | null = null;
  private _pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private _openDocs = new Map<string, number>();
  private _diagnostics = new Map<string, LspDiagnostic[]>();

  constructor(root: string) {
    this._root = normalizePath(root);
  }

  async completions(fileName: string, content: string, pos: LanguagePosition): Promise<LanguageCompletionItem[]> {
    await this._syncDocument(fileName, content);
    const result = await this._request('textDocument/completion', {
      textDocument: { uri: pathToFileURL(fileName).href },
      position: { line: Math.max(0, pos.line - 1), character: Math.max(0, pos.column - 1) },
      context: { triggerKind: 1 },
    }, 6000);
    const items = Array.isArray(result) ? result : Array.isArray((result as { items?: unknown[] })?.items) ? (result as { items: unknown[] }).items : [];
    return (items as LspCompletionItem[]).slice(0, 160).map(item => ({
      label: item.label,
      kind: lspCompletionKind(item.kind),
      detail: item.detail,
      documentation: lspDocumentation(item.documentation),
      insertText: lspCompletionText(item),
      sortText: item.sortText,
      range: lspCompletionRange(item),
    }));
  }

  async hover(fileName: string, content: string, pos: LanguagePosition): Promise<LanguageHover | null> {
    await this._syncDocument(fileName, content);
    const result = await this._request('textDocument/hover', {
      textDocument: { uri: pathToFileURL(fileName).href },
      position: { line: Math.max(0, pos.line - 1), character: Math.max(0, pos.column - 1) },
    }, 6000) as { contents?: unknown; range?: LspRange } | null;
    const contents = lspHoverContents(result?.contents);
    if (!contents) return null;
    return { contents, range: result?.range ? lspRangeToMonaco(result.range) : undefined };
  }

  async definition(fileName: string, content: string, pos: LanguagePosition): Promise<LanguageLocation[]> {
    await this._syncDocument(fileName, content);
    const result = await this._request('textDocument/definition', {
      textDocument: { uri: pathToFileURL(fileName).href },
      position: { line: Math.max(0, pos.line - 1), character: Math.max(0, pos.column - 1) },
    }, 6000);
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    return (locations as LspLocation[]).slice(0, 20).map(location => {
      const abs = normalizePath(fileURLToPath(location.uri));
      const rel = isInside(this._root, abs) ? relativeToRoot(this._root, abs) : abs;
      return {
        path: rel,
        absolutePath: abs,
        external: !isInside(this._root, abs),
        range: lspRangeToMonaco(location.range),
      };
    });
  }

  async diagnostics(fileName: string, content: string): Promise<LanguageDiagnostic[]> {
    await this._syncDocument(fileName, content);
    const uri = pathToFileURL(fileName).href;
    try {
      const pulled = await this._request('textDocument/diagnostic', {
        textDocument: { uri },
      }, 3000) as { items?: LspDiagnostic[] } | null;
      if (Array.isArray(pulled?.items)) {
        this._diagnostics.set(uri, pulled.items);
        return this._mapDiagnostics(fileName, pulled.items);
      }
    } catch {
      // Older language servers may only support publishDiagnostics.
    }
    const deadline = Date.now() + 900;
    while (!this._diagnostics.has(uri) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return this._mapDiagnostics(fileName, this._diagnostics.get(uri) || []);
  }

  private _mapDiagnostics(fileName: string, diagnostics: LspDiagnostic[]): LanguageDiagnostic[] {
    return diagnostics.slice(0, 220).map(diagnostic => ({
      path: relativeToRoot(this._root, fileName),
      severity: diagnostic.severity === 1 ? 'error' : diagnostic.severity === 2 ? 'warning' : diagnostic.severity === 4 ? 'hint' : 'info',
      code: diagnostic.code,
      message: diagnostic.message,
      range: lspRangeToMonaco(diagnostic.range),
      source: 'pyright',
    }));
  }

  dispose(): void {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Pyright stopped'));
    }
    this._pending.clear();
    this._child?.kill();
    this._child = null;
    this._ready = null;
  }

  private async _syncDocument(fileName: string, content: string): Promise<void> {
    await this._ensureStarted();
    const uri = pathToFileURL(fileName).href;
    const version = (this._openDocs.get(uri) || 0) + 1;
    this._openDocs.set(uri, version);
    this._diagnostics.delete(uri);
    if (version === 1) {
      this._notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version, text: content },
      });
    } else {
      this._notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
  }

  private async _ensureStarted(): Promise<void> {
    if (this._ready) return this._ready;
    this._ready = this._start();
    return this._ready;
  }

  private async _start(): Promise<void> {
    const serverPath = findPyrightServerPath();
    if (!serverPath) throw new Error('Pyright language server not found');
    const child = spawn(process.execPath, [serverPath, '--stdio'], {
      cwd: this._root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    this._child = child;
    child.stdout.on('data', chunk => this._read(chunk));
    child.stderr.on('data', () => { /* Pyright writes informational logs here. */ });
    child.on('exit', () => {
      this._child = null;
      this._ready = null;
      for (const pending of this._pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Pyright language server exited'));
      }
      this._pending.clear();
    });

    await this._request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this._root).href,
      workspaceFolders: [{ uri: pathToFileURL(this._root).href, name: path.basename(this._root) || 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          completion: { completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: { workspaceFolders: true },
      },
      initializationOptions: {},
    }, 12000);
    this._notify('initialized', {});
  }

  private _request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this._nextId++;
    this._write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  private _notify(method: string, params: unknown): void {
    this._write({ jsonrpc: '2.0', method, params });
  }

  private _write(message: unknown): void {
    if (!this._child) throw new Error('Pyright language server is not running');
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this._child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this._child.stdin.write(body);
  }

  private _read(chunk: Buffer): void {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (true) {
      const headerEnd = this._buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this._buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this._buffer = this._buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const total = headerEnd + 4 + length;
      if (this._buffer.length < total) return;
      const raw = this._buffer.subarray(headerEnd + 4, total).toString('utf8');
      this._buffer = this._buffer.subarray(total);
      try { this._handle(JSON.parse(raw)); }
      catch { /* ignore malformed LSP payload */ }
    }
  }

  private _handle(message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown }): void {
    if (typeof message.id === 'number') {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'LSP request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) this._diagnostics.set(params.uri, params.diagnostics || []);
    }
  }
}

function findPyrightServerPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules', 'pyright', 'langserver.index.js'),
    path.resolve(process.cwd(), 'app.asar.unpacked', 'node_modules', 'pyright', 'langserver.index.js'),
    path.resolve(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'node_modules', 'pyright', 'langserver.index.js'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function lspCompletionKind(kind?: number): string {
  const labels = [
    '', 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface',
    'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', 'color', 'file',
    'reference', 'folder', 'enumMember', 'constant', 'struct', 'event', 'operator', 'typeParameter',
  ];
  return labels[kind || 0] || 'text';
}

function lspDocumentation(doc: LspCompletionItem['documentation']): string | undefined {
  if (!doc) return undefined;
  if (typeof doc === 'string') return doc;
  return doc.value;
}

function lspCompletionText(item: LspCompletionItem): string {
  if (item.textEdit && 'newText' in item.textEdit && typeof item.textEdit.newText === 'string') return item.textEdit.newText;
  return item.insertText || item.label;
}

function lspCompletionRange(item: LspCompletionItem): LanguageRange | undefined {
  const edit = item.textEdit;
  if (!edit) return undefined;
  if ('range' in edit && edit.range) return lspRangeToMonaco(edit.range);
  if ('replace' in edit && edit.replace) return lspRangeToMonaco(edit.replace);
  if ('insert' in edit && edit.insert) return lspRangeToMonaco(edit.insert);
  return undefined;
}

function lspHoverContents(contents: unknown): string {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(lspHoverContents).filter(Boolean).join('\n\n');
  const obj = contents as { value?: string; language?: string };
  if (obj.value && obj.language) return `\`\`\`${obj.language}\n${obj.value}\n\`\`\``;
  if (obj.value) return obj.value;
  return '';
}

export class LanguageIntelligenceService {
  private static _instance: LanguageIntelligenceService | null = null;
  private readonly _ts = new Map<string, TsWorkspaceService>();
  private readonly _pyright = new Map<string, PyrightLspClient>();

  static getInstance(): LanguageIntelligenceService {
    if (!this._instance) this._instance = new LanguageIntelligenceService();
    return this._instance;
  }

  static resetInstance(): void {
    this._instance?.dispose();
    this._instance = null;
  }

  complete(req: LanguageRequest): Promise<LanguageCompletionItem[]> | LanguageCompletionItem[] {
    const context = this._context(req);
    if (context.language === 'python') return this._py(context.root).completions(context.fileName, req.content, context.position);
    if (context.language === 'typescript' || context.language === 'javascript') return this._tsService(context.root).completions(context.fileName, req.content, context.position);
    return [];
  }

  hover(req: LanguageRequest): Promise<LanguageHover | null> | LanguageHover | null {
    const context = this._context(req);
    if (context.language === 'python') return this._py(context.root).hover(context.fileName, req.content, context.position);
    if (context.language === 'typescript' || context.language === 'javascript') return this._tsService(context.root).hover(context.fileName, req.content, context.position);
    return null;
  }

  definition(req: LanguageRequest): Promise<LanguageLocation[]> | LanguageLocation[] {
    const context = this._context(req);
    if (context.language === 'python') return this._py(context.root).definition(context.fileName, req.content, context.position);
    if (context.language === 'typescript' || context.language === 'javascript') return this._tsService(context.root).definition(context.fileName, req.content, context.position);
    return [];
  }

  diagnostics(req: LanguageRequest): Promise<LanguageDiagnostic[]> | LanguageDiagnostic[] {
    const context = this._context(req);
    if (context.language === 'python') return this._py(context.root).diagnostics(context.fileName, req.content);
    if (context.language === 'typescript' || context.language === 'javascript') return this._tsService(context.root).diagnostics(context.fileName, req.content);
    return [];
  }

  organizeImports(req: LanguageRequest): LanguageEdit[] {
    const context = this._context(req);
    if (context.language !== 'typescript' && context.language !== 'javascript') return [];
    return this._tsService(context.root).organizeImports(context.fileName, req.content);
  }

  dispose(): void {
    for (const pyright of this._pyright.values()) pyright.dispose();
    this._pyright.clear();
    this._ts.clear();
  }

  private _context(req: LanguageRequest): { root: string; fileName: string; language: LanguageKind; position: LanguagePosition } {
    const root = normalizePath(req.workspaceRoot);
    const fileName = normalizePath(req.filePath);
    if (!isInside(root, fileName)) throw new Error('Path escapes workspace root');
    return {
      root,
      fileName,
      language: detectLanguage(fileName, req.language),
      position: { line: req.line, column: req.column },
    };
  }

  private _tsService(root: string): TsWorkspaceService {
    const key = normalizePath(root);
    let service = this._ts.get(key);
    if (!service) {
      service = new TsWorkspaceService(key);
      this._ts.set(key, service);
    }
    return service;
  }

  private _py(root: string): PyrightLspClient {
    const key = normalizePath(root);
    let client = this._pyright.get(key);
    if (!client) {
      client = new PyrightLspClient(key);
      this._pyright.set(key, client);
    }
    return client;
  }
}
