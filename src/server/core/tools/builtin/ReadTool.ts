// ReadTool - reads a file from the local filesystem
// Supports offset/limit for partial reads, images, binary summaries, and PDFs.
// Based on Claude Code's FileReadTool pattern.

import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { Tool } from '../Tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

/** Maximum file size to read in one shot (256 KB). */
const MAX_SIZE_BYTES = 256 * 1024;

/** Maximum character output for text files. */
const MAX_OUTPUT_CHARS = 80000;
const MIN_OUTPUT_CHARS = 100;
const MAX_TAIL_LINES = 5000;
const MAX_LIMIT_LINES = 10000;
const MAX_DIRECTORY_ENTRIES = 500;
const DEFAULT_READ_TIMEOUT_MS = 15000;
const MIN_READ_TIMEOUT_MS = 1000;
const MAX_READ_TIMEOUT_MS = 60000;
const BINARY_SAMPLE_BYTES = 4096;
const DEFAULT_PDF_MAX_PAGES = 10;
const MAX_PDF_SELECTED_PAGES = 50;
const MAX_PAGES_SPEC_CHARS = 200;
const PARAM_KEYS = ['file_path', 'offset', 'limit', 'pages', 'tail', 'line_numbers', 'max_chars', 'timeout_ms'];

type ReadFileLike = (
  filePath: string,
  options?: BufferEncoding | { encoding?: BufferEncoding; signal?: AbortSignal },
) => Promise<string | Buffer>;

let readFileForTests: ReadFileLike | undefined;

export function setReadToolReadFileForTests(readFile?: ReadFileLike): void {
  readFileForTests = readFile;
}

