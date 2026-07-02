// SleepTool — agent-controlled sleep/wait
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
      ' when the task finishes — no polling needed. Max wait 5 minutes, then times out.' +
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
          description: 'Background task ID to wait for. When provided, Sleep subscribes to task completion and wakes instantly when the task finishes — no polling. Max wait 5 minutes, then times out. Use this instead of sleep-loop polling for background bash commands, installs, downloads, or builds.',
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
    return 300000; // 5 minutes max
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const delaySeconds = params.delaySeconds as number | undefined;
    const reason = (params.reason as string) || 'No reason provided';
    const waitForTaskId = params.wait_for_task_id as string | undefined;

    // ── Task-completion wait mode ──
    if (waitForTaskId) {
      return this._waitForTask(waitForTaskId, delaySeconds, ctx);
    }

    // ── Timed sleep mode ──
    if (delaySeconds === undefined || delaySeconds === null) {
      return this.makeError('Either delaySeconds or wait_for_task_id is required');
    }

    if (typeof delaySeconds !== 'number' || delaySeconds < 0) {
      return this.makeError('delaySeconds must be a positive number');
    }

    // Cap at 5 minutes to prevent infinite sleep
    const cappedDelay = Math.min(delaySeconds, 300);
    const startedAt = Date.now();

    // Abort-aware sleep — resolve immediately when user interjects
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cappedDelay * 1000);
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const onAbort = () => { clearTimeout(timer); resolve(); };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    const actualMs = Date.now() - startedAt;
    return this.makeResult(
      `Slept for ${(actualMs / 1000).toFixed(1)} seconds. Reason: ${reason}`,
      { startedAt },
    );
  }

  // ── Task-completion wait ──

  private async _waitForTask(
    taskId: string,
    maxDelaySeconds: number | undefined,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const maxWaitMs = Math.min((maxDelaySeconds ?? 300) * 1000, MAX_WAIT_MS);

    // Check if task already finished (fast path)
    const bgManager = BackgroundTaskManager.getInstance();
    if (!bgManager.hasTask(taskId)) {
      log.info('SleepTool: task not found (already completed or never existed)', { taskId });
      return this.makeResult(
        `Task ${taskId} is not running (already completed, failed, or never existed).`,
        { startedAt, structured: { taskId, taskStatus: 'not_found' } },
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
        return this.makeResult(
          `Waited ${waitedSec}s for task ${taskId} — timed out. The task may still be running in the background.`,
          { startedAt, structured: { taskId, taskStatus: 'timeout', waitedMs: actualMs } },
        );
      case 'aborted':
        return this.makeResult(
          `Wait for task ${taskId} interrupted by user after ${waitedSec}s.`,
          { startedAt, structured: { taskId, taskStatus: 'aborted', waitedMs: actualMs } },
        );
    }
  }
}
