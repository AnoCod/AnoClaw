// BashTool — executes shell commands
// RiskLevel: High/Critical (depends on command).
// InterruptBehavior: Block for destructive commands, Cancel otherwise.
// Based on Claude Code's BashTool pattern.

import { exec, spawnSync, type ExecOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { createLogger } from '../../logger.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

/** Default timeout for bash commands (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30000;

/** Maximum output size before truncation. */
const MAX_OUTPUT_CHARS = 10000;

/** Registry of background child processes, keyed by sessionId:timestamp */
const backgroundProcesses = new Map<string, {
  child: ReturnType<typeof exec>;
  startedAt: number;
  command: string;
}>();

/** Destructive command patterns that require user confirmation. */
const DESTRUCTIVE_PATTERNS = [
  /git\s+push/,
  /git\s+reset/,
  /rm\s+-rf/,
  /sudo\s/,
  /chmod\s/,
  /chown\s/,
  /mkfs/,
  /dd\s/,
  />\s*\/dev\//,
  /shutdown/,
  /reboot/,
  /:(){ :|:& };:/,   // fork bomb
  /format\s/,
];

/** Commands that search/find content. */
const BASH_SEARCH_COMMANDS = new Set([
  'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis',
]);

/** Commands that read/output content. */
const BASH_READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings',
  'jq', 'awk', 'cut', 'sort', 'uniq', 'tr',
]);

/** Commands that list directory contents. */
const BASH_LIST_COMMANDS = new Set([
  'ls', 'tree', 'du',
]);

/** Commands with no visible output that should be silenced in UI. */
const BASH_SILENT_COMMANDS = new Set([
  'mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'touch', 'ln',
  'cd', 'export', 'unset', 'wait',
]);

