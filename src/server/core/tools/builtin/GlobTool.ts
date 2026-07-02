// GlobTool — filename pattern matching using glob patterns
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
      '- Do NOT use Bash `find` or `ls` for file search — use Glob\n' +
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
            ' DO NOT enter "undefined" or "null" — simply omit it for the default behavior.',
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

      // Collect all file paths recursively
      const allFiles: string[] = [];
      async function walk(dir: string): Promise<void> {
        if (allFiles.length >= MAX_RESULTS * 2) return;
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (allFiles.length >= MAX_RESULTS * 2) break;
          const fullPath = path.join(dir, entry.name);
          const relative = path.relative(resolved, fullPath).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.')) continue;
            if (entry.name === 'node_modules') continue;
            await walk(fullPath);
          } else if (entry.isFile()) {
            allFiles.push(relative);
          }
        }
      }
      await walk(resolved);

      // Match using micromatch
      const matched = micromatch(allFiles, pattern, { dot: false, nobrace: false });

      if (matched.length === 0) {
        return this.makeResult('(no matches)', { startedAt });
      }

      // Sort by modification time (newest first) — batch stat
      const withMtime: Array<{ filePath: string; mtimeMs: number }> = [];
      for (const rel of matched.slice(0, MAX_RESULTS)) {
        try {
          const s = await fs.stat(path.join(resolved, rel));
          withMtime.push({ filePath: path.join(resolved, rel), mtimeMs: s.mtimeMs });
        } catch {
          withMtime.push({ filePath: path.join(resolved, rel), mtimeMs: 0 });
        }
      }
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const results = withMtime.map(r => r.filePath);
      const wasTruncated = matched.length > MAX_RESULTS;
      const content = results.join('\n') +
        (wasTruncated
          ? '\n(Results are truncated. Consider using a more specific path or pattern.)'
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
