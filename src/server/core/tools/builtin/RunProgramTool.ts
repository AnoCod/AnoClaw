// RunProgramTool - launches native programs without shell command parsing.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { InterruptBehavior, RiskLevel } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { createLogger } from '../../logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 10_000;
const MAX_OUTPUT_LIMIT = 100_000;
const MAX_CAPTURE_CHARS = 5 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_FEEDBACK_MS = 1_000;

type RunMode = 'background' | 'wait';

interface NormalizedParams {
  program: string;
  args: string[];
  description: string;
  cwd: string;
  mode: RunMode;
  visible: boolean;
  timeout: number;
  outputLimit: number;
}

interface WaitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  interrupted: boolean;
  outputOverflow: boolean;
  killed: boolean;
  errorMessage: string;
}

interface ActiveProgram {
  child: ChildProcess;
  taskId: string;
  sessionId: string;
  stop: () => boolean;
}

const activePrograms = new Map<string, ActiveProgram>();

export class RunProgramTool extends Tool {
  static category = 'System';
  static toolDescription = 'Launches a native program with structured arguments, optional output capture, and process tracking.';

  name(): string {
    return 'RunProgram';
  }

  displayName(): string {
    return 'Run Program';
  }

  description(): string {
    return 'Launch a native executable or PATH command without a shell. Use background mode for desktop applications and wait mode for programs whose output or exit status is needed.';
  }

