// GrepTool — regex pattern search in file contents
// Based on Claude Code's GrepTool pattern. Uses ripgrep (rg) if available,
// falls back to recursive manual search with Node.js fs.
// RiskLevel: Safe (read-only).

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

/** Output modes supported by grep. */
type OutputMode = 'content' | 'files_with_matches' | 'count';

/** Maximum total output characters. */
const MAX_OUTPUT_CHARS = 25000;

export class GrepTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Powerful search tool built on ripgrep for searching file contents.';
  name(): string {
    return 'Grep';
  }

  description(): string {
    return 'Search file contents using regular expressions. Supports full regex syntax, glob file filtering, and multiple output modes (content with context, file paths, or match counts). Use multiline mode for cross-line patterns. Output limit: 25,000 characters. For broad searches, prefer files_with_matches output mode to avoid truncation.';
  }

  prompt(): string {
    return '## Grep Usage\n' +
      '- ALWAYS use Grep for content search — NEVER invoke grep or rg via Bash\n' +
      '- For open-ended searches requiring multiple rounds, use the Agent tool instead\n' +
      '- Pattern syntax uses ripgrep (not grep) — literal braces need escaping: use `interface\\{\\}` to find `interface{}` in Go code\n' +
      '- Files with matches output mode is fastest for broad searches\n' +
      '- Output limit: 25,000 characters max. Use head_limit parameter for narrower results. Beyond the limit, output is head/tail truncated.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
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
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description:
            'Output mode: "content" shows matching lines,' +
            ' "files_with_matches" shows file paths (default),' +
            ' "count" shows match counts.',
        },
        '-A': {
          type: 'number',
          description: 'Number of lines to show after each match (rg -A).',
        },
        '-B': {
          type: 'number',
          description: 'Number of lines to show before each match (rg -B).',
        },
        '-C': {
          type: 'number',
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
          type: 'number',
          description:
            'Limit output to first N lines/entries. Defaults to 250. Pass 0 for unlimited.',
        },
        multiline: {
          type: 'boolean',
          description: 'Enable multiline mode where . matches newlines (rg -U --multiline-dotall). Default: false.',
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
    const outputMode = (params.output_mode as OutputMode) || 'files_with_matches';
    const after = (params['-A'] as number) ?? 0;
    const before = (params['-B'] as number) ?? 0;
    const contextLines = (params['-C'] as number) ?? 0;
    const caseInsensitive = (params['-i'] as boolean) ?? false;
    const showLineNumbers = (params['-n'] as boolean) ?? true;
    const fileType = params.type as string | undefined;
    const headLimit = (params.head_limit as number) ?? 250;
    const multiline = (params.multiline as boolean) ?? false;

    if (!pattern || typeof pattern !== 'string') {
      return this.makeError('pattern is required');
    }

    const startedAt = Date.now();

    try {
      const resolved = path.isAbsolute(searchPath)
        ? searchPath
        : path.resolve(ctx.workspace, searchPath);

      // Verify path exists
      try {
        await fs.stat(resolved);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`Path does not exist: ${searchPath}`);
        }
        throw err;
      }

      // Try ripgrep first, fall back to manual search
      let output: string;
      const rgResult = tryRipgrep(pattern, resolved, {
        glob: globFilter,
        after, before, context: contextLines,
        caseInsensitive, showLineNumbers, fileType, headLimit, multiline,
        outputMode,
      });

      if (rgResult !== null) {
        output = rgResult;
      } else {
        output = await manualGrep(resolved, pattern, {
          glob: globFilter,
          caseInsensitive, headLimit, outputMode,
          contextLines: contextLines || 0,
        });
      }

      // Trim and limit output
      let trimmed = output.trim();
      if (!trimmed) trimmed = '(no matches)';
      const wasTruncated = trimmed.length > MAX_OUTPUT_CHARS;
      if (wasTruncated) {
        trimmed = trimmed.slice(0, MAX_OUTPUT_CHARS) +
          `\n... [truncated, output limit reached]`;
      }

      return this.makeResult(trimmed, { startedAt, wasTruncated });
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
}

