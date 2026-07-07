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
      ' Output is auto-truncated by the pipeline. Refine your pattern if results are cut off.' +
      ' Use this tool when you need to find files by name patterns.';
  }

  prompt(): string {
    return '## Glob Usage\n' +
      '- Use this tool to find files by name pattern\n' +
      '- When doing open-ended searches requiring multiple rounds, use the Agent tool instead\n' +
      '- Do NOT use Bash `find` or `ls` for file search - use Glob\n' +
      '- On Windows, use forward slashes: D:/foo/bar, or omit path to use the workspace root\n' +
      '- If you need to list ALL files in a directory, use pattern "**/*"\n' +
      '- Result limit: 200 files max. Output beyond 10,000 chars is auto-truncated. Refine your pattern if needed.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
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
          type: 'number',
          description: `Maximum matching files to return. Default ${MAX_RESULTS}, maximum ${MAX_RESULTS_CAP}.`,
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
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) || ctx.workspace;
    const maxResults = clampMaxResults(params.max_results as number | undefined);

    if (!pattern || typeof pattern !== 'string') {
      return this.makeError('pattern is required');
    }

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
      const matcher = createMatcher(micromatch, pattern);

      const matches: Array<{ filePath: string; mtimeMs: number }> = [];
      let totalMatches = 0;
      let scannedEntries = 0;
      let scanTruncated = false;

      async function walk(dir: string): Promise<void> {
        if (scanTruncated) return;
        if (ctx.signal?.aborted) throw new Error('Glob interrupted by user');
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (scanTruncated) break;
          scannedEntries++;
          if (scannedEntries > MAX_SCANNED_ENTRIES) {
            scanTruncated = true;
            break;
          }
          const fullPath = path.join(dir, entry.name);
          const relative = path.relative(resolved, fullPath).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.')) continue;
            if (entry.name === 'node_modules') continue;
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
            keepNewest(matches, { filePath: fullPath, mtimeMs }, maxResults);
          }
        }
      }
      await walk(resolved);

      if (matches.length === 0) {
        return this.makeResult('(no matches)', { startedAt });
      }

      matches.sort(compareNewestFirst);

      const results = matches.map(r => r.filePath);
      const wasTruncated = totalMatches > maxResults || scanTruncated;
      const notes: string[] = [];
      if (totalMatches > maxResults) {
        notes.push(`${totalMatches - maxResults} matching files omitted.`);
      }
      if (scanTruncated) {
        notes.push(`Scan stopped after ${MAX_SCANNED_ENTRIES} entries; narrow path or pattern for complete results.`);
      }
      const content = results.join('\n') +
        (notes.length > 0
          ? `\n(Results are truncated. ${notes.join(' ')})`
          : '');

      return this.makeResult(content, { startedAt, wasTruncated });
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

function clampMaxResults(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return MAX_RESULTS;
  return Math.min(MAX_RESULTS_CAP, Math.max(1, Math.floor(value)));
}

function createMatcher(micromatch: any, pattern: string): (filePath: string) => boolean {
  const options = { dot: false, nobrace: false };
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
  candidate: { filePath: string; mtimeMs: number },
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
