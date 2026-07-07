// BashTool - executes shell commands
// RiskLevel: High/Critical (depends on command).
// InterruptBehavior: Block for destructive commands, Cancel otherwise.
// Based on Claude Code's BashTool pattern.

import { exec, spawn, spawnSync, type ChildProcess, type ExecOptions } from 'child_process';
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

/** Maximum foreground command timeout (10 minutes). */
const MAX_TIMEOUT_MS = DEFAULT_TIMEOUT_MS * 20;

/** Grace period before force-killing a command after timeout/interrupt. */
const COMMAND_KILL_GRACE_MS = 250;

/** Max wait for close after a timeout/interrupt before returning control to the agent. */
const COMMAND_TERMINATION_FEEDBACK_MS = 600;

/** Maximum output size before truncation. */
const MAX_OUTPUT_CHARS = 10000;

/** Maximum caller-configurable output size. */
const MAX_CONFIGURABLE_OUTPUT_CHARS = 100000;

/** Hard cap for captured foreground process output before the process is stopped. */
const MAX_CAPTURE_CHARS = 5 * 1024 * 1024;

/** Maximum TTL for background processes before forced cleanup (30 minutes). */
const BG_TTL_MS = 30 * 60 * 1000;

/** Registry of background child processes, keyed by sessionId:timestamp */
const backgroundProcesses = new Map<string, {
  child: ReturnType<typeof exec>;
  startedAt: number;
  command: string;
  sessionId: string;
  watchdog: ReturnType<typeof setTimeout>;
}>();

