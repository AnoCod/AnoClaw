// GlobTool - filename pattern matching using glob patterns
// Based on Claude Code's GlobTool pattern. Uses micromatch for standard glob semantics.
// RiskLevel: Safe (read-only).

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

/** Maximum number of results to return (prevents context blowout). */
const MAX_RESULTS = 200;
const MAX_RESULTS_CAP = 1000;
const MAX_SCANNED_ENTRIES = 100000;
const MIN_OUTPUT_CHARS = 100;
const MAX_OUTPUT_CHARS = 25000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;

// Lazy-loaded via dynamic import
// micromatch ESM/CJS interop: dynamic import returns { default: fn }, unwrap it
let _mm: any = null;
async function getMM(): Promise<any> {
  if (!_mm) {
    const mod = await import('micromatch');
    _mm = mod.default || mod;
    // Safety: micromatch exports the match function directly or as .micromatch
    if (typeof _mm !== 'function') _mm = _mm.micromatch;
  }
  return _mm;
}

export class GlobTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Fast file pattern matching that works with any codebase size.';
  name(): string {
    return 'Glob';
  }

  description(): string {
    return 'Fast file pattern matching tool that works with any codebase size.' +
      ' Supports glob patterns like "**/*.js" or "src/**/*.ts".' +
      ' Returns up to 200 matching file paths sorted by modification time (newest first).' +
      ' Supports explicit result, timeout, hidden-file, node_modules, exclude, and output-size controls.' +
      ' Use this tool when you need to find files by name patterns.';
  }

  prompt(): string {
    return '## Glob Usage\n' +
      '- Use this tool to find files by name pattern\n' +
      '- When doing open-ended searches requiring multiple rounds, use the Agent tool instead\n' +
      '- Do NOT use Bash `find` or `ls` for file search - use Glob\n' +
      '- On Windows, use forward slashes: D:/foo/bar, or omit path to use the workspace root\n' +
      '- If you need to list ALL files in a directory, use pattern "**/*"\n' +
      '- Result limit: 200 files by default; use max_results for narrower/larger results\n' +
      '- Hidden paths and node_modules are skipped by default; opt in with include_hidden or include_node_modules\n' +
      '- Use exclude to skip noisy paths like ["dist/**", "release*/**"]\n' +
      '- Invalid numeric/boolean parameters fail fast instead of being silently corrected.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'The glob pattern to match files against',
        },
        path: {
          type: 'string',
          description:
            'The directory to search in. Defaults to the current working directory (workspace root).' +
            ' Use forward slashes on all platforms (e.g. D:/projects/src, /home/user/code).' +
            ' IMPORTANT: Omit this field to use the default directory.' +
            ' DO NOT enter "undefined" or "null" - simply omit it for the default behavior.',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RESULTS_CAP,
          description: `Maximum matching files to return. Default ${MAX_RESULTS}, minimum 1, maximum ${MAX_RESULTS_CAP}.`,
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include hidden files and directories. Defaults to false.',
        },
        include_node_modules: {
          type: 'boolean',
          description: 'Include node_modules directories. Defaults to false.',
        },
        exclude: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '\\S' },
          description: 'Glob patterns to exclude from the search, relative to the search path.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
          description: `Maximum scan time in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
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

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const patternResult = normalizePattern(params.pattern);
    if (patternResult.error) return this.makeError(patternResult.error);
    const pattern = patternResult.value!;

    const pathResult = normalizeSearchPath(params.path, ctx.workspace);
    if (pathResult.error) return this.makeError(pathResult.error);
    const searchPath = pathResult.value!;

    const maxResultsResult = normalizeInteger(params.max_results, 'max_results', MAX_RESULTS, 1, MAX_RESULTS_CAP);
    if (maxResultsResult.error) return this.makeError(maxResultsResult.error);
    const maxResults = maxResultsResult.value!;

    const includeHiddenResult = normalizeBoolean(params.include_hidden, 'include_hidden', false);
    if (includeHiddenResult.error) return this.makeError(includeHiddenResult.error);
    const includeHidden = includeHiddenResult.value!;

    const includeNodeModulesResult = normalizeBoolean(params.include_node_modules, 'include_node_modules', false);
    if (includeNodeModulesResult.error) return this.makeError(includeNodeModulesResult.error);
    const includeNodeModules = includeNodeModulesResult.value!;

    const excludeResult = normalizeExclude(params.exclude);
    if (excludeResult.error) return this.makeError(excludeResult.error);
    const exclude = excludeResult.value!;

    const timeoutResult = normalizeInteger(params.timeout_ms, 'timeout_ms', DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    if (timeoutResult.error) return this.makeError(timeoutResult.error);
    const timeoutMs = timeoutResult.value!;

    const maxOutputResult = normalizeInteger(params.max_output_chars, 'max_output_chars', MAX_OUTPUT_CHARS, MIN_OUTPUT_CHARS, MAX_OUTPUT_CHARS);
    if (maxOutputResult.error) return this.makeError(maxOutputResult.error);
    const maxOutputChars = maxOutputResult.value!;

    const startedAt = Date.now();

    try {
      const resolved = path.isAbsolute(searchPath)
        ? searchPath
        : path.resolve(ctx.workspace, searchPath);

      // Verify directory exists
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {
          return this.makeError(`Path is not a directory: ${searchPath}`);
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`Directory does not exist: ${searchPath}`);
        }
        throw err;
      }

      const micromatch = await getMM();
      const matcher = createMatcher(micromatch, pattern, includeHidden);
      const excludeMatchers = exclude.map(excludePattern => createMatcher(micromatch, excludePattern, true));

      const matches: Array<{ filePath: string; relativePath: string; mtimeMs: number }> = [];
      let totalMatches = 0;
      let scannedEntries = 0;
      let scanTruncated = false;
      let scanTimedOut = false;
      let skippedHidden = 0;
      let skippedNodeModules = 0;
      let skippedExcluded = 0;

      async function walk(dir: string): Promise<void> {
        if (scanTruncated || scanTimedOut) return;
        if (Date.now() - startedAt > timeoutMs) {
          scanTimedOut = true;
          return;
        }
        if (ctx.signal?.aborted) throw new Error('Glob interrupted by user');
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (scanTruncated || scanTimedOut) break;
          if (Date.now() - startedAt > timeoutMs) {
            scanTimedOut = true;
            break;
          }
          scannedEntries++;
          if (scannedEntries > MAX_SCANNED_ENTRIES) {
            scanTruncated = true;
            break;
          }
          const fullPath = path.join(dir, entry.name);
          const relative = path.relative(resolved, fullPath).replace(/\\/g, '/');
          if (!includeHidden && hasHiddenSegment(relative)) {
            skippedHidden++;
            continue;
          }
          if (!includeNodeModules && hasPathSegment(relative, 'node_modules')) {
            skippedNodeModules++;
            continue;
          }
          if (shouldExclude(relative, entry.isDirectory(), excludeMatchers)) {
            skippedExcluded++;
            continue;
          }
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            if (!matcher(relative)) continue;
            totalMatches++;
            let mtimeMs = 0;
            try {
              mtimeMs = (await fs.stat(fullPath)).mtimeMs;
            } catch {
              // keep default mtime
            }
            keepNewest(matches, { filePath: fullPath, relativePath: relative, mtimeMs }, maxResults);
          }
        }
      }
      await walk(resolved);

      matches.sort(compareNewestFirst);

      const results = matches.map(r => r.filePath);
      let wasTruncated = totalMatches > maxResults || scanTruncated || scanTimedOut;
      const notes: string[] = [];
      if (totalMatches > maxResults) {
        notes.push(`${totalMatches - maxResults} matching files omitted.`);
      }
      if (scanTruncated) {
        notes.push(`Scan stopped after ${MAX_SCANNED_ENTRIES} entries; narrow path or pattern for complete results.`);
      }
      if (scanTimedOut) {
        notes.push(`Scan stopped after ${timeoutMs}ms; narrow path/pattern or raise timeout_ms for complete results.`);
      }
      const baseContent = results.length > 0 ? results.join('\n') : '(no matches)';
      let content = baseContent +
        (notes.length > 0
          ? `\n(Results are truncated. ${notes.join(' ')})`
          : '');
      const charLimited = applyCharLimit(content, maxOutputChars);
      content = charLimited.output;
      wasTruncated = wasTruncated || charLimited.wasTruncated;

      return this.makeResult(content, {
        startedAt,
        wasTruncated,
        structured: {
          pattern,
          path: resolved,
          maxResults,
          maxOutputChars,
          includeHidden,
          includeNodeModules,
          exclude,
          timeoutMs,
          resultCount: results.length,
          totalMatches,
          omittedMatches: Math.max(0, totalMatches - results.length),
          scannedEntries,
          scanTruncated,
          scanTimedOut,
          truncatedByChars: charLimited.wasTruncated,
          skippedHidden,
          skippedNodeModules,
          skippedExcluded,
          wasTruncated,
          notes,
        },
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Glob failed: ${errMsg}`);
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
    return 'Finding files';
  }

  isSearchOrRead(): { isSearch: boolean; isRead: boolean } {
    return { isSearch: true, isRead: false };
  }
}