export class ReadTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Reads local files or directory listings for grounded context.';
  name(): string {
    return 'Read';
  }

  description(): string {
    return 'Read a local file, extract text from PDF pages, or list a directory. Use offset and limit for large text files. Prefer this over shell commands for file inspection.';
  }

  prompt(): string {
    return [
      '## Read Usage',
      'Use Read to inspect files before proposing or making changes.',
      'Read only relevant files and avoid rereading unchanged content in the same turn.',
      'For large files, use offset and limit to inspect the relevant region.',
      'For PDFs, use pages such as "1-3,5" to extract specific page text.',
      'Use timeout_ms for slow filesystems, large directories, or PDF extraction.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description:
            'The absolute path to the file to read (must be absolute, not relative)',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          description:
            'The line number to start reading from. Only provide if the file is too large to read at once.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT_LINES,
          description:
            'The number of lines to read. Only provide if the file is too large to read at once.',
        },
        pages: {
          type: 'string',
          maxLength: MAX_PAGES_SPEC_CHARS,
          pattern: '^\\s*\\d+\\s*(?:-\\s*\\d+)?(?:\\s*,\\s*\\d+\\s*(?:-\\s*\\d+)?)*\\s*$',
          description:
            'Page range for PDF files (e.g., "1-5", "3", "10-20"). Defaults to the first pages.',
        },
        tail: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TAIL_LINES,
          description:
            `Read the last N lines of a text file. Useful for logs. Max ${MAX_TAIL_LINES}. Cannot be combined with offset/limit.`,
        },
        line_numbers: {
          type: 'boolean',
          description:
            'Prefix returned text lines with 1-based line numbers for precise references. Default false.',
        },
        max_chars: {
          type: 'integer',
          minimum: MIN_OUTPUT_CHARS,
          maximum: MAX_OUTPUT_CHARS,
          description:
            `Maximum characters returned by this tool. Default ${MAX_OUTPUT_CHARS}, min ${MIN_OUTPUT_CHARS}, max ${MAX_OUTPUT_CHARS}.`,
        },
        timeout_ms: {
          type: 'integer',
          minimum: MIN_READ_TIMEOUT_MS,
          maximum: MAX_READ_TIMEOUT_MS,
          description:
            `Maximum read time in milliseconds. Default ${DEFAULT_READ_TIMEOUT_MS}, min ${MIN_READ_TIMEOUT_MS}, max ${MAX_READ_TIMEOUT_MS}.`,
        },
      },
      required: ['file_path'],
      additionalProperties: false,
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
    return ['file_path'];
  }

  outputLimit(): number {
    return 80000; // Read outputs can be large (full files)
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const unexpectedParam = findUnexpectedParam(params, PARAM_KEYS);
    if (unexpectedParam) return this.makeError(`Unexpected parameter: "${unexpectedParam}"`);

    const filePathResult = normalizeRequiredString(params.file_path, 'file_path');
    if (filePathResult.error) return this.makeError(filePathResult.error);
    const filePath = filePathResult.value as string;

    const pagesResult = normalizePagesSpec(params.pages);
    if (pagesResult.error) return this.makeError(pagesResult.error);
    const pages = pagesResult.value;

    const offsetResult = normalizeOptionalInteger(params.offset, 'offset', 1, Number.MAX_SAFE_INTEGER);
    if (offsetResult.error) return this.makeError(offsetResult.error);
    const offset = offsetResult.value;

    const limitResult = normalizeOptionalInteger(params.limit, 'limit', 1, MAX_LIMIT_LINES);
    if (limitResult.error) return this.makeError(limitResult.error);
    const limit = limitResult.value;

    const tailResult = normalizeOptionalInteger(params.tail, 'tail', 1, MAX_TAIL_LINES);
    if (tailResult.error) return this.makeError(tailResult.error);
    const tail = tailResult.value;

    const lineNumbersResult = normalizeBoolean(params.line_numbers, 'line_numbers', false);
    if (lineNumbersResult.error) return this.makeError(lineNumbersResult.error);
    const lineNumbers = lineNumbersResult.value as boolean;

    const maxCharsResult = normalizeInteger(params.max_chars, 'max_chars', MAX_OUTPUT_CHARS, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS);
    if (maxCharsResult.error) return this.makeError(maxCharsResult.error);
    const maxChars = maxCharsResult.value as number;

    const timeoutResult = normalizeInteger(params.timeout_ms, 'timeout_ms', DEFAULT_READ_TIMEOUT_MS, MIN_READ_TIMEOUT_MS, MAX_READ_TIMEOUT_MS);
    if (timeoutResult.error) return this.makeError(timeoutResult.error);
    const timeoutMs = timeoutResult.value as number;

    if (tail !== undefined && (offset !== undefined || limit !== undefined)) {
      return this.makeError('tail cannot be combined with offset or limit');
    }

    const startedAt = Date.now();
    const budget = createReadBudget(ctx.signal, timeoutMs);

    try {
      const baseDir = ctx.workspace || process.cwd();
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(baseDir, filePath);

      // Check if the path exists and is not a directory
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await budget.race(fs.stat(resolved), 'checking file metadata');
      } catch (err: unknown) {
        if (isReadAbortError(err)) throw err;
        const errMsg = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? `File not found: ${filePath}`
          : `Cannot access file: ${filePath} - ${(err as Error).message}`;
        return this.makeError(errMsg);
      }

      if (stat.isDirectory()) {
        const listing = await listDirectory(resolved, budget);
        return this.makeResult(listing.content, {
          startedAt,
          wasTruncated: listing.wasTruncated,
          structured: {
            path: resolved,
            kind: 'directory',
            timeoutMs,
            entries: listing.entries,
            shownEntries: listing.shownEntries,
            truncatedByEntries: listing.wasTruncated,
          },
        });
      }

      budget.throwIfAborted('before file read started');

      // Handle different file types
      const ext = path.extname(resolved).toLowerCase();

      if (ext === '.pdf') {
        const pdf = await readPdfText(resolved, pages, maxChars, budget);
        return this.makeResult(pdf.content, {
          startedAt,
          wasTruncated: pdf.wasTruncated,
          structured: {
            path: resolved,
            kind: 'pdf',
            timeoutMs,
            sizeBytes: stat.size,
            pageCount: pdf.pageCount,
            selectedPages: pdf.selectedPages,
            truncatedByPages: pdf.truncatedByPages,
            truncatedByChars: pdf.truncatedByChars,
          },
        });
      }

      // Image files - note that we've read them but can't render inline here
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
        return this.makeResult(
          `[Image file: ${path.basename(resolved)}]\nSize: ${formatBytes(stat.size)}\nPath: ${resolved}`,
          {
            startedAt,
            structured: {
              path: resolved,
              kind: 'image',
              timeoutMs,
              sizeBytes: stat.size,
              extension: ext,
            },
          }
        );
      }

      if (await looksBinary(resolved, budget)) {
        return this.makeResult(
          `[Binary file: ${path.basename(resolved)}]\nSize: ${formatBytes(stat.size)}\nPath: ${resolved}`,
          {
            startedAt,
            structured: {
              path: resolved,
              kind: 'binary',
              timeoutMs,
              sizeBytes: stat.size,
              extension: ext,
            },
          }
        );
      }

      if (tail !== undefined) {
        const range = await readTextTail(resolved, tail, maxChars, lineNumbers, budget);
        return this.makeResult(range.content, {
          startedAt,
          wasTruncated: range.wasTruncated,
          structured: {
            path: resolved,
            kind: 'text',
            mode: 'tail',
            timeoutMs,
            sizeBytes: stat.size,
            lineStart: range.lineStart,
            lineEnd: range.lineEnd,
            linesRead: range.linesRead,
            totalLines: range.totalLines,
            requestedTail: tail,
            lineNumbers,
            maxChars,
            truncatedByLimit: range.truncatedByLimit,
            truncatedByChars: range.truncatedByChars,
          },
        });
      }

      // Check file size for full reads. Line ranges are streamed below.
      if (stat.size > MAX_SIZE_BYTES && offset === undefined && limit === undefined) {
        const sizeStr = formatBytes(stat.size);
        const maxStr = formatBytes(MAX_SIZE_BYTES);
        return this.makeError(
          `File is too large (${sizeStr}). Max size is ${maxStr}. Use offset/limit to read a portion.`
        );
      }

      if (offset !== undefined || limit !== undefined) {
        const range = await readTextLineRange(resolved, offset, limit, maxChars, lineNumbers, budget);
        return this.makeResult(range.content, {
          startedAt,
          wasTruncated: range.wasTruncated,
          structured: {
            path: resolved,
            kind: 'text',
            mode: 'range',
            timeoutMs,
            sizeBytes: stat.size,
            lineStart: range.lineStart,
            lineEnd: range.lineEnd,
            linesRead: range.linesRead,
            lineNumbers,
            maxChars,
            truncatedByLimit: range.truncatedByLimit,
            truncatedByChars: range.truncatedByChars,
          },
        });
      }

      // Read as text
      let content: string;
      try {
        const rawContent = await budget.race(
          readFile(resolved, { encoding: 'utf-8', signal: budget.signal }),
          'reading text file',
        );
        content = typeof rawContent === 'string' ? rawContent : rawContent.toString('utf-8');
      } catch (err: unknown) {
        if (isReadAbortError(err)) throw err;
        // Binary file fallback
        return this.makeResult(
          `[Binary file: ${path.basename(resolved)}]\nSize: ${formatBytes(stat.size)}`,
          {
            startedAt,
            structured: {
              path: resolved,
              kind: 'binary',
              timeoutMs,
              sizeBytes: stat.size,
              extension: ext,
            },
          }
        );
      }

      const prepared = lineNumbers
        ? addLineNumbers(content.split(/\r?\n/), 1)
        : content;
      const truncated = truncateText(prepared, maxChars);

      return this.makeResult(truncated.content, {
        startedAt,
        wasTruncated: truncated.wasTruncated,
        structured: {
          path: resolved,
          kind: 'text',
          mode: 'full',
          timeoutMs,
          sizeBytes: stat.size,
          lineNumbers,
          maxChars,
          charsRead: content.length,
          returnedChars: truncated.content.length,
          truncatedByChars: truncated.wasTruncated,
        },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(errMsg, {
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        structured: isReadAbortError(err)
          ? {
              status: err.status,
              operation: err.operation,
              timeoutMs: err.timeoutMs,
              filePath,
            }
          : undefined,
      });
    } finally {
      budget.cleanup();
    }
  }

  // ── UI helpers ──

  userFacingName(_input?: Record<string, unknown>): string {
    return 'Read';
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (input?.file_path && typeof input.file_path === 'string') {
      return path.basename(input.file_path);
    }
    return null;
  }

  getActivityDescription(_input?: Record<string, unknown>): string | null {
    return 'Reading file';
  }

  isSearchOrRead(): { isSearch: boolean; isRead: boolean } {
    return { isSearch: false, isRead: true };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  if (!Number.isInteger(value)) return { error: `${name} must be an integer` };
  if (value < min) return { error: `${name} must be at least ${min}` };
  if (value > max) return { error: `${name} must be ${max} or less` };
  return { value };
}

function normalizeOptionalInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): { value?: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
  if (!Number.isInteger(value)) return { error: `${name} must be an integer` };
  if (value < min) return { error: `${name} must be at least ${min}` };
  if (value > max) return { error: `${name} must be ${max} or less` };
  return { value };
}

function normalizeRequiredString(
  value: unknown,
  name: string,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${name} is required` };
  const normalized = value.trim();
  if (!normalized) return { error: `${name} must not be empty` };
  return { value: normalized };
}

function normalizePagesSpec(
  value: unknown,
): { value?: string; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'string') return { error: 'pages must be a string' };
  const normalized = value.trim();
  if (!normalized) return { value: undefined };
  if (normalized.length > MAX_PAGES_SPEC_CHARS) {
    return { error: `pages must be ${MAX_PAGES_SPEC_CHARS} characters or less` };
  }
  if (!/^\d+\s*(?:-\s*\d+)?(?:\s*,\s*\d+\s*(?:-\s*\d+)?)*$/.test(normalized)) {
    return { error: 'pages must be a comma-separated list of page numbers or ranges like "1-3,5"' };
  }
  return { value: normalized };
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

function truncateText(content: string, maxChars: number): { content: string; wasTruncated: boolean } {
  if (content.length <= maxChars) return { content, wasTruncated: false };
  return {
    content: `${content.slice(0, maxChars).trimEnd()}\n\n... Read output truncated at ${maxChars} characters.`,
    wasTruncated: true,
  };
}

function addLineNumbers(lines: string[], startLine: number): string {
  const endLine = startLine + Math.max(0, lines.length - 1);
  const width = String(Math.max(endLine, 1)).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')}| ${line}`).join('\n');
}