/** Destructive command patterns that require user confirmation. */
const DESTRUCTIVE_PATTERNS = [
  /git\s+push/,
  /git\s+reset/,
  /git\s+clean\b.*-[^\n]*[fd]/,
  /rm\s+-rf/,
  /remove-item\b.*-recurse/,
  /\brd\s+\/s\b/,
  /\brmdir\s+\/s\b/,
  /\bdel\s+\/[sq]\b/,
  /sudo\s/,
  /chmod\s/,
  /chown\s/,
  /\breg\s+delete\b/,
  /\btaskkill\b.*\/f/,
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
      '- Never use sleep between commands that can run immediately - just run them\n' +
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
          description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS}). Default: ${DEFAULT_TIMEOUT_MS}.`,
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory. Relative paths are resolved from the workspace.',
        },
        max_output_chars: {
          type: 'number',
          description: `Optional output limit in characters (max ${MAX_CONFIGURABLE_OUTPUT_CHARS}). Default: ${MAX_OUTPUT_CHARS}.`,
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
    // Bash enforces the user-requested timeout internally. The pipeline watchdog
    // is a hard ceiling so a stuck child process cannot hold the session forever.
    return MAX_TIMEOUT_MS + COMMAND_KILL_GRACE_MS + 5000;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const command = params.command as string;
    const description = params.description as string | undefined;
    const timeoutResult = normalizeTimeout(params.timeout);
    const outputLimitResult = normalizeOutputLimit(params.max_output_chars);
    const runInBackground = (params.run_in_background as boolean) ?? false;
    const cwdParam = params.cwd;

    if (!command || typeof command !== 'string') {
      return this.makeError('command is required');
    }
    if (timeoutResult.error) {
      return this.makeError(timeoutResult.error);
    }
    if (outputLimitResult.error) {
      return this.makeError(outputLimitResult.error);
    }
    if (cwdParam !== undefined && cwdParam !== null && typeof cwdParam !== 'string') {
      return this.makeError('cwd must be a string');
    }

    // Check for destructive commands
    if (isDestructiveCommand(command) && !ctx.userConfirmed) {
      return this.makeError(
        `BLOCKED: Destructive command detected: "${command.slice(0, 80)}". ` +
        `Requires user confirmation before execution.`
      );
    }

    const startedAt = Date.now();
    const timeout = timeoutResult.value ?? DEFAULT_TIMEOUT_MS;
    const outputLimit = outputLimitResult.value ?? MAX_OUTPUT_CHARS;
    const workingDirectory = resolveWorkingDirectory(cwdParam as string | undefined, ctx.workspace);
    if (workingDirectory.error || !workingDirectory.cwd) {
      return this.makeError(workingDirectory.error ?? 'cwd could not be resolved', { startedAt });
    }
    const cwd = workingDirectory.cwd;

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
          cwd,
          timeout: params.timeout === undefined ? 0 : timeout,
          windowsHide: true,
          shell,
        } as ExecOptions);

        // Backfill pid now that the child process exists
        const bgTask = bgManager.getTask(bgTaskId);
        if (bgTask) bgTask.pid = child.pid;

        const bgKey = `${ctx.sessionId}:${startTime}`;
        const watchdog = setTimeout(() => {
          killBgProcess(bgKey);
        }, BG_TTL_MS);

        backgroundProcesses.set(bgKey, {
          child, startedAt: startTime, command, sessionId: ctx.sessionId, watchdog,
        });

        child.on('exit', (code) => {
          clearBgProcess(bgKey);
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
          clearBgProcess(bgKey);
          const durationMs = Date.now() - startTime;
          bgManager.fail(bgTaskId, err.message, durationMs).catch(err2 => {
            const log = createLogger('anochat.tool');
            log.warn('Failed to fail bg task on error', { bgTaskId, error: (err2 as Error).message });
          });
        });

        return this.makeResult(
          `Background task started.\nTask ID: ${bgTaskId}\nPID: ${child.pid || 'unknown'}\nCommand: ${command.slice(0, 100)}\n\nTo wait for completion, use the Sleep tool with wait_for_task_id="${bgTaskId}". You will also receive a <task-notification> when this task completes or fails.`,
          { startedAt, structured: { taskId: bgTaskId, backgroundKey: bgKey, pid: child.pid, cwd } },
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
      const result = await runForegroundCommand(wrappedCmd, shell, cwd, timeout, ctx.signal);

      const formatted = formatCommandOutput(result.stdout, result.stderr, outputLimit);
      const structured = {
        command,
        description,
        cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        interrupted: result.interrupted,
        outputOverflow: result.outputOverflow,
        killed: result.killed,
        durationMs: result.durationMs,
        stdoutChars: result.stdout.length,
        stderrChars: result.stderr.length,
        outputLimit,
      };

      const finishedAt = Date.now();
      if (result.interrupted) {
        return this.makeError(
          `Command interrupted by user: ${command.slice(0, 160)}\n${formatted.output}`,
          { startedAt, finishedAt, durationMs: result.durationMs, wasTruncated: formatted.wasTruncated, structured },
        );
      }
      if (result.timedOut) {
        return this.makeError(
          `Command timed out after ${formatMs(timeout)}: ${command.slice(0, 160)}\n${formatted.output}`,
          { startedAt, finishedAt, durationMs: result.durationMs, wasTruncated: formatted.wasTruncated, structured },
        );
      }
      if (result.outputOverflow) {
        return this.makeError(
          `Command output exceeded ${MAX_CAPTURE_CHARS} characters and was stopped: ${command.slice(0, 160)}\n${formatted.output}`,
          { startedAt, finishedAt, durationMs: result.durationMs, wasTruncated: true, structured },
        );
      }
      if (result.exitCode !== 0) {
        return this.makeError(
          `Command failed with exit code ${result.exitCode}: ${command.slice(0, 160)}\n${formatted.output || result.errorMessage || '(no output)'}`,
          { startedAt, finishedAt, durationMs: result.durationMs, wasTruncated: formatted.wasTruncated, structured },
        );
      }

      const output = formatted.output || '(no output)';
      return this.makeResult(output, {
        startedAt,
        finishedAt,
        durationMs: result.durationMs,
        wasTruncated: formatted.wasTruncated,
        structured,
      });
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
    return killBgProcess(key);
  }

  /** Kill a background process by child pid. Returns true if found and killed. */
  static killBackgroundProcessByPid(pid: number): boolean {
    for (const [key, entry] of backgroundProcesses) {
      if (entry.child.pid === pid) {
        return killBgProcess(key);
      }
    }
    return false;
  }

  /** Clean up all background processes for a given session. */
  static cleanupSession(sessionId: string): void {
    for (const [key, entry] of backgroundProcesses) {
      if (entry.sessionId === sessionId) {
        killBgProcess(key);
      }
    }
  }
}

interface BashExecutionResult {
  stdout: string;
  stderr: string;
  errorMessage: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  interrupted: boolean;
  outputOverflow: boolean;
  durationMs: number;
}

function normalizeTimeout(value: unknown): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: DEFAULT_TIMEOUT_MS };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: 'timeout must be a finite number of milliseconds' };
  }
  const normalized = Math.floor(value);
  if (normalized < 100) {
    return { error: 'timeout must be at least 100 milliseconds' };
  }
  if (normalized > MAX_TIMEOUT_MS) {
    return { error: `timeout must be ${MAX_TIMEOUT_MS} milliseconds or less` };
  }
  return { value: normalized };
}

function normalizeOutputLimit(value: unknown): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: MAX_OUTPUT_CHARS };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: 'max_output_chars must be a finite number' };
  }
  const normalized = Math.floor(value);
  if (normalized < 100) {
    return { error: 'max_output_chars must be at least 100' };
  }
  if (normalized > MAX_CONFIGURABLE_OUTPUT_CHARS) {
    return { error: `max_output_chars must be ${MAX_CONFIGURABLE_OUTPUT_CHARS} or less` };
  }
  return { value: normalized };
}

function resolveWorkingDirectory(cwd: string | undefined, workspace: string): { cwd: string; error?: undefined } | { cwd?: undefined; error: string } {
  const resolved = cwd && cwd.trim()
    ? (path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(workspace, cwd))
    : path.resolve(workspace);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { error: `cwd does not exist: ${resolved}` };
    return { error: `Cannot access cwd ${resolved}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!stat.isDirectory()) {
    return { error: `cwd is not a directory: ${resolved}` };
  }
  return { cwd: resolved };
}

