import * as path from 'path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { createLogger } from '../../logger.js';
import { atomicWriteFile } from './FileUtils.js';

const CHECKPOINT_FILE = 'data/restart-checkpoint.json';
const MAX_RESUME_MESSAGE_CHARS = 2000;
const DEFAULT_DELAY_MS = 100;
const MAX_DELAY_MS = 10000;
const log = createLogger('anochat.tool');

interface RestartParams {
  resumeMessage: string;
  dryRun: boolean;
  delayMs: number;
}

export class RestartServerTool extends Tool {

  static category = 'System';
  static toolDescription = 'Gracefully restart the AnoClaw server and resume the current session.';

  name(): string {
    return 'RestartServer';
  }

  description(): string {
    return 'Restart the AnoClaw application gracefully. Writes a checkpoint so the current session resumes automatically after restart.';
  }

  prompt(): string {
    return '## RestartServer Usage\n' +
      'Gracefully restart the application. A checkpoint is written to disk - your session resumes exactly where it left off after restart.\n\n' +
      '**When to use:** After modifying server source code (src/server/) that needs recompilation. After installing new npm packages.\n\n' +
      '**When NOT to use:** Plugin changes (auto-reload via file watcher). Frontend changes (just rebuild, no restart needed). Any change that doesn\'t touch server code.\n\n' +
      'The `resumeMessage` parameter is shown to you after restart - include what you were working on and your next step.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        resumeMessage: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RESUME_MESSAGE_CHARS,
          pattern: '\\S',
          description: 'Message to yourself after restart - what you were doing and what to do next.',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate and report the restart checkpoint without writing it or restarting. Default false.',
        },
        delay_ms: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_DELAY_MS,
          description: `Delay before relaunching after the tool result is sent. Default ${DEFAULT_DELAY_MS}ms, max ${MAX_DELAY_MS}ms.`,
        },
      },
      required: ['resumeMessage'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Critical;
  }

  isReadOnly(): boolean {
    return false;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  defaultTimeoutMs(): number {
    return 5000;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const normalized = normalizeRestartParams(params);
    if (!normalized.ok) return this.makeError(normalized.error);
    const { resumeMessage, dryRun, delayMs } = normalized.value;
    const restartId = `restart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = path.resolve(process.cwd(), CHECKPOINT_FILE);

    const checkpoint = {
      restartId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      resumeMessage,
      delayMs,
      timestamp: Date.now(),
    };

    if (dryRun) {
      return this.makeResult(
        `Dry run: restart checkpoint is valid for session ${ctx.sessionId}. No restart scheduled.`,
        {
          structured: {
            restartId,
            status: 'dry_run',
            checkpointPath: filePath,
            checkpoint,
            willRestart: false,
            electronRuntime: Boolean(process.versions.electron),
          },
        },
      );
    }

    if (!process.versions.electron) {
      return this.makeError(
        'RestartServer requires the Electron desktop runtime. Checkpoint was not written and the process was not exited.',
        {
          structured: {
            restartId,
            status: 'unsupported_runtime',
            checkpointPath: filePath,
            willRestart: false,
            electronRuntime: false,
          },
        },
      );
    }

    try {
      await atomicWriteFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    } catch (err) {
      return this.makeError(`Failed to write restart checkpoint: ${(err as Error).message}`, {
        structured: {
          restartId,
          status: 'checkpoint_write_failed',
          checkpointPath: filePath,
          willRestart: false,
        },
      });
    }

    // Register with BackgroundTaskManager so AgentLoop enters event-driven wait
    const bgm = BackgroundTaskManager.getInstance();
    const taskId = bgm.register({
      type: 'command',
      parentSessionId: ctx.sessionId,
      parentAgentId: ctx.agentId,
      summary: 'Server restart',
    });
    log.info('RestartServer: registered background task', { taskId, sessionId: ctx.sessionId, restartId });

    // Close all WebSocket connections with code 1012 (Service Restart).
    // Frontend detects this close code and does location.reload() to
    // pick up new JS/CSS before reconnecting.
    try {
      const { WsServer } = await import('../../../infra/network/WsServer.js');
      WsServer.getInstance().shutdownAll();
    } catch (err) {
      log.warn('RestartServer: failed to close WebSocket clients before restart', {
        restartId,
        error: (err as Error).message,
      });
    }

    // Schedule restart after the tool result has been flushed to the frontend.
    // Electron's app.quit() is graceful - it fires before-quit -> windows close -> exit.
    const timer = setTimeout(async () => {
      try {
        const electron = await import('electron');
        electron.app.relaunch();
        electron.app.quit();
      } catch (err) {
        const message = (err as Error).message;
        log.error('RestartServer: Electron relaunch failed', { restartId, taskId, error: message });
        if (bgm.hasTask(taskId)) {
          await bgm.fail(taskId, `Electron relaunch failed: ${message}`, 0).catch(() => undefined);
        }
      }
    }, delayMs);
    timer.unref?.();

    return this.makeResult(
      `Server restarting. Will resume session ${ctx.sessionId} after restart.\nResume: "${resumeMessage}"`,
      {
        structured: {
          restartId,
          status: 'scheduled',
          taskId,
          checkpointPath: filePath,
          delayMs,
          willRestart: true,
          electronRuntime: true,
        },
      },
    );
  }
}

type Normalization<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function normalizeRestartParams(params: Record<string, unknown>): Normalization<RestartParams> {
  const resumeMessage = normalizeString(params.resumeMessage, 'resumeMessage', MAX_RESUME_MESSAGE_CHARS);
  if (!resumeMessage.ok) return resumeMessage;

  const dryRun = normalizeBoolean(params.dry_run, 'dry_run', false);
  if (!dryRun.ok) return dryRun;

  const delayMs = normalizeInteger(params.delay_ms, 'delay_ms', DEFAULT_DELAY_MS, 0, MAX_DELAY_MS);
  if (!delayMs.ok) return delayMs;

  return {
    ok: true,
    value: {
      resumeMessage: resumeMessage.value,
      dryRun: dryRun.value,
      delayMs: delayMs.value,
    },
  };
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
): Normalization<string> {
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: `${field} must not be empty` };
  if (trimmed.length > maxLength) return { ok: false, error: `${field} must be ${maxLength} characters or less` };
  return { ok: true, value: trimmed };
}

function normalizeBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): Normalization<boolean> {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  if (typeof value !== 'boolean') return { ok: false, error: `${field} must be a boolean` };
  return { ok: true, value };
}

function normalizeInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): Normalization<number> {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: `${field} must be an integer` };
  if (value < min) return { ok: false, error: `${field} must be at least ${min}` };
  if (value > max) return { ok: false, error: `${field} must be ${max} or less` };
  return { ok: true, value };
}