function tryRipgrep(
  pattern: string,
  searchPath: string,
  opts: RipgrepOptions,
): string | null {
  const rgPaths = [
    'rg',
    'C:\\Program Files\\Git\\usr\\bin\\rg.exe',
  ];

  let rgBin = '';
  for (const p of rgPaths) {
    try {
      const check = spawnSync(p, ['--version'], { timeout: 3000, encoding: 'utf-8' });
      if (check.status === 0 && check.stdout?.includes('ripgrep')) {
        rgBin = p;
        break;
      }
    } catch {
      // continue
    }
  }
  if (!rgBin) return null;

  const args: string[] = [];

  if (opts.outputMode === 'files_with_matches') {
    args.push('-l');
  } else if (opts.outputMode === 'count') {
    args.push('-c');
  }

  if (opts.after) args.push('-A', String(opts.after));
  if (opts.before) args.push('-B', String(opts.before));
  if (opts.context) args.push('-C', String(opts.context));

  if (opts.caseInsensitive) args.push('-i');
  if (opts.showLineNumbers) args.push('-n');
  if (opts.multiline) args.push('-U', '--multiline-dotall');

  if (opts.fileType) args.push('--type', opts.fileType);
  if (opts.glob) args.push('--glob', opts.glob);

  args.push('-e', pattern, searchPath);
  args.push('--no-ignore-vcs');
  args.push('-g', '!.git');
  args.push('-g', '!node_modules');

  try {
    const result = spawnSync(rgBin, args, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
      cwd: searchPath,
    });

    let output = (result.stdout || '') + (result.stderr || '');
    if (result.error) return null;

    if (opts.headLimit > 0 && output) {
      const lines = output.split('\n');
      if (lines.length > opts.headLimit) {
        output = lines.slice(0, opts.headLimit).join('\n') +
          `\n... [${lines.length - opts.headLimit} more results]`;
      }
    }

    return output || null;
  } catch {
    return null;
  }
}

// ── Manual grep fallback ──

interface ManualGrepOptions {
  glob?: string;
  caseInsensitive: boolean;
  headLimit: number;
  outputMode: OutputMode;
  contextLines: number;
}

async function manualGrep(
  searchPath: string,
  pattern: string,
  opts: ManualGrepOptions,
): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g' + (opts.caseInsensitive ? 'i' : ''));
  } catch {
    return `Invalid regex pattern: ${pattern}`;
  }

  const results: string[] = [];
  const fileCounts: Map<string, number> = new Map();

  async function walk(dir: string): Promise<void> {
    if (results.length >= opts.headLimit && opts.headLimit > 0) return;

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= opts.headLimit && opts.headLimit > 0) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(searchPath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (opts.glob && !simpleGlobMatch(relative, opts.glob)) continue;

        const ext = path.extname(entry.name).toLowerCase();
        const textExts = new Set([
          '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.css', '.html', '.xml',
          '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env', '.sh', '.bash', '.zsh',
          '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
          '.vue', '.svelte', '.graphql', '.sql', '.csv', '.log',
        ]);
        if (ext && !textExts.has(ext)) continue;

        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= opts.headLimit && opts.headLimit > 0) break;

            const line = lines[i];
            const match = line.match(regex);
            if (match) {
              if (opts.outputMode === 'files_with_matches') {
                if (!fileCounts.has(relative)) {
                  results.push(relative);
                  fileCounts.set(relative, 1);
                }
                continue;
              }

              if (opts.outputMode === 'count') {
                fileCounts.set(relative, (fileCounts.get(relative) || 0) + 1);
                continue;
              }

              // Content mode
              if (opts.contextLines > 0) {
                const start = Math.max(0, i - opts.contextLines);
                const end = Math.min(lines.length, i + opts.contextLines + 1);
                results.push(`--- ${relative}:${i + 1} ---`);
                for (let j = start; j < end; j++) {
                  const marker = j === i ? '>' : ' ';
                  results.push(`${marker}${j + 1}: ${lines[j]}`);
                }
              } else {
                results.push(`${relative}:${i + 1}: ${line.trim()}`);
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(searchPath);
  } catch {
    return '';
  }

  if (stat.isFile()) {
    try {
      const content = await fs.readFile(searchPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${searchPath}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    } catch {
      // skip
    }
  } else {
    await walk(searchPath);
  }

  if (opts.outputMode === 'count') {
    const formatted: string[] = [];
    for (const [file, count] of fileCounts) {
      formatted.push(`${file}: ${count} matches`);
    }
    return formatted.join('\n');
  }

  return results.join('\n');
}

function simpleGlobMatch(filePath: string, glob: string): boolean {
  const regexStr = glob
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(regexStr).test(filePath);
  } catch {
    return false;
  }
}
