// GrepTool - regex pattern search in file contents
// Based on Claude Code's GrepTool pattern. Uses ripgrep (rg) if available,
// falls back to recursive manual search with Node.js fs.
// RiskLevel: Safe (read-only).

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import micromatch from 'micromatch';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

/** Output modes supported by grep. */
type OutputMode = 'content' | 'files_with_matches' | 'count';

/** Maximum total output characters. */
const MAX_OUTPUT_CHARS = 25000;
const MIN_OUTPUT_CHARS = 100;
const DEFAULT_HEAD_LIMIT = 250;
const MAX_HEAD_LIMIT = 5000;
const DEFAULT_RG_TIMEOUT_MS = 15000;
const MAX_RG_TIMEOUT_MS = 60000;
const MAX_RG_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_MANUAL_SCANNED_FILES = 50000;
const MAX_MANUAL_FILE_BYTES = 2 * 1024 * 1024;

let cachedRipgrepPath: string | null | undefined;
type ManualReadFile = (filePath: string, encoding: 'utf-8') => Promise<string>;
let manualReadFile: ManualReadFile = (filePath, encoding) => fs.readFile(filePath, encoding);

export function setCachedRipgrepPathForTests(value: string | null | undefined): void {
  cachedRipgrepPath = value;
}

export function setManualGrepReadFileForTests(readFile?: ManualReadFile): void {
  manualReadFile = readFile ?? ((filePath, encoding) => fs.readFile(filePath, encoding));
}

