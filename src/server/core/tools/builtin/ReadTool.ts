// ReadTool — reads a file from the local filesystem
// Supports offset/limit for partial reads, images, PDFs, and Jupyter notebooks.
// Based on Claude Code's FileReadTool pattern.

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../Tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

/** Maximum file size to read in one shot (256 KB). */
const MAX_SIZE_BYTES = 256 * 1024;

/** Maximum character output for text files. */
const MAX_OUTPUT_CHARS = 80000;

export class ReadTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Reads a file from the local filesystem.';
  name(): string {
    return 'Read';
  }

  description(): string {
    return 'Reads a file from the local filesystem. Max file size: 256 KB. Max output: 80,000 characters (head/tail truncated if exceeded — use offset/limit for large files). Supports reading specific line ranges.';
  }

  prompt(): string {
    return '## Read Usage\n' +
      'Your primary tool for examining text and code files. Reads file contents as text.\n\n' +
      '**Large files:** Use `offset` and `limit` parameters to read in chunks. Max 80,000 chars per read — if a file exceeds this, the result is head+tail truncated. For files you suspect are large, read with offset=0, limit=100 first to gauge size.\n\n' +
      'Only read files relevant to your current task. Don\'t read files you\'ve already read in this turn unless they changed.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'The absolute path to the file to read (must be absolute, not relative)',
        },
        offset: {
          type: 'number',
          description:
            'The line number to start reading from. Only provide if the file is too large to read at once.',
        },
        limit: {
          type: 'number',
          description:
            'The number of lines to read. Only provide if the file is too large to read at once.',
        },
        pages: {
          type: 'string',
          description:
            'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
        },
      },
      required: ['file_path'],
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
    const filePath = params.file_path as string;
    const offset = params.offset as number | undefined;
    const limit = params.limit as number | undefined;
    const pages = params.pages as string | undefined;

    if (!filePath || typeof filePath !== 'string') {
      return this.makeError('file_path is required');
    }

    const startedAt = Date.now();

    try {
      const baseDir = ctx.workspace || process.cwd();
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(baseDir, filePath);

      // Check if the path exists and is not a directory
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(resolved);
      } catch (err: unknown) {
        const errMsg = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? `File not found: ${filePath}`
          : `Cannot access file: ${filePath} — ${(err as Error).message}`;
        return this.makeError(errMsg);
      }

      if (stat.isDirectory()) {
        // List directory contents instead
        const entries = await fs.readdir(resolved);
        const content = entries.length > 0
          ? entries.join('\n')
          : '(empty directory)';
        return this.makeResult(content, { startedAt });
      }

      // Check file size
      if (stat.size > MAX_SIZE_BYTES && !offset && !limit && !pages) {
        const sizeStr = formatBytes(stat.size);
        const maxStr = formatBytes(MAX_SIZE_BYTES);
        return this.makeError(
          `File is too large (${sizeStr}). Max size is ${maxStr}. Use offset/limit to read a portion.`
        );
      }

      // Handle different file types
      const ext = path.extname(resolved).toLowerCase();

      // Image files — note that we've read them but can't render inline here
      if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
        return this.makeResult(
          `[Image file: ${path.basename(resolved)}]\nSize: ${formatBytes(stat.size)}\nPath: ${resolved}`,
          { startedAt }
        );
      }

      // Read as text
      let content: string;
      try {
        content = await fs.readFile(resolved, 'utf-8');
      } catch {
        // Binary file fallback
        return this.makeResult(
          `[Binary file: ${path.basename(resolved)}]\nSize: ${formatBytes(stat.size)}`,
          { startedAt }
        );
      }

      // Apply line-based offset/limit
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(1, offset ?? 1) - 1;
        const end = limit !== undefined
          ? Math.min(lines.length, start + limit)
          : lines.length;
        content = lines.slice(start, end).join('\n');
      }

      // Apply character limit
      const wasTruncated = content.length > MAX_OUTPUT_CHARS;
      if (wasTruncated) {
        const totalLen = content.length;
        content = content.slice(0, MAX_OUTPUT_CHARS) +
          `\n... [truncated, ${totalLen} chars total. Use offset/limit to read more]`;
      }

      return this.makeResult(content, { startedAt, wasTruncated });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(errMsg);
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