function formatCommandOutput(stdout: string, stderr: string, limit: number): { output: string; wasTruncated: boolean } {
  const sections: string[] = [];
  const stdoutTrimmed = stdout.trimEnd();
  const stderrTrimmed = stderr.trimEnd();
  if (stdoutTrimmed) sections.push(stdoutTrimmed);
  if (stderrTrimmed) sections.push(`[stderr]\n${stderrTrimmed}`);
  const combined = sections.join('\n');
  return truncateMiddle(combined, limit);
}

function truncateMiddle(value: string, limit: number): { output: string; wasTruncated: boolean } {
  if (value.length <= limit) return { output: value, wasTruncated: false };
  let marker = `\n\n... [truncated] ...\n\n`;
  let available = Math.max(0, limit - marker.length);
  let omitted = value.length - available;
  marker = `\n\n... [${omitted} chars truncated] ...\n\n`;
  available = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return {
    output: value.slice(0, headLength) + marker + value.slice(value.length - tailLength),
    wasTruncated: true,
  };
}

function runForegroundCommand(
  command: string,
  shell: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<BashExecutionResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let errorMessage = '';
    let timedOut = false;
    let interrupted = false;
    let outputOverflow = false;
    let killed = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackResolveTimer: ReturnType<typeof setTimeout> | null = null;
    let abortCleanup: (() => void) | null = null;
    let settled = false;

    const invocation = createShellInvocation(shell, command);
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      windowsHide: true,
      detached: true,
    });

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (fallbackResolveTimer) clearTimeout(fallbackResolveTimer);
      abortCleanup?.();
    };

    const finish = (exitCode: number, closeSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        errorMessage,
        exitCode,
        signal: closeSignal,
        killed,
        timedOut,
        interrupted,
        outputOverflow,
        durationMs: Date.now() - startTime,
      });
    };

    const terminate = (reason: 'timeout' | 'interrupt' | 'output_overflow') => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'interrupt') interrupted = true;
      if (reason === 'output_overflow') outputOverflow = true;
      killed = true;
      terminateChildProcess(child);
      forceKillTimer = setTimeout(() => {
        forceKillProcessTree(child.pid);
      }, COMMAND_KILL_GRACE_MS);
      fallbackResolveTimer = setTimeout(() => {
        finish(1, 'SIGTERM');
      }, COMMAND_TERMINATION_FEEDBACK_MS);
    };

    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (outputOverflow) return;
      const text = chunk.toString();
      const currentLength = stdout.length + stderr.length;
      const remaining = MAX_CAPTURE_CHARS - currentLength;
      if (remaining <= 0) {
        terminate('output_overflow');
        return;
      }
      const accepted = text.length > remaining ? text.slice(0, remaining) : text;
      if (target === 'stdout') stdout += accepted;
      else stderr += accepted;
      if (text.length > remaining) {
        errorMessage = `Command output exceeded ${MAX_CAPTURE_CHARS} characters`;
        terminate('output_overflow');
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      appendOutput('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      appendOutput('stderr', chunk);
    });
    child.on('error', (err: Error) => {
      errorMessage = err.message;
      finish(1, null);
    });
    child.on('close', (code, closeSignal) => {
      finish(code ?? (closeSignal ? 1 : 0), closeSignal);
    });

    timeoutTimer = setTimeout(() => terminate('timeout'), timeout);
    if (signal) {
      const onAbort = () => terminate('interrupt');
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }
    }
  });
}

function createShellInvocation(shell: string, command: string): { file: string; args: string[] } {
  const isCmd = shell.toLowerCase().includes('cmd.exe');
  if (isCmd) {
    return { file: shell, args: ['/d', '/s', '/c', command] };
  }
  return { file: shell, args: ['-lc', command] };
}

function terminateChildProcess(child: ChildProcess): void {
  try {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  if (process.platform === 'win32') {
    forceKillProcessTree(child.pid);
  } else if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ignore */ }
  }
}

function forceKillProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch { /* ignore */ }
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`;
}

/** Kill a single background process and clear its watchdog. Returns true if found. */
function killBgProcess(key: string): boolean {
  const entry = backgroundProcesses.get(key);
  if (!entry) return false;
  try {
    terminateChildProcess(entry.child);
  } catch { /* ignore */ }
  clearBgProcess(key);
  return true;
}

/** Remove from registry and clear watchdog timer. */
function clearBgProcess(key: string): void {
  const entry = backgroundProcesses.get(key);
  if (entry) {
    clearTimeout(entry.watchdog);
    backgroundProcesses.delete(key);
  }
}

/** Extract the base command name from a shell command string. */
function extractBaseCommand(command: string): string {
  const trimmed = command.trim();
  // Handle chained commands (e.g. "cd /tmp && ls") - extract first command
  const first = trimmed.split(/\s*(?:\|\||&&|;|\|)\s*/)[0].trim();
  // Handle shell builtins, env vars, etc. - take the first word that looks like a command
  const words = first.split(/\s+/);
  // Skip leading variable assignments (e.g. VAR=val cmd)
  let idx = 0;
  while (idx < words.length && words[idx].includes('=') && !words[idx].includes('/')) {
    idx++;
  }
  if (idx < words.length) {
    // Strip path prefix (e.g. /usr/bin/git -> git)
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