function normalizePattern(value: unknown): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string' || value.trim() === '') return { error: 'pattern is required' };
  return { value };
}

function normalizeSearchPath(
  value: unknown,
  workspace: string,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null || value === '') return { value: workspace };
  if (typeof value !== 'string') return { error: 'path must be a string when provided' };
  const normalized = value.trim().toLowerCase();
  if (normalized === 'undefined' || normalized === 'null') {
    return { error: 'path must be omitted to use the workspace default, not the literal string "undefined" or "null"' };
  }
  return { value };
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

function normalizeBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'boolean') return { error: `${name} must be a boolean` };
  return { value };
}

function normalizeExclude(value: unknown): { value: string[]; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: 'exclude must be an array of glob strings' };
  const patterns: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      return { error: 'exclude must contain only non-empty glob strings' };
    }
    patterns.push(item);
  }
  return { value: patterns };
}

function createMatcher(micromatch: any, pattern: string, includeHidden: boolean): (filePath: string) => boolean {
  const options = { dot: includeHidden, nobrace: false };
  if (typeof micromatch.matcher === 'function') {
    return micromatch.matcher(pattern, options);
  }
  if (typeof micromatch.isMatch === 'function') {
    return (filePath: string) => micromatch.isMatch(filePath, pattern, options);
  }
  return (filePath: string) => micromatch([filePath], pattern, options).length > 0;
}