export class BashTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Executes bash commands with sandboxing and timeout support.';
  name(): string {
    return 'Bash';
  }

  description(): string {
    return 'Executes a given bash command and returns its output.' +
      ' Use for file operations, git commands, build tools, package managers, etc.' +
      ' Destructive commands (git push, rm -rf, sudo) are blocked unless explicitly allowed.';
  }

  prompt(): string {
    return '## Bash Usage\n' +
      '- Your workspace is the primary working directory, but you can work in any path.\n' +
      '- File search: use Glob (NOT find or ls)\n' +
      '- Content search: use Grep (NOT grep or rg)\n' +
      '- Read files: use Read (NOT cat/head/tail)\n' +
      '- Edit files: use Edit (NOT sed/awk)\n' +
      '- Write files: use Write (NOT echo >/cat <<EOF)\n' +
      '- Communication: output text directly (NOT echo/printf)\n' +
      '- If a command will create new files/directories, verify the parent directory exists first\n' +
      '- Multi-command chaining: use && (sequential, stop on failure) or ; (sequential, ignore failure)\n' +
      '- Never use sleep between commands that can run immediately — just run them\n' +
      '- For long-running commands, use run_in_background instead of blocking with sleep';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute',
        },
        description: {
          type: 'string',
          description: 'Clear, concise description of what this command does in active voice (5-10 words)',
        },
        timeout: {
          type: 'number',
          description: `Optional timeout in milliseconds (max ${DEFAULT_TIMEOUT_MS * 20}). Default: ${DEFAULT_TIMEOUT_MS}.`,
        },
        dangerouslyDisableSandbox: {
          type: 'boolean',
          description: 'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Set to true to run this command in the background.',
        },
      },
      required: ['command', 'description'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.High;
  }

  requiresConfirmation(ctx: ExecutionContext): boolean {
    if (this.riskLevel() === RiskLevel.Critical) return true;
    if (this.riskLevel() === RiskLevel.High && !ctx.userConfirmed) return true;
    return false;
  }

  isConcurrencySafe(): boolean {
    return false; // Bash commands can have side effects, run sequentially.
  }

  isDestructive(): boolean {
    return true;
  }

  interruptBehavior(): InterruptBehavior {
    // TODO: check actual command for destructiveness
    // For now, default to Cancel for non-destructive, Block for destructive
    return InterruptBehavior.Block;
  }

  isAsync(): boolean {
    return false; // Default; set to true for background commands
  }

  defaultTimeoutMs(): number {
    return DEFAULT_TIMEOUT_MS;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const command = params.command as string;
    const description = params.description as string | undefined;
    const timeout = (params.timeout as number) || DEFAULT_TIMEOUT_MS;
    const runInBackground = (params.run_in_background as boolean) ?? false;

    if (!command || typeof command !== 'string') {
      return this.makeError('command is required');
    }

    // Check for destructive commands
    if (isDestructiveCommand(command) && !ctx.userConfirmed) {
      return this.makeError(
        `BLOCKED: Destructive command detected: "${command.slice(0, 80)}". ` +
        `Requires user confirmation before execution.`
      );
    }

    const startedAt = Date.now();

    // Background execution
    if (runInBackground) {
      try {
        const shell = getShell();
        const wrappedCmd = wrapCommand(command, shell);
        const startTime = Date.now();

        // Register with BackgroundTaskManager BEFORE spawning child process
        const bgManager = BackgroundTaskManager.getInstance();
        const bgTaskId = bgManager.register({
          type: 'bash',
          parentSessionId: ctx.sessionId,
          parentAgentId: ctx.agentId,
          summary: command.slice(0, 80),
          command,
        });

        const child = exec(wrappedCmd, {
          cwd: ctx.workspace,
          timeout: Math.min(timeout, DEFAULT_TIMEOUT_MS * 20),
          windowsHide: true,
          shell,
        } as ExecOptions);

        // Backfill pid now that the child process exists
        const bgTask = bgManager.getTask(bgTaskId);
        if (bgTask) bgTask.pid = child.pid;

        const bgKey = `${ctx.sessionId}:${startTime}`;
        backgroundProcesses.set(bgKey, { child, startedAt: startTime, command });

        child.on('exit', (code) => {
          backgroundProcesses.delete(bgKey);
          const durationMs = Date.now() - startTime;
          if (code === 0) {
            bgManager.complete(bgTaskId, { content: `Background process exited with code 0.`, durationMs }).catch(err => {
              const log = createLogger('anochat.tool');
              log.warn('Failed to complete bg task', { bgTaskId, error: (err as Error).message });
            });
          } else {
            bgManager.fail(bgTaskId, `Background process exited with code ${code}`, durationMs).catch(err => {
              const log = createLogger('anochat.tool');
              log.warn('Failed to fail bg task', { bgTaskId, error: (err as Error).message });
            });
          }
        });

        // Handle process errors
        child.on('error', (err: Error) => {
          backgroundProcesses.delete(bgKey);
          const durationMs = Date.now() - startTime;
          bgManager.fail(bgTaskId, err.message, durationMs).catch(err2 => {
            const log = createLogger('anochat.tool');
            log.warn('Failed to fail bg task on error', { bgTaskId, error: (err2 as Error).message });
          });
        });

        return this.makeResult(
          `Background task started.\nTask ID: ${bgTaskId}\nPID: ${child.pid || 'unknown'}\nCommand: ${command.slice(0, 100)}\n\nTo wait for completion, use the Sleep tool with wait_for_task_id="${bgTaskId}". You will also receive a <task-notification> when this task completes or fails.`,
          { startedAt, structured: { taskId: bgTaskId, backgroundKey: bgKey, pid: child.pid } },
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return this.makeError(`Failed to start background process: ${errMsg}`);
      }
    }

    // Synchronous execution (forked process)
    try {
      const shell = getShell();
      const wrappedCmd = wrapCommand(command, shell);
      const result = await new Promise<{ stdout: string; stderr: string; error: string; killed: boolean }>(
        (resolve) => {
          const child = exec(
            wrappedCmd,
            {
              cwd: ctx.workspace,
              timeout: Math.min(timeout, DEFAULT_TIMEOUT_MS * 20),
              maxBuffer: 5 * 1024 * 1024, // 5 MB
              windowsHide: true,
              shell,
            },
            (error, stdout, stderr) => {
              let output = (stdout || '') + (stderr || '');
              if (error && !output) {
                output = error.message || String(error);
              }
              resolve({
                stdout: stdout || '',
                stderr: stderr || '',
                error: error ? (error.message || String(error)) : '',
                killed: error?.killed ?? false,
              });
            },
          );

          // Listen for interrupt abort — kill the child process when user interjects
          if (ctx.signal) {
            const onAbort = () => {
              if (child.exitCode === null && !child.killed) {
                child.kill('SIGTERM');
                // If still alive after 3s, force kill
                setTimeout(() => {
                  if (child.exitCode === null && !child.killed) {
                    child.kill('SIGKILL');
                  }
                }, 3000);
              }
            };
            if (ctx.signal.aborted) {
              onAbort(); // Already aborted — kill immediately
            } else {
              ctx.signal.addEventListener('abort', onAbort, { once: true });
            }
          }
        },
      );

      let output = (result.stdout || '') + (result.stderr || '');
      // If the process was killed by interrupt, surface it
      if (result.killed) {
        output = '[Interrupted by user]\n' + (output || '(no output before interrupt)');
      }
      // If no output but exec signalled an error, surface the error message
      if (!output.trim() && result.error) {
        output = result.error;
      }
      output = output.trim();
      if (!output) output = '(no output)';

      const wasTruncated = output.length > MAX_OUTPUT_CHARS;
      if (wasTruncated) {
        output = output.slice(0, MAX_OUTPUT_CHARS) +
          `\n... [truncated, ${output.length} chars total]`;
      }

      return this.makeResult(output, { startedAt, wasTruncated });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Bash command failed: ${errMsg}`);
    }
  }

  // ── UI helpers ──

  userFacingName(_input?: Record<string, unknown>): string {
    return 'Bash';
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (input?.description && typeof input.description === 'string') {
      return input.description;
    }
    if (input?.command && typeof input.command === 'string') {
      return this.truncate(input.command, 50);
    }
    return null;
  }

  getActivityDescription(input?: Record<string, unknown>): string | null {
    if (input?.description && typeof input.description === 'string') {
      return input.description;
    }
    return 'Running command';
  }

  isSearchOrRead(): { isSearch: boolean; isRead: boolean } {
    return { isSearch: false, isRead: false };
  }

  /** Get a snapshot of active background processes. For TaskStop / supervision. */
  static getBackgroundProcesses(): ReadonlyMap<string, { pid: unknown; startedAt: number; command: string }> {
    const snapshot = new Map<string, { pid: unknown; startedAt: number; command: string }>();
    for (const [key, entry] of backgroundProcesses) {
      snapshot.set(key, { pid: entry.child.pid, startedAt: entry.startedAt, command: entry.command });
    }
    return snapshot;
  }

  /** Kill a background process by its registry key. Returns true if found and killed. */
  static killBackgroundProcess(key: string): boolean {
    const entry = backgroundProcesses.get(key);
    if (!entry) return false;
    try {
      entry.child.kill('SIGTERM');
      backgroundProcesses.delete(key);
      return true;
    } catch {
      return false;
    }
  }
}

/** Extract the base command name from a shell command string. */
function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  // Handle chained commands (e.g. "cd /tmp && ls") — extract first command
  const first = trimmed.split(/\s*(?:\|\||&&|;|\|)\s*/)[0].trim();
  // Handle shell builtins, env vars, etc. — take the first word that looks like a command
  const words = first.split(/\s+/);
  // Skip leading variable assignments (e.g. VAR=val cmd)
  let idx = 0;
  while (idx < words.length && words[idx].includes('=') && !words[idx].includes('/')) {
    idx++;
  }
  if (idx < words.length) {
    // Strip path prefix (e.g. /usr/bin/git → git)
    const cmd = words[idx];
    const slashIdx = cmd.lastIndexOf('/');
    return slashIdx >= 0 ? cmd.slice(slashIdx + 1) : cmd;
  }
  return words[0] || '';
}

/** Classify a bash command as search, read, list, or neither. */
export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
} {
  const base = extractBaseCommand(command);
  return {
    isSearch: BASH_SEARCH_COMMANDS.has(base),
    isRead: BASH_READ_COMMANDS.has(base),
    isList: BASH_LIST_COMMANDS.has(base),
  };
}

/** Check if a bash command has no visible output (silent commands like mv, cp, etc.). */
export function isSilentBashCommand(command: string): boolean {
  const base = extractBaseCommand(command);
  return BASH_SILENT_COMMANDS.has(base);
}

/** Determine the shell to use based on platform. Prefers Git Bash on Windows. */
function getShell(): string {
  // On Windows, try to find Git Bash even if SHELL env points to a POSIX path
  if (process.platform === 'win32') {
    // Prefer the real bash (usr/bin) over the 46KB shim (bin/)
    const gitBashPaths = [
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const p of gitBashPaths) {
      if (fs.existsSync(p)) return p;
    }
    return process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/** Wrap command with encoding fixes for the active shell. */
function wrapCommand(command: string, shell: string): string {
  const isCmd = shell.toLowerCase().includes('cmd.exe');
  if (isCmd) {
    // Switch cmd.exe to UTF-8 code page to prevent garbled Chinese output
    return `chcp 65001 > nul && ${command}`;
  }
  // For bash, ensure UTF-8 locale
  return `export LC_ALL=C.UTF-8 LANG=C.UTF-8 2>/dev/null; ${command}`;
}

/** Check if a command matches destructive patterns. */
function isDestructiveCommand(cmd: string): boolean {
  // Normalize Unicode to prevent homoglyph bypass (e.g. Cyrillic 'а' vs Latin 'a')
  const normalized = cmd.trim().normalize('NFKC').toLowerCase();
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}