function readFile(
  filePath: string,
  options?: BufferEncoding | { encoding?: BufferEncoding; signal?: AbortSignal },
): Promise<string | Buffer> {
  const fn = readFileForTests ?? (fs.readFile as unknown as ReadFileLike);
  return fn(filePath, options);
}

type ReadAbortStatus = 'timeout' | 'cancelled';

class ReadAbortError extends Error {
  constructor(
    readonly status: ReadAbortStatus,
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(status === 'timeout'
      ? `Read timed out after ${timeoutMs}ms during ${operation}. Narrow the file/range or increase timeout_ms.`
      : 'Read cancelled by user');
    this.name = 'ReadAbortError';
  }
}

function isReadAbortError(err: unknown): err is ReadAbortError {
  return err instanceof ReadAbortError;
}

interface ReadBudget {
  signal: AbortSignal;
  timeoutMs: number;
  race<T>(promise: Promise<T>, operation: string): Promise<T>;
  throwIfAborted(operation: string): void;
  abortError(operation: string): ReadAbortError;
  cleanup(): void;
}

function createReadBudget(parentSignal: AbortSignal | undefined, timeoutMs: number): ReadBudget {
  const controller = new AbortController();
  let status: ReadAbortStatus | null = null;

  const abortAs = (nextStatus: ReadAbortStatus) => {
    if (controller.signal.aborted) return;
    status = nextStatus;
    controller.abort();
  };

  const timeoutId = setTimeout(() => abortAs('timeout'), timeoutMs);
  timeoutId.unref?.();

  const onParentAbort = () => abortAs('cancelled');
  if (parentSignal?.aborted) {
    abortAs('cancelled');
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }

  const abortError = (operation: string) =>
    new ReadAbortError(status ?? 'cancelled', operation, timeoutMs);

  return {
    signal: controller.signal,
    timeoutMs,
    race<T>(promise: Promise<T>, operation: string): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(abortError(operation));
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(abortError(operation));
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
          value => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          err => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', onAbort);
            reject(controller.signal.aborted ? abortError(operation) : err);
          },
        );
      });
    },
    throwIfAborted(operation: string): void {
      if (controller.signal.aborted) throw abortError(operation);
    },
    abortError,
    cleanup(): void {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

async function listDirectory(
  dirPath: string,
  budget: ReadBudget,
): Promise<{ content: string; wasTruncated: boolean; entries: number; shownEntries: number }> {
  budget.throwIfAborted('listing directory');
  const entries = await budget.race(fs.readdir(dirPath, { withFileTypes: true }), 'listing directory');
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const visible = entries.slice(0, MAX_DIRECTORY_ENTRIES);
  const lines = [
    `Directory: ${dirPath}`,
    `Entries: ${entries.length}${entries.length > MAX_DIRECTORY_ENTRIES ? ` (showing first ${MAX_DIRECTORY_ENTRIES})` : ''}`,
    '',
  ];

  for (const entry of visible) {
    budget.throwIfAborted('listing directory entries');
    const fullPath = path.join(dirPath, entry.name);
    let size = '';
    let modified = '';
    try {
      const stat = await budget.race(fs.stat(fullPath), `reading directory metadata for ${entry.name}`);
      size = entry.isDirectory() ? '<DIR>' : formatBytes(stat.size);
      modified = stat.mtime.toISOString();
    } catch (err: unknown) {
      if (isReadAbortError(err)) throw err;
      size = '?';
    }
    const suffix = entry.isDirectory() ? '/' : '';
    lines.push(`${entry.isDirectory() ? 'd' : 'f'}  ${size.padStart(10)}  ${modified}  ${entry.name}${suffix}`);
  }

  if (entries.length === 0) lines.push('(empty directory)');
  if (entries.length > MAX_DIRECTORY_ENTRIES) {
    lines.push('', `... ${entries.length - MAX_DIRECTORY_ENTRIES} more entries omitted. Use Glob for filtered file discovery.`);
  }
  return {
    content: lines.join('\n').trimEnd(),
    wasTruncated: entries.length > MAX_DIRECTORY_ENTRIES,
    entries: entries.length,
    shownEntries: visible.length,
  };
}

async function looksBinary(filePath: string, budget: ReadBudget): Promise<boolean> {
  budget.throwIfAborted('sampling file bytes');
  const handle = await budget.race(fs.open(filePath, 'r'), 'opening file for binary sampling');
  try {
    const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await budget.race(
      handle.read(buffer, 0, BINARY_SAMPLE_BYTES, 0),
      'sampling file bytes',
    );
    if (bytesRead === 0) return false;
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return true;
    let suspicious = 0;
    for (const byte of sample) {
      if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
    }
    return suspicious / sample.length > 0.3;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface TextRangeResult {
  content: string;
  lineStart: number;
  lineEnd: number;
  linesRead: number;
  totalLines?: number;
  wasTruncated: boolean;
  truncatedByLimit: boolean;
  truncatedByChars: boolean;
}

async function readTextLineRange(
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
  maxChars: number,
  lineNumbers: boolean,
  budget: ReadBudget,
): Promise<TextRangeResult> {
  const operation = 'streaming requested line range';
  const startLine = offset ?? 1;
  const maxLines = limit;
  const endLine = maxLines === undefined ? Number.POSITIVE_INFINITY : startLine + maxLines - 1;
  const lines: string[] = [];
  let currentLine = 0;
  let collectedChars = 0;
  let truncatedByLimit = false;
  let truncatedByChars = false;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const abort = () => {
    rl.close();
    stream.destroy(budget.abortError(operation));
  };

  if (budget.signal.aborted) abort();
  budget.signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const line of rl) {
      budget.throwIfAborted(operation);
      currentLine++;
      if (currentLine < startLine) continue;
      if (currentLine > endLine) {
        truncatedByLimit = true;
        break;
      }
      lines.push(line);
      collectedChars += line.length + (lines.length > 1 ? 1 : 0);
      if (collectedChars > maxChars) {
        truncatedByChars = true;
        break;
      }
    }
  } finally {
    budget.signal.removeEventListener('abort', abort);
    rl.close();
    stream.destroy();
  }

  const content = lineNumbers ? addLineNumbers(lines, startLine) : lines.join('\n');
  const truncated = truncateText(content, maxChars);
  const actualEnd = lines.length > 0 ? startLine + lines.length - 1 : startLine - 1;
  return {
    content: truncated.content || '(no content in requested range)',
    lineStart: startLine,
    lineEnd: actualEnd,
    linesRead: lines.length,
    wasTruncated: truncatedByLimit || truncatedByChars || truncated.wasTruncated,
    truncatedByLimit,
    truncatedByChars: truncatedByChars || truncated.wasTruncated,
  };
}

async function readTextTail(
  filePath: string,
  tail: number,
  maxChars: number,
  lineNumbers: boolean,
  budget: ReadBudget,
): Promise<TextRangeResult> {
  const operation = 'streaming file tail';
  const ring: Array<{ lineNumber: number; text: string }> = [];
  let currentLine = 0;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const abort = () => {
    rl.close();
    stream.destroy(budget.abortError(operation));
  };

  if (budget.signal.aborted) abort();
  budget.signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const line of rl) {
      budget.throwIfAborted(operation);
      currentLine++;
      ring.push({ lineNumber: currentLine, text: line });
      if (ring.length > tail) ring.shift();
    }
  } finally {
    budget.signal.removeEventListener('abort', abort);
    rl.close();
    stream.destroy();
  }

  const firstLine = ring[0]?.lineNumber ?? Math.max(1, currentLine + 1);
  const rawLines = ring.map(item => item.text);
  const content = lineNumbers ? addLineNumbers(rawLines, firstLine) : rawLines.join('\n');
  const truncated = truncateText(content, maxChars);

  return {
    content: truncated.content || '(file is empty)',
    lineStart: ring.length ? firstLine : 0,
    lineEnd: ring.length ? ring[ring.length - 1].lineNumber : 0,
    linesRead: ring.length,
    totalLines: currentLine,
    wasTruncated: currentLine > ring.length || truncated.wasTruncated,
    truncatedByLimit: currentLine > ring.length,
    truncatedByChars: truncated.wasTruncated,
  };
}