export class GrepTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Powerful search tool built on ripgrep for searching file contents.';
  name(): string {
    return 'Grep';
  }

  description(): string {
    return 'Search file contents using regular expressions or literal text. Supports ripgrep syntax, glob and type filtering, hidden-file opt-in, multiple output modes (content with context, file paths, or match counts), multiline mode, cancellation, and explicit timeout feedback. Output limit: 25,000 characters. For broad searches, prefer files_with_matches output mode to avoid truncation.';
  }

  prompt(): string {
    return '## Grep Usage\n' +
      '- ALWAYS use Grep for content search - NEVER invoke grep or rg via Bash\n' +
      '- For open-ended searches requiring multiple rounds, use the Agent tool instead\n' +
      '- Pattern syntax uses ripgrep (not grep) - literal braces need escaping: use `interface\\{\\}` to find `interface{}` in Go code\n' +
      '- Use literal=true for exact text searches so special regex characters are not interpreted\n' +
      '- Files with matches output mode is fastest for broad searches\n' +
      '- Output limit: 25,000 characters max. Use head_limit or max_output_chars for narrower results. Invalid numeric/boolean parameters fail fast instead of being silently corrected.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description: 'The regular expression pattern to search for in file contents',
        },
        path: {
          type: 'string',
          description:
            'File or directory to search in. Defaults to current working directory.',
        },
        glob: {
          type: 'string',
          description:
            'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}"). Maps to rg --glob.',
        },
        literal: {
          type: 'boolean',
          description: 'Treat pattern as literal text instead of a regular expression (rg -F).',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden files and directories. .git and node_modules remain excluded.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description:
            'Output mode: "content" shows matching lines,' +
            ' "files_with_matches" shows file paths (default),' +
            ' "count" shows match counts.',
        },
        '-A': {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Number of lines to show after each match (rg -A).',
        },
        '-B': {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Number of lines to show before each match (rg -B).',
        },
        '-C': {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Number of lines to show before and after each match (rg -C).',
        },
        '-i': {
          type: 'boolean',
          description: 'Case insensitive search (rg -i).',
        },
        '-n': {
          type: 'boolean',
          description: 'Show line numbers in output (rg -n). Defaults to true for content mode.',
        },
        type: {
          type: 'string',
          description: 'File type to search (rg --type). Common types: js, py, rust, go, java, etc.',
        },
        head_limit: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_HEAD_LIMIT,
          description:
            `Limit output to first N lines/entries. Defaults to ${DEFAULT_HEAD_LIMIT}. Pass 0 for unlimited. Maximum ${MAX_HEAD_LIMIT}.`,
        },
        multiline: {
          type: 'boolean',
          description: 'Enable multiline mode where . matches newlines (rg -U --multiline-dotall). Default: false.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: MAX_RG_TIMEOUT_MS,
          description: `Ripgrep execution timeout in milliseconds. Default ${DEFAULT_RG_TIMEOUT_MS}, maximum ${MAX_RG_TIMEOUT_MS}.`,
        },
        max_output_chars: {
          type: 'integer',
          minimum: MIN_OUTPUT_CHARS,
          maximum: MAX_OUTPUT_CHARS,
          description: `Maximum output characters returned by this tool. Default ${MAX_OUTPUT_CHARS}, min ${MIN_OUTPUT_CHARS}, max ${MAX_OUTPUT_CHARS}.`,
        },
      },
      required: ['pattern'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isReadOnly(): boolean {
    return true;
  }

  isConcurrencySafe(): boolean {
    return true;
  }

  workspacePathParams(): string[] {
    return ['path'];
  }

  outputLimit(): number {
    return 25000; // grep results can be verbose
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) || ctx.workspace;
    const globFilter = params.glob as string | undefined;
    const outputMode = normalizeOutputMode(params.output_mode as string | undefined);
    const afterResult = normalizeInteger(params['-A'], '-A', 0, 0, 100);
    if (afterResult.error) return this.makeError(afterResult.error);
    const after = afterResult.value as number;

    const beforeResult = normalizeInteger(params['-B'], '-B', 0, 0, 100);
    if (beforeResult.error) return this.makeError(beforeResult.error);
    const before = beforeResult.value as number;

    const contextResult = normalizeInteger(params['-C'], '-C', 0, 0, 100);
    if (contextResult.error) return this.makeError(contextResult.error);
    const contextLines = contextResult.value as number;

    const caseInsensitiveResult = normalizeBoolean(params['-i'], '-i', false);
    if (caseInsensitiveResult.error) return this.makeError(caseInsensitiveResult.error);
    const caseInsensitive = caseInsensitiveResult.value as boolean;

    const showLineNumbersResult = normalizeBoolean(params['-n'], '-n', true);
    if (showLineNumbersResult.error) return this.makeError(showLineNumbersResult.error);
    const showLineNumbers = showLineNumbersResult.value as boolean;

    const fileType = params.type as string | undefined;
    const headLimitResult = normalizeInteger(params.head_limit, 'head_limit', DEFAULT_HEAD_LIMIT, 0, MAX_HEAD_LIMIT);
    if (headLimitResult.error) return this.makeError(headLimitResult.error);
    const headLimit = headLimitResult.value as number;

    const multilineResult = normalizeBoolean(params.multiline, 'multiline', false);
    if (multilineResult.error) return this.makeError(multilineResult.error);
    const multiline = multilineResult.value as boolean;

    const literalResult = normalizeBoolean(params.literal, 'literal', false);
    if (literalResult.error) return this.makeError(literalResult.error);
    const literal = literalResult.value as boolean;

    const includeHiddenResult = normalizeBoolean(params.include_hidden, 'include_hidden', false);
    if (includeHiddenResult.error) return this.makeError(includeHiddenResult.error);
    const includeHidden = includeHiddenResult.value as boolean;

    const timeoutResult = normalizeInteger(params.timeout_ms, 'timeout_ms', DEFAULT_RG_TIMEOUT_MS, 1000, MAX_RG_TIMEOUT_MS);
    if (timeoutResult.error) return this.makeError(timeoutResult.error);
    const timeoutMs = timeoutResult.value as number;

    const maxOutputResult = normalizeInteger(params.max_output_chars, 'max_output_chars', MAX_OUTPUT_CHARS, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS);
    if (maxOutputResult.error) return this.makeError(maxOutputResult.error);
    const maxOutputChars = maxOutputResult.value as number;

    if (!pattern || typeof pattern !== 'string') {
      return this.makeError('pattern is required');
    }
    if (!outputMode) {
      return this.makeError('output_mode must be one of: content, files_with_matches, count');
    }

    const startedAt = Date.now();

    try {
      const resolved = path.isAbsolute(searchPath)
        ? searchPath
        : path.resolve(ctx.workspace, searchPath);

      if (ctx.signal?.aborted) {
        return this.makeError('Grep cancelled by user before search started', { startedAt });
      }

      // Verify path exists
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(resolved);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`Path does not exist: ${searchPath}`);
        }
        throw err;
      }

      // Try ripgrep first, fall back to manual search
      let output: string;
      let wasTruncated = false;
      let backend: 'ripgrep' | 'manual' = 'ripgrep';
      let notes: string[] = [];
      const rgResult = await tryRipgrep(pattern, resolved, {
        glob: globFilter,
        after, before, context: contextLines,
        caseInsensitive, showLineNumbers, fileType, headLimit, multiline,
        outputMode, literal, includeHidden, timeoutMs,
        cwd: stat.isDirectory() ? resolved : path.dirname(resolved),
      }, ctx.signal);

      if (rgResult.kind === 'success') {
        output = rgResult.output;
        wasTruncated = rgResult.wasTruncated;
      } else if (rgResult.kind === 'error') {
        return this.makeError(rgResult.message, {
          startedAt,
          structured: {
            backend: 'ripgrep',
            failure: rgResult.failure,
          },
        });
      } else {
        backend = 'manual';
        const manualResult = await manualGrep(resolved, pattern, {
          glob: globFilter,
          caseInsensitive, headLimit, outputMode, literal, includeHidden, multiline,
          showLineNumbers,
          beforeLines: contextLines || before,
          afterLines: contextLines || after,
          timeoutMs,
        }, ctx.signal);
        if (manualResult.error) {
          return this.makeError(manualResult.error, {
            startedAt,
            structured: { backend: 'manual', failure: manualResult.failure },
          });
        }
        output = manualResult.output;
        wasTruncated = manualResult.wasTruncated;
        notes = manualResult.notes;
        if (manualResult.notes.length > 0) {
          output = output.trimEnd() + `\n(${manualResult.notes.join(' ')})`;
        }
      }

      // Trim and let pipeline normalize via outputLimit: 25000
      let trimmed = output.trim();
      if (!trimmed) trimmed = '(no matches)';
      const charLimited = applyCharLimit(trimmed, maxOutputChars);
      trimmed = charLimited.output;
      wasTruncated = wasTruncated || charLimited.wasTruncated;

      return this.makeResult(trimmed, {
        startedAt,
        wasTruncated,
        structured: {
          backend,
          pattern,
          path: resolved,
          outputMode,
          literal,
          includeHidden,
          glob: globFilter,
          type: fileType,
          headLimit,
          maxOutputChars,
          timeoutMs,
          multiline,
          resultLines: trimmed === '(no matches)' ? 0 : trimmed.split(/\r?\n/).length,
          truncatedByChars: charLimited.wasTruncated,
          wasTruncated,
          notes,
        },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Grep failed: ${errMsg}`);
    }
  }

  // ── UI helpers ──

  userFacingName(_input?: Record<string, unknown>): string {
    return 'Search';
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (input?.pattern && typeof input.pattern === 'string') {
      return this.truncate(input.pattern, 50);
    }
    return null;
  }

  getActivityDescription(_input?: Record<string, unknown>): string | null {
    return 'Searching';
  }

  isSearchOrRead(): { isSearch: boolean; isRead: boolean } {
    return { isSearch: true, isRead: false };
  }
}

// ── Ripgrep helper ──

interface RipgrepOptions {
  glob?: string;
  after: number;
  before: number;
  context: number;
  caseInsensitive: boolean;
  showLineNumbers: boolean;
  fileType?: string;
  headLimit: number;
  multiline: boolean;
  outputMode: OutputMode;
  literal: boolean;
  includeHidden: boolean;
  timeoutMs: number;
  cwd: string;
}

type RipgrepResult =
  | { kind: 'unavailable' }
  | { kind: 'success'; output: string; wasTruncated: boolean }
  | { kind: 'error'; message: string; failure: 'aborted' | 'timeout' | 'invalid_pattern' | 'runtime' };

async function tryRipgrep(
  pattern: string,
  searchPath: string,
  opts: RipgrepOptions,
  signal?: AbortSignal,
): Promise<RipgrepResult> {
  const rgBin = findRipgrep();
  if (!rgBin) return { kind: 'unavailable' };

  const args = buildRipgrepArgs(pattern, searchPath, opts);
  const result = await runProcess(rgBin, args, opts.cwd, opts.timeoutMs, signal);

  if (result.aborted) {
    return { kind: 'error', message: 'Grep cancelled by user', failure: 'aborted' };
  }
  if (result.timedOut) {
    return {
      kind: 'error',
      message: `Grep timed out after ${opts.timeoutMs}ms. Narrow path/pattern or increase timeout_ms.`,
      failure: 'timeout',
    };
  }
  if (result.spawnError) {
    return { kind: 'unavailable' };
  }
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const stderr = result.stderr.trim();
    const failure = stderr.toLowerCase().includes('regex parse error') ? 'invalid_pattern' : 'runtime';
    return {
      kind: 'error',
      message: stderr || `ripgrep exited with code ${result.exitCode}`,
      failure,
    };
  }

  let output = result.stdout;
  if (result.stderr.trim()) {
    output = output.trimEnd() + `\n[warnings]\n${result.stderr.trim()}`;
  }

  const limited = applyHeadLimit(output, opts.headLimit);
  if (result.bufferExceeded) {
    limited.output = limited.output.trimEnd() +
      `\n... [output buffer exceeded ${MAX_RG_BUFFER_BYTES} bytes; results truncated]`;
  }

  return {
    kind: 'success',
    output: limited.output,
    wasTruncated: limited.wasTruncated || result.bufferExceeded,
  };
}

function findRipgrep(): string | null {
  if (cachedRipgrepPath !== undefined) return cachedRipgrepPath;

  const rgPaths = [
    'rg',
    'C:\\Program Files\\Git\\usr\\bin\\rg.exe',
  ];

  for (const p of rgPaths) {
    try {
      const check = spawnSync(p, ['--version'], {
        timeout: 3000,
        encoding: 'utf-8',
        windowsHide: true,
      });
      if (check.status === 0 && check.stdout?.includes('ripgrep')) {
        cachedRipgrepPath = p;
        return cachedRipgrepPath;
      }
    } catch {
      // continue
    }
  }
  cachedRipgrepPath = null;
  return cachedRipgrepPath;
}

function buildRipgrepArgs(pattern: string, searchPath: string, opts: RipgrepOptions): string[] {
  const args: string[] = [];
  args.push('--color=never', '--no-heading', '--with-filename');

  if (opts.outputMode === 'files_with_matches') {
    args.push('-l');
  } else if (opts.outputMode === 'count') {
    args.push('-c');
  }

  if (opts.context) {
    args.push('-C', String(opts.context));
  } else {
    if (opts.after) args.push('-A', String(opts.after));
    if (opts.before) args.push('-B', String(opts.before));
  }

  if (opts.caseInsensitive) args.push('-i');
  if (opts.showLineNumbers) args.push('-n');
  if (opts.multiline) args.push('-U', '--multiline-dotall');
  if (opts.literal) args.push('-F');
  if (opts.includeHidden) args.push('--hidden');

  if (opts.fileType) args.push('--type', opts.fileType);
  if (opts.glob) args.push('--glob', opts.glob);

  args.push('--no-ignore-vcs');
  args.push('-g', '!.git');
  args.push('-g', '!node_modules');
  args.push('-e', pattern, searchPath);
  return args;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: string;
  timedOut: boolean;
  aborted: boolean;
  bufferExceeded: boolean;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let bufferExceeded = false;

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const cleanupFns: Array<() => void> = [];
    const cleanup = () => {
      for (const cleanupFn of cleanupFns) cleanupFn();
    };

    const settle = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const killChild = () => {
      if (!child.killed) {
        try { child.kill(); } catch { /* ignore */ }
      }
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    cleanupFns.push(() => clearTimeout(timeoutId));

    if (signal) {
      const onAbort = () => {
        aborted = true;
        killChild();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupFns.push(() => signal.removeEventListener('abort', onAbort));
      }
    }

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const nextBytes = chunk.byteLength;
      if (target === 'stdout') {
        stdoutBytes += nextBytes;
        if (stdoutBytes <= MAX_RG_BUFFER_BYTES) {
          stdout += chunk.toString('utf-8');
        } else {
          bufferExceeded = true;
          killChild();
        }
      } else {
        stderrBytes += nextBytes;
        if (stderrBytes <= MAX_RG_BUFFER_BYTES) {
          stderr += chunk.toString('utf-8');
        } else {
          bufferExceeded = true;
          killChild();
        }
      }
    };

    child.stdout.on('data', chunk => appendChunk('stdout', chunk));
    child.stderr.on('data', chunk => appendChunk('stderr', chunk));

    child.on('error', err => {
      settle({
        stdout,
        stderr,
        exitCode: null,
        spawnError: err.message,
        timedOut,
        aborted,
        bufferExceeded,
      });
    });

    child.on('close', code => {
      settle({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        aborted,
        bufferExceeded,
      });
    });
  });
}

// Manual grep fallback

interface ManualGrepOptions {
  glob?: string;
  caseInsensitive: boolean;
  headLimit: number;
  outputMode: OutputMode;
  beforeLines: number;
  afterLines: number;
  showLineNumbers: boolean;
  literal: boolean;
  includeHidden: boolean;
  multiline: boolean;
  timeoutMs: number;
}

interface ManualGrepResult {
  output: string;
  wasTruncated: boolean;
  notes: string[];
  error?: string;
  failure?: string;
}

class ManualGrepControlError extends Error {
  constructor(
    message: string,
    readonly failure: 'aborted' | 'timeout',
  ) {
    super(message);
    this.name = 'ManualGrepControlError';
  }
}

async function manualGrep(
  searchPath: string,
  pattern: string,
  opts: ManualGrepOptions,
  signal?: AbortSignal,
): Promise<ManualGrepResult> {
  if (opts.multiline) {
    return {
      output: '',
      wasTruncated: false,
      notes: [],
      error: 'multiline search requires ripgrep, but ripgrep is unavailable',
      failure: 'unsupported_mode',
    };
  }

  let regex: RegExp;
  let countRegex: RegExp;
  try {
    const source = opts.literal ? escapeRegExp(pattern) : pattern;
    const flags = opts.caseInsensitive ? 'i' : '';
    regex = new RegExp(source, flags);
    countRegex = new RegExp(source, flags + 'g');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: '',
      wasTruncated: false,
      notes: [],
      error: `Invalid regex pattern: ${msg}`,
      failure: 'invalid_pattern',
    };
  }

  const results: string[] = [];
  const fileCounts: Map<string, number> = new Map();
  const notes: string[] = [];
  let scannedFiles = 0;
  let scanTruncated = false;
  let skippedLargeFiles = 0;
  const deadline = Date.now() + opts.timeoutMs;

  const isLimited = () => opts.headLimit > 0 && results.length >= opts.headLimit;
  const ensureNotAborted = () => {
    if (signal?.aborted) throw new ManualGrepControlError('Grep cancelled by user', 'aborted');
    if (Date.now() >= deadline) {
      throw new ManualGrepControlError(
        `Grep manual fallback timed out after ${opts.timeoutMs}ms. Narrow path/pattern or increase timeout_ms.`,
        'timeout',
      );
    }
  };
  const withDeadline = async <T>(promise: Promise<T>, operation: string): Promise<T> => {
    ensureNotAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ManualGrepControlError(
        `Grep manual fallback timed out after ${opts.timeoutMs}ms. Narrow path/pattern or increase timeout_ms.`,
        'timeout',
      );
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let removeAbort: (() => void) | null = null;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        removeAbort?.();
        fn();
      };

      timeout = setTimeout(() => {
        settle(() => reject(new ManualGrepControlError(
          `Grep manual fallback timed out after ${opts.timeoutMs}ms during ${operation}. Narrow path/pattern or increase timeout_ms.`,
          'timeout',
        )));
      }, remainingMs);

      if (signal) {
        const onAbort = () => {
          settle(() => reject(new ManualGrepControlError('Grep cancelled by user', 'aborted')));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbort = () => signal.removeEventListener('abort', onAbort);
      }

      promise.then(
        value => settle(() => resolve(value)),
        err => settle(() => reject(err)),
      );
    });
  };

  async function processFile(fullPath: string, displayPath: string): Promise<void> {
    ensureNotAborted();
    if (isLimited()) return;
    scannedFiles++;
    if (scannedFiles > MAX_MANUAL_SCANNED_FILES) {
      scanTruncated = true;
      return;
    }

    try {
      const fileStat = await withDeadline(fs.stat(fullPath), 'file stat');
      if (fileStat.size > MAX_MANUAL_FILE_BYTES) {
        skippedLargeFiles++;
        return;
      }
    } catch (err) {
      if (err instanceof ManualGrepControlError) throw err;
      return;
    }

    try {
      const content = await withDeadline(manualReadFile(fullPath, 'utf-8'), 'file read');
      if (content.includes('\u0000')) return;
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        ensureNotAborted();
        if (isLimited()) break;

        const line = lines[i];
        if (!regex.test(line)) continue;

        if (opts.outputMode === 'files_with_matches') {
          if (!fileCounts.has(displayPath)) {
            results.push(displayPath);
            fileCounts.set(displayPath, 1);
          }
          continue;
        }

        if (opts.outputMode === 'count') {
          fileCounts.set(displayPath, (fileCounts.get(displayPath) || 0) + countMatches(line, countRegex));
          continue;
        }

        if (opts.beforeLines > 0 || opts.afterLines > 0) {
          const start = Math.max(0, i - opts.beforeLines);
          const end = Math.min(lines.length, i + opts.afterLines + 1);
          results.push(`--- ${formatLocation(displayPath, i + 1, opts.showLineNumbers)} ---`);
          for (let j = start; j < end; j++) {
            const marker = j === i ? '>' : ' ';
            results.push(`${marker}${formatLocation('', j + 1, opts.showLineNumbers)}${lines[j]}`);
          }
        } else {
          results.push(`${formatLocation(displayPath, i + 1, opts.showLineNumbers)}${line.trim()}`);
        }
      }
    } catch (err) {
      if (err instanceof ManualGrepControlError) throw err;
      // Skip unreadable files
    }
  }

  async function walk(dir: string): Promise<void> {
    ensureNotAborted();
    if (isLimited() || scanTruncated) return;

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await withDeadline(fs.readdir(dir, { withFileTypes: true }), 'directory read');
    } catch (err) {
      if (err instanceof ManualGrepControlError) throw err;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      ensureNotAborted();
      if (isLimited() || scanTruncated) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (!opts.includeHidden && entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(searchPath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (opts.glob && !micromatch.isMatch(relative, opts.glob)) continue;
        await processFile(fullPath, fullPath);
      }
    }
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await withDeadline(fs.stat(searchPath), 'path stat');
  } catch (err) {
    if (err instanceof ManualGrepControlError) {
      return { output: '', wasTruncated: false, notes: [], error: err.message, failure: err.failure };
    }
    return { output: '', wasTruncated: false, notes: [] };
  }

  try {
    if (stat.isFile()) {
      await processFile(searchPath, searchPath);
    } else {
      await walk(searchPath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: '',
      wasTruncated: false,
      notes: [],
      error: message,
      failure: err instanceof ManualGrepControlError ? err.failure : signal?.aborted ? 'aborted' : 'runtime',
    };
  }

  if (opts.outputMode === 'count') {
    const formatted: string[] = [];
    for (const [file, count] of fileCounts) {
      formatted.push(`${file}: ${count} matches`);
    }
    const limited = applyHeadLimit(formatted.join('\n'), opts.headLimit);
    if (scanTruncated) notes.push(`Manual scan stopped after ${MAX_MANUAL_SCANNED_FILES} files.`);
    if (skippedLargeFiles > 0) notes.push(`${skippedLargeFiles} files over ${MAX_MANUAL_FILE_BYTES} bytes were skipped by manual fallback.`);
    return {
      output: limited.output,
      wasTruncated: limited.wasTruncated || scanTruncated || skippedLargeFiles > 0,
      notes,
    };
  }

  if (scanTruncated) notes.push(`Manual scan stopped after ${MAX_MANUAL_SCANNED_FILES} files.`);
  if (skippedLargeFiles > 0) notes.push(`${skippedLargeFiles} files over ${MAX_MANUAL_FILE_BYTES} bytes were skipped by manual fallback.`);
  return {
    output: results.join('\n'),
    wasTruncated: isLimited() || scanTruncated || skippedLargeFiles > 0,
    notes,
  };
}

function normalizeOutputMode(value: string | undefined): OutputMode | null {
  if (!value) return 'files_with_matches';
  if (value === 'content' || value === 'files_with_matches' || value === 'count') return value;
  return null;
}

function normalizeInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
  const integer = Math.trunc(value);
  if (integer < min) return { error: `${name} must be at least ${min}` };
  if (integer > max) return { error: `${name} must be ${max} or less` };
  return { value: integer };
}

function normalizeBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'boolean') return { error: `${name} must be a boolean` };
  return { value };
}

function applyHeadLimit(output: string, headLimit: number): { output: string; wasTruncated: boolean } {
  if (headLimit <= 0 || !output) return { output, wasTruncated: false };
  const lines = output.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= headLimit) return { output: lines.join('\n'), wasTruncated: false };
  return {
    output: lines.slice(0, headLimit).join('\n') + `\n... [${lines.length - headLimit} more results]`,
    wasTruncated: true,
  };
}

function applyCharLimit(output: string, maxChars: number): { output: string; wasTruncated: boolean } {
  if (output.length <= maxChars) return { output, wasTruncated: false };
  return {
    output: `${output.slice(0, maxChars).trimEnd()}\n... [Grep output truncated at ${maxChars} characters]`,
    wasTruncated: true,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(line: string, regex: RegExp): number {
  regex.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    count++;
    if (match[0] === '') regex.lastIndex++;
  }
  return count;
}

function formatLocation(file: string, line: number, showLineNumbers: boolean): string {
  if (!file) return showLineNumbers ? `${line}: ` : '';
  return showLineNumbers ? `${file}:${line}: ` : `${file}: `;
}