function keepNewest(
  matches: Array<{ filePath: string; mtimeMs: number }>,
  candidate: { filePath: string; relativePath: string; mtimeMs: number },
  maxResults: number,
): void {
  if (matches.length < maxResults) {
    matches.push(candidate);
    return;
  }

  let oldestIndex = 0;
  for (let i = 1; i < matches.length; i++) {
    if (compareNewestFirst(matches[i], matches[oldestIndex]) > 0) {
      oldestIndex = i;
    }
  }

  if (compareNewestFirst(candidate, matches[oldestIndex]) < 0) {
    matches[oldestIndex] = candidate;
  }
}

function compareNewestFirst(
  a: { filePath: string; mtimeMs: number },
  b: { filePath: string; mtimeMs: number },
): number {
  if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return a.filePath.localeCompare(b.filePath);
}

function hasHiddenSegment(relativePath: string): boolean {
  return relativePath.split('/').some(segment => segment.startsWith('.') && segment.length > 1);
}

function hasPathSegment(relativePath: string, target: string): boolean {
  return relativePath.split('/').includes(target);
}

function shouldExclude(relativePath: string, isDirectory: boolean, excludeMatchers: Array<(filePath: string) => boolean>): boolean {
  if (excludeMatchers.length === 0) return false;
  const candidates = isDirectory
    ? [relativePath, `${relativePath}/`, `${relativePath}/__anoclaw_placeholder__`]
    : [relativePath];
  return excludeMatchers.some(matcher => candidates.some(candidate => matcher(candidate)));
}

function applyCharLimit(output: string, maxChars: number): { output: string; wasTruncated: boolean } {
  if (output.length <= maxChars) return { output, wasTruncated: false };
  return {
    output: `${output.slice(0, maxChars).trimEnd()}\n... [Glob output truncated at ${maxChars} characters]`,
    wasTruncated: true,
  };
}
