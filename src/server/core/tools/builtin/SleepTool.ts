// SleepTool - agent-controlled sleep/wait
// Allows the agent to pause execution for a specified duration,
// or wait for a background task to complete.
// RiskLevel: Low (no side effects, just delays).
// interruptBehavior: Cancel (sleep can be interrupted).

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';
import { createLogger } from '../../logger.js';

const log = createLogger('anochat.tool');
const MAX_WAIT_MS = 300000; // 5 minutes
const DEFAULT_WAIT_SECONDS = 300;

export class SleepTool extends Tool {

  static category = 'Planning & Communication';
  static toolDescription = 'Sleeps for a specified duration before resuming work.';
  name(): string {
    return 'Sleep';
  }

  description(): string {
    return 'Sleep for a specified duration, or wait for a background task to complete.' +
      ' Without wait_for_task_id: pauses for delaySeconds (max 300s).' +
      ' With wait_for_task_id: subscribes to task completion and wakes immediately' +
      ' when the task finishes - no polling needed. Max wait 5 minutes, then times out.' +
      ' Use this instead of polling loops when waiting for background bash commands,' +
      ' installs, downloads, builds, or any long-running operation.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        delaySeconds: {
          type: 'number',
          description: 'Number of seconds to wait (max 300 seconds / 5 minutes). Required when not using wait_for_task_id.',
        },
        reason: {
          type: 'string',
          description: 'Why the agent is sleeping (shown in UI)',
        },
        wait_for_task_id: {
          type: 'string',
          description: 'Background task ID to wait for. When provided, Sleep subscribes to task completion and wakes instantly when the task finishes - no polling. Max wait 5 minutes, then times out. Use this instead of sleep-loop polling for background bash commands, installs, downloads, or builds.',
        },
      },
      required: [],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Low;
  }

  isReadOnly(): boolean {
    return true;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel; // Sleep can always be interrupted
  }

  isAsync(): boolean {
    return true; // Sleep is inherently async (long-running wait)
  }

  defaultTimeoutMs(): number {
    return MAX_WAIT_MS + 1000; // Tool-level wait plus pipeline grace.
  }

  maxRetries(): number {
    return 0;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const delaySeconds = params.delaySeconds as number | undefined;
    const reason = (params.reason as string) || 'No reason provided';
    const waitForTaskId = params.wait_for_task_id as string | undefined;

    if (waitForTaskId !== undefined && waitForTaskId !== null && typeof waitForTaskId !== 'string') {
      return this.makeError('wait_for_task_id must be a string');
    }
    if (delaySeconds !== undefined && delaySeconds !== null && (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds))) {
      return this.makeError('delaySeconds must be a finite number');
    }

    // ── Task-completion wait mode ──
    if (waitForTaskId) {
      return this._waitForTask(waitForTaskId, delaySeconds, ctx);
    }

    // ── Timed sleep mode ──
    if (delaySeconds === undefined || delaySeconds === null) {
      return this.makeError('Either delaySeconds or wait_for_task_id is required');
    }

    if (delaySeconds < 0) {
      return this.makeError('delaySeconds must be a non-negative number');
    }

    // Cap at 5 minutes to prevent infinite sleep
    const cappedDelay = Math.min(delaySeconds, 300);
    const startedAt = Date.now();
    let interrupted = false;

    // Abort-aware sleep - resolve immediately when user interjects
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cappedDelay * 1000);
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          interrupted = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        const onAbort = () => { interrupted = true; clearTimeout(timer); resolve(); };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    const actualMs = Date.now() - startedAt;
    if (interrupted) {
      return this.makeError(
        `Sleep interrupted by user after ${(actualMs / 1000).toFixed(1)} seconds. Reason: ${reason}`,
        {
          startedAt,
          structured: {
            sleepStatus: 'aborted',
            requestedDelaySeconds: delaySeconds,
            actualMs,
          },
        },
      );
    }

    return this.makeResult(
      `Slept for ${(actualMs / 1000).toFixed(1)} seconds. Reason: ${reason}`,
      {
        startedAt,
        structured: {
          sleepStatus: 'completed',
          requestedDelaySeconds: delaySeconds,
          cappedDelaySeconds: cappedDelay,
          actualMs,
        },
      },
    );
  }

  // ── Task-completion wait ──

  private async _waitForTask(
    taskId: string,
    maxDelaySeconds: number | undefined,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    if (!taskId.trim()) {
      return this.makeError('wait_for_task_id must not be empty', { startedAt });
    }
    if (maxDelaySeconds !== undefined && (!Number.isFinite(maxDelaySeconds) || maxDelaySeconds < 0)) {
      return this.makeError('delaySeconds must be a non-negative finite number when waiting for a task', { startedAt });
    }
    const maxWaitMs = Math.min((maxDelaySeconds ?? DEFAULT_WAIT_SECONDS) * 1000, MAX_WAIT_MS);

    // Check if task already finished (fast path)
    const bgManager = BackgroundTaskManager.getInstance();
    if (!bgManager.hasTask(taskId)) {
      const recent = bgManager.getRecentTaskResult(taskId);
      if (recent) {
        const waitedMs = Date.now() - startedAt;
        if (recent.status === 'completed') {
          return this.makeResult(
            `Task ${taskId} had already completed.\nOutput: ${recent.content || '(no output)'}`,
            {
              startedAt,
              structured: {
                taskId,
                taskStatus: 'completed',
                waitedMs,
                recent: true,
                durationMs: recent.durationMs,
              },
            },
          );
        }
        return this.makeError(
          `Task ${taskId} had already ${recent.status}: ${recent.error || 'unknown error'}`,
          {
            startedAt,
            structured: {
              taskId,
              taskStatus: recent.status,
              waitedMs,
              recent: true,
              durationMs: recent.durationMs,
            },
          },
        );
      }

      log.info('SleepTool: task not found', { taskId });
      return this.makeError(
        `Task ${taskId} was not found. It may have expired from the recent task result cache, or the task ID may be incorrect.`,
        { startedAt, structured: { taskId, taskStatus: 'not_found', waitedMs: 0 } },
      );
    }

    const result = await new Promise<{
      status: 'completed' | 'failed' | 'timeout' | 'aborted';
      content?: string;
      error?: string;
    }>((resolve) => {
      let unsubCompleted: (() => void) | null = null;
      let unsubFailed: (() => void) | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let abortCleanup: (() => void) | null = null;
      let settled = false;

      const settle = (r: typeof result) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubCompleted) unsubCompleted();
        if (unsubFailed) unsubFailed();
        if (abortCleanup) abortCleanup();
        resolve(r);
      };

      // Subscribe to task completed event, filtered by taskId
      unsubCompleted = TypedEventBus.on('task:completed', (payload: { taskId: string; content: string }) => {
        if (payload.taskId === taskId) {
          settle({ status: 'completed', content: payload.content });
        }
      });

      // Subscribe to task failed event, filtered by taskId
      unsubFailed = TypedEventBus.on('task:failed', (payload: { taskId: string; error: string }) => {
        if (payload.taskId === taskId) {
          settle({ status: 'failed', error: payload.error });
        }
      });

      // Max timeout
      timeoutId = setTimeout(() => {
        settle({ status: 'timeout', error: `Task ${taskId} did not complete within ${maxWaitMs / 1000}s` });
      }, maxWaitMs);

      // Abort signal (user interrupt)
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          settle({ status: 'aborted', error: 'Interrupted by user' });
          return;
        }
        const onAbort = () => settle({ status: 'aborted', error: 'Interrupted by user' });
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        abortCleanup = () => ctx.signal!.removeEventListener('abort', onAbort);
      }
    });

    const actualMs = Date.now() - startedAt;
    const waitedSec = (actualMs / 1000).toFixed(1);

    switch (result.status) {
      case 'completed':
        return this.makeResult(
          `Task ${taskId} completed after ${waitedSec}s.\nOutput: ${result.content || '(no output)'}`,
          { startedAt, structured: { taskId, taskStatus: 'completed', waitedMs: actualMs } },
        );
      case 'failed':
        return this.makeError(
          `Task ${taskId} failed after ${waitedSec}s: ${result.error || 'unknown error'}`,
          { startedAt, structured: { taskId, taskStatus: 'failed', waitedMs: actualMs } },
        );
      case 'timeout':
        return this.makeError(
          `Waited ${waitedSec}s for task ${taskId} - timed out. The task may still be running in the background.`,
          { startedAt, structured: { taskId, taskStatus: 'timeout', waitedMs: actualMs } },
        );
      case 'aborted':
        return this.makeError(
          `Wait for task ${taskId} interrupted by user after ${waitedSec}s.`,
          { startedAt, structured: { taskId, taskStatus: 'aborted', waitedMs: actualMs } },
        );
    }
  }
}