  prompt(): string {
    return '## RunProgram Usage\n' +
      '- Use RunProgram to launch an installed executable or a command available on PATH.\n' +
      '- Pass every argument as a separate args array item; do not add shell quoting.\n' +
      '- Use mode="background" (default) for desktop or long-running applications.\n' +
      '- Use mode="wait" only when you need stdout, stderr, or the exit status.\n' +
      '- Use Bash for pipelines, redirection, shell built-ins, batch files, and scripts.\n' +
      '- RunProgram never invokes a shell and never retries a launch automatically.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        program: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Executable path or command name available on PATH.',
        },
        args: {
          type: 'array',
          maxItems: 200,
          items: { type: 'string', maxLength: 32_768 },
          description: 'Arguments passed directly to the program without shell parsing.',
        },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Clear, concise description of why the program is being launched.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory. Relative paths are resolved from the session workspace.',
        },
        mode: {
          type: 'string',
          enum: ['background', 'wait'],
          description: 'background returns after launch; wait captures output and waits for exit. Default: background.',
        },
        visible: {
          type: 'boolean',
          description: 'Whether Windows may show the program console window. GUI windows remain available. Default: true.',
        },
        timeout: {
          type: 'integer',
          minimum: 100,
          maximum: MAX_TIMEOUT_MS,
          description: `Wait-mode timeout in milliseconds (max ${MAX_TIMEOUT_MS}). Default: ${DEFAULT_TIMEOUT_MS}.`,
        },
        max_output_chars: {
          type: 'integer',
          minimum: 100,
          maximum: MAX_OUTPUT_LIMIT,
          description: `Wait-mode output limit in characters (max ${MAX_OUTPUT_LIMIT}). Default: ${DEFAULT_OUTPUT_LIMIT}.`,
        },
      },
      required: ['program', 'description'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.High;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  isDestructive(): boolean {
    return true;
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  maxRetries(): number {
    return 0;
  }

  defaultTimeoutMs(): number {
    return MAX_TIMEOUT_MS + TERMINATION_FEEDBACK_MS + 5_000;
  }

  confirmationMessage(params: Record<string, unknown>): string {
    const program = typeof params.program === 'string' ? params.program : 'the requested program';
    return `Allow AnoClaw to launch ${program}?`;
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const normalized = normalizeParams(params, ctx.workspace);
    if ('error' in normalized) return this.makeError(normalized.error);

    const input = normalized.value;
    if (input.mode === 'background') {
      return this._runInBackground(input, ctx);
    }
    return this._runAndWait(input, ctx);
  }

  userFacingName(): string {
    return 'Run Program';
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (typeof input?.description === 'string' && input.description.trim()) {
      return this.truncate(input.description.trim(), 50);
    }
    if (typeof input?.program === 'string') return this.truncate(input.program, 50);
    return null;
  }

  getActivityDescription(input?: Record<string, unknown>): string | null {
    if (typeof input?.program === 'string' && input.program.trim()) {
      return `Launching ${path.basename(input.program.trim())}`;
    }
    return 'Launching program';
  }

  static killBackgroundProcessByPid(pid: number): boolean {
    for (const entry of activePrograms.values()) {
      if (entry.child.pid === pid) return entry.stop();
    }
    return false;
  }

  static cleanupSession(sessionId: string): void {
    for (const entry of [...activePrograms.values()]) {
      if (entry.sessionId === sessionId) entry.stop();
    }
  }

  private async _runInBackground(input: NormalizedParams, ctx: ExecutionContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const manager = BackgroundTaskManager.getInstance();
    const commandLabel = formatCommandLabel(input.program, input.args);
    const taskId = manager.register({
      type: 'program',
      parentSessionId: ctx.sessionId,
      parentAgentId: ctx.agentId,
      summary: input.description,
      command: commandLabel,
      awaitCompletion: false,
    });

    let child: ChildProcess;
    try {
      child = spawn(input.program, input.args, {
        cwd: input.cwd,
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: !input.visible,
      });
    } catch (err) {
      const message = errorMessage(err);
      await manager.fail(taskId, `Program failed to start: ${message}`, Date.now() - startedAt);
      return this.makeError(`Failed to start program: ${message}`, { startedAt });
    }

    const backgroundTask = manager.getTask(taskId);
    if (backgroundTask) backgroundTask.pid = child.pid;

    let settled = false;
    let stoppedByUser = false;
    let stopFallback: ReturnType<typeof setTimeout> | null = null;

    const finalize = (kind: 'exit' | 'error' | 'stop-timeout', code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (stopFallback) clearTimeout(stopFallback);
      activePrograms.delete(taskId);
      if (!manager.hasTask(taskId)) return;

      const durationMs = Date.now() - startedAt;
      if (stoppedByUser || kind === 'stop-timeout') {
        manager.kill(taskId, `Program stopped by user request. PID: ${child.pid ?? 'unknown'}`);
      } else if (kind === 'exit' && code === 0 && !signal) {
        manager.complete(taskId, {
          content: `Program exited successfully.\nPID: ${child.pid ?? 'unknown'}\nProgram: ${commandLabel}`,
          durationMs,
        }).catch(logLifecycleError('complete', taskId));
      } else {
        const detail = error || `exit code ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}`;
        manager.fail(
          taskId,
          `Program failed: ${detail}\nPID: ${child.pid ?? 'unknown'}\nProgram: ${commandLabel}`,
          durationMs,
        ).catch(logLifecycleError('fail', taskId));
      }
    };

    const startOutcome = new Promise<{ started: true } | { started: false; error: string }>((resolve) => {
      child.once('spawn', () => resolve({ started: true }));
      child.once('error', (err) => {
        const message = errorMessage(err);
        finalize('error', 1, null, message);
        resolve({ started: false, error: message });
      });
    });

    child.once('exit', (code, signal) => finalize('exit', code, signal));

    const stop = () => {
      if (settled || stoppedByUser) return false;
      stoppedByUser = true;
      terminateProcessTree(child);
      stopFallback = setTimeout(() => finalize('stop-timeout', 1, 'SIGTERM'), TERMINATION_FEEDBACK_MS);
      stopFallback.unref?.();
      return true;
    };

    activePrograms.set(taskId, { child, taskId, sessionId: ctx.sessionId, stop });
    const outcome = await startOutcome;
    if (!outcome.started) {
      return this.makeError(`Failed to start program: ${outcome.error}`, { startedAt });
    }

    child.unref();
    return this.makeResult(
      `Program started.\nTask ID: ${taskId}\nPID: ${child.pid ?? 'unknown'}\nProgram: ${commandLabel}\n\nUse TaskList or TaskOutput to inspect it, and TaskStop with taskId="${taskId}" to stop it.`,
      {
        startedAt,
        structured: {
          taskId,
          pid: child.pid,
          program: input.program,
          args: input.args,
          cwd: input.cwd,
          mode: input.mode,
          visible: input.visible,
        },
      },
    );
  }

  private async _runAndWait(input: NormalizedParams, ctx: ExecutionContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const result = await runAndWait(input, ctx.signal);
    const formatted = formatOutput(result.stdout, result.stderr, input.outputLimit);
    const structured = {
      program: input.program,
      args: input.args,
      cwd: input.cwd,
      mode: input.mode,
      visible: input.visible,
      pid: undefined,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      interrupted: result.interrupted,
      outputOverflow: result.outputOverflow,
      killed: result.killed,
      durationMs: result.durationMs,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
      outputLimit: input.outputLimit,
    };
    const options = {
      startedAt,
      finishedAt: Date.now(),
      durationMs: result.durationMs,
      wasTruncated: formatted.wasTruncated,
      structured,
    };

    if (result.interrupted) {
      return this.makeError(`Program interrupted by user.\n${formatted.output}`, options);
    }
    if (result.timedOut) {
      return this.makeError(`Program timed out after ${formatMs(input.timeout)}.\n${formatted.output}`, options);
    }
    if (result.outputOverflow) {
      return this.makeError(`Program output exceeded ${MAX_CAPTURE_CHARS} characters and was stopped.\n${formatted.output}`, {
        ...options,
        wasTruncated: true,
      });
    }
    if (result.errorMessage) {
      return this.makeError(`Failed to run program: ${result.errorMessage}`, options);
    }
    if (result.exitCode !== 0) {
      return this.makeError(
        `Program failed with exit code ${result.exitCode}.\n${formatted.output || '(no output)'}`,
        options,
      );
    }

    return this.makeResult(formatted.output || 'Program exited successfully.', options);
  }
}

function normalizeParams(
  params: Record<string, unknown>,
  workspace: string,
): { value: NormalizedParams } | { error: string } {
  const program = normalizeRequiredString(params.program, 'program', 32_768);
  if ('error' in program) return program;
  const description = normalizeRequiredString(params.description, 'description', 200);
  if ('error' in description) return description;

  if (params.args !== undefined && !Array.isArray(params.args)) return { error: 'args must be an array of strings' };
  const args = params.args === undefined ? [] : params.args;
  if (args.length > 200 || args.some((arg) => typeof arg !== 'string' || arg.length > 32_768)) {
    return { error: 'args must contain at most 200 strings of 32768 characters or less' };
  }

  const mode = params.mode ?? 'background';
  if (mode !== 'background' && mode !== 'wait') return { error: 'mode must be "background" or "wait"' };
  const visible = params.visible ?? true;
  if (typeof visible !== 'boolean') return { error: 'visible must be a boolean' };

  const timeout = normalizeInteger(params.timeout, 'timeout', DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
  if ('error' in timeout) return timeout;
  const outputLimit = normalizeInteger(
    params.max_output_chars,
    'max_output_chars',
    DEFAULT_OUTPUT_LIMIT,
    100,
    MAX_OUTPUT_LIMIT,
  );
  if ('error' in outputLimit) return outputLimit;

  if (params.cwd !== undefined && typeof params.cwd !== 'string') return { error: 'cwd must be a string' };
  const cwdResult = resolveWorkingDirectory(params.cwd as string | undefined, workspace);
  if ('error' in cwdResult) return cwdResult;

  const programResult = resolveProgram(program.value, cwdResult.value);
  if ('error' in programResult) return programResult;

  return {
    value: {
      program: programResult.value,
      args: args as string[],
      description: description.value,
      cwd: cwdResult.value,
      mode,
      visible,
      timeout: timeout.value,
      outputLimit: outputLimit.value,
    },
  };
}

function normalizeRequiredString(
  value: unknown,
  name: string,
  maxLength: number,
): { value: string } | { error: string } {
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${name} must not be empty` };
  if (trimmed.length > maxLength) return { error: `${name} must be ${maxLength} characters or less` };
  return { value: trimmed };
}

function normalizeInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): { value: number } | { error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'number' || !Number.isInteger(value)) return { error: `${name} must be an integer` };
  if (value < minimum || value > maximum) return { error: `${name} must be between ${minimum} and ${maximum}` };
  return { value };
}

function resolveWorkingDirectory(cwd: string | undefined, workspace: string): { value: string } | { error: string } {
  const resolved = cwd && cwd.trim()
    ? (path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(workspace, cwd))
    : path.resolve(workspace);
  try {
    if (!fs.statSync(resolved).isDirectory()) return { error: `cwd is not a directory: ${resolved}` };
  } catch (err) {
    return { error: `Cannot access cwd ${resolved}: ${errorMessage(err)}` };
  }
  return { value: resolved };
}

function resolveProgram(program: string, cwd: string): { value: string } | { error: string } {
  const looksLikePath = path.isAbsolute(program) || program.includes('/') || program.includes('\\') || program.startsWith('.');
  if (!looksLikePath) return { value: program };

  const resolved = path.isAbsolute(program) ? path.resolve(program) : path.resolve(cwd, program);
  try {
    if (!fs.statSync(resolved).isFile()) return { error: `program is not a file: ${resolved}` };
  } catch (err) {
    return { error: `Cannot access program ${resolved}: ${errorMessage(err)}` };
  }
  return { value: resolved };
}

function runAndWait(input: NormalizedParams, signal: AbortSignal | undefined): Promise<WaitResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let error = '';
    let timedOut = false;
    let interrupted = false;
    let outputOverflow = false;
    let killed = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let abortCleanup: (() => void) | null = null;

    let child: ChildProcess;
    try {
      child = spawn(input.program, input.args, {
        cwd: input.cwd,
        detached: true,
        shell: false,
        windowsHide: !input.visible,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(failedWaitResult(startedAt, errorMessage(err)));
      return;
    }

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      abortCleanup?.();
    };
    const finish = (exitCode: number, closeSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: closeSignal,
        durationMs: Date.now() - startedAt,
        timedOut,
        interrupted,
        outputOverflow,
        killed,
        errorMessage: error,
      });
    };
    const terminate = (reason: 'timeout' | 'interrupt' | 'overflow') => {
      if (settled) return;
      timedOut = reason === 'timeout';
      interrupted = reason === 'interrupt';
      outputOverflow = reason === 'overflow';
      killed = true;
      terminateProcessTree(child);
      forceKillTimer = setTimeout(() => forceKillProcessTree(child.pid), TERMINATION_GRACE_MS);
      fallbackTimer = setTimeout(() => finish(1, 'SIGTERM'), TERMINATION_FEEDBACK_MS);
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (outputOverflow) return;
      const text = chunk.toString();
      const remaining = MAX_CAPTURE_CHARS - stdout.length - stderr.length;
      if (remaining <= 0) {
        error = `Program output exceeded ${MAX_CAPTURE_CHARS} characters`;
        terminate('overflow');
        return;
      }
      const accepted = text.slice(0, remaining);
      if (target === 'stdout') stdout += accepted;
      else stderr += accepted;
      if (text.length > remaining) {
        error = `Program output exceeded ${MAX_CAPTURE_CHARS} characters`;
        terminate('overflow');
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk));
    child.once('error', (err) => {
      error = errorMessage(err);
      finish(1, null);
    });
    child.once('close', (code, closeSignal) => finish(code ?? (closeSignal ? 1 : 0), closeSignal));

    timeoutTimer = setTimeout(() => terminate('timeout'), input.timeout);
    if (signal) {
      const onAbort = () => terminate('interrupt');
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }
    }
  });
}

function failedWaitResult(startedAt: number, error: string): WaitResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 1,
    signal: null,
    durationMs: Date.now() - startedAt,
    timedOut: false,
    interrupted: false,
    outputOverflow: false,
    killed: false,
    errorMessage: error,
  };
}

function terminateProcessTree(child: ChildProcess): void {
  try {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  } catch { /* ignore */ }
  forceKillProcessTree(child.pid);
}

function forceKillProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); }
      catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* ignore */ }
}

function formatOutput(stdout: string, stderr: string, limit: number): { output: string; wasTruncated: boolean } {
  const combined = [stdout.trimEnd(), stderr.trimEnd() ? `[stderr]\n${stderr.trimEnd()}` : '']
    .filter(Boolean)
    .join('\n');
  if (combined.length <= limit) return { output: combined, wasTruncated: false };

  let marker = '\n\n... [output truncated] ...\n\n';
  let available = Math.max(0, limit - marker.length);
  const omitted = combined.length - available;
  marker = `\n\n... [${omitted} chars truncated] ...\n\n`;
  available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return {
    output: combined.slice(0, head) + marker + combined.slice(combined.length - tail),
    wasTruncated: true,
  };
}

function formatCommandLabel(program: string, args: string[]): string {
  return [program, ...args.map((arg) => JSON.stringify(arg))].join(' ');
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logLifecycleError(action: string, taskId: string): (err: unknown) => void {
  return (err) => {
    createLogger('anochat.tool').warn(`Failed to ${action} program task`, {
      taskId,
      error: errorMessage(err),
    });
  };
}