interface PdfReadResult {
  content: string;
  pageCount: number;
  selectedPages: number[];
  wasTruncated: boolean;
  truncatedByPages: boolean;
  truncatedByChars: boolean;
}

async function readPdfText(
  filePath: string,
  pagesSpec?: string,
  maxChars = MAX_OUTPUT_CHARS,
  budget?: ReadBudget,
): Promise<PdfReadResult> {
  budget?.throwIfAborted('loading PDF dependencies');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const rawBuffer = budget
    ? await budget.race(readFile(filePath), 'reading PDF bytes')
    : await readFile(filePath);
  const buffer = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  const loadingTask = (getDocument as any)({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  let pdf: any | undefined;
  try {
    pdf = budget
      ? await budget.race(loadingTask.promise, 'loading PDF document')
      : await loadingTask.promise;
    const selectedPages = selectPdfPages({
      spec: pagesSpec,
      pageCount: pdf.numPages,
      maxPages: pagesSpec ? MAX_PDF_SELECTED_PAGES : DEFAULT_PDF_MAX_PAGES,
    });
    if (selectedPages.length === 0) {
      throw new Error(`No valid PDF pages selected. Use a range within 1-${pdf.numPages}.`);
    }

    const lines = [
      `PDF: ${filePath}`,
      `Total pages: ${pdf.numPages}`,
      `Selected pages: ${selectedPages.join(', ')}`,
      '',
    ];
    let totalChars = 0;
    let truncatedByChars = false;
    for (const pageNumber of selectedPages) {
      budget?.throwIfAborted(`extracting PDF page ${pageNumber}`);
      const page = budget
        ? await budget.race(pdf.getPage(pageNumber), `loading PDF page ${pageNumber}`)
        : await pdf.getPage(pageNumber);
      const content = budget
        ? await budget.race(page.getTextContent(), `extracting PDF page ${pageNumber}`)
        : await page.getTextContent();
      const text = textContentToString(content);
      const pageBlock = [`--- Page ${pageNumber} ---`, text || '(no extractable text on this page)', ''].join('\n');
      const remaining = maxChars - totalChars;
      if (remaining <= 0) {
        truncatedByChars = true;
        break;
      }
      const nextBlock = pageBlock.length > remaining ? pageBlock.slice(0, remaining) : pageBlock;
      if (pageBlock.length > remaining) truncatedByChars = true;
      lines.push(nextBlock.trimEnd(), '');
      totalChars += nextBlock.length;
      if (truncatedByChars) break;
    }

    const truncatedByPages = !pagesSpec && pdf.numPages > selectedPages.length;
    if (truncatedByPages) {
      lines.push(`... ${pdf.numPages - selectedPages.length} more pages omitted. Pass pages to read a specific range.`);
    }
    if (truncatedByChars) {
      lines.push(`... PDF text truncated at ${maxChars} characters.`);
    }

    return {
      content: lines.join('\n').trimEnd(),
      pageCount: pdf.numPages,
      selectedPages,
      wasTruncated: truncatedByPages || truncatedByChars,
      truncatedByPages,
      truncatedByChars,
    };
  } finally {
    if (pdf) {
      await pdf.destroy();
    } else if (typeof loadingTask.destroy === 'function') {
      try {
        await Promise.resolve(loadingTask.destroy());
      } catch {
        // Best-effort cleanup after load failures or timeouts.
      }
    }
  }
}

function textContentToString(content: any): string {
  const lines: string[] = [];
  let current = '';
  for (const item of content.items || []) {
    const text = typeof item?.str === 'string' ? item.str.trim() : '';
    if (!text) continue;
    current += current ? ` ${text}` : text;
    if (item.hasEOL) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function selectPdfPages({
  spec,
  pageCount,
  maxPages,
}: {
  spec?: string;
  pageCount: number;
  maxPages: number;
}): number[] {
  if (!spec) {
    const count = Math.min(pageCount, maxPages);
    return Array.from({ length: count }, (_unused, index) => index + 1);
  }

  const selected = new Set<number>();
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = clamp(Number(range[1]), 1, pageCount);
      const end = clamp(Number(range[2]), 1, pageCount);
      for (let page = Math.min(start, end); page <= Math.max(start, end); page++) {
        selected.add(page);
      }
      continue;
    }
    const page = Number(part);
    if (Number.isInteger(page) && page >= 1 && page <= pageCount) selected.add(page);
  }

  return Array.from(selected).sort((a, b) => a - b).slice(0, maxPages);
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 1) return fallback;
  return Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function findUnexpectedParam(params: Record<string, unknown>, allowed: string[]): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(params).find(key => !allowedSet.has(key)) ?? null;
}
