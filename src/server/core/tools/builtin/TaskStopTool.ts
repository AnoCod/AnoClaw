// TaskStopTool - stop a running delegated task
// Uses InterruptController to abort the target session's AgentLoop.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { InterruptController, InterruptReason } from '../../agent/supervision/InterruptController.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { BashTool } from './BashTool.js';

export class TaskStopTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Stops a running background task by its ID.';
  name(): string {
    return 'TaskStop';
  }

  description(): string {
    return 'Stop a running delegated task by taskId. Halts execution of the target task. The task can be reassigned later if needed.';
  }

  prompt(): string {
    return '## TaskStop Usage\n' +
      'Cancel a running delegated task. The task stops immediately - partial results may be available via TaskOutput.\n\n' +
      '**When to stop:** The task is going in the wrong direction. The requirements changed. The subordinate is stuck in a loop.\n\n' +
      '**Delegation lifecycle:** TaskAssign -> TaskList (track) -> TaskOutput (retrieve) -> TaskStop (cancel if needed).';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'The sub-session ID of the delegated task to stop',
        },
        task_id: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Alias for taskId. Kept for older prompts and integrations.',
        },
      },
      required: [],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const taskId = normalizeTaskId(params);
    if (!taskId) {
      return this.makeError('taskId is required');
    }

    if (taskId.startsWith('bt-')) {
      return this._stopBackgroundTask(taskId);
    }

    const interruptController = InterruptController.getInstance();

    // Check if there's an active controller for this session
    if (!interruptController.getController(taskId)) {
      return this.makeResult(
        `No active task found for session '${taskId}'. ` +
        'The task may have already completed or was not started yet.',
      );
    }

    // Request interrupt
    interruptController.requestInterrupt(taskId, InterruptReason.ParentStop);

    return this.makeResult(
      `Task '${taskId}' has been stopped. ` +
      'The subordinate agent\'s loop has been interrupted. ' +
      'Any partial results may have been saved to the transcript.',
    );
  }

  private async _stopBackgroundTask(taskId: string): Promise<ToolResult> {
    const bgManager = BackgroundTaskManager.getInstance();
    const task = bgManager.getTask(taskId);

    if (!task) {
      const recent = bgManager.getRecentTaskResult(taskId);
      if (recent) {
        return this.makeError(
          `Background task '${taskId}' is already ${recent.status}; nothing to stop.`,
          {
            structured: {
              taskId,
              status: recent.status,
              recent: true,
              durationMs: recent.durationMs,
            },
          },
        );
      }
      return this.makeError(
        `No active background task found for '${taskId}'. It may have already completed or expired from recent results.`,
        { structured: { taskId, status: 'not_found' } },
      );
    }

    let killedProcess = false;
    if (task.type === 'bash' && typeof task.pid === 'number') {
      killedProcess = BashTool.killBackgroundProcessByPid(task.pid);
    }

    if (killedProcess) {
      const finalized = await waitForRecentBackgroundResult(bgManager, taskId, 1000);
      return this.makeResult(
        `Background task '${taskId}' has been stopped.` +
        ' Partial output, if any, is available via TaskOutput.' +
        ' Process was terminated.',
        {
          structured: {
            taskId,
            status: finalized?.status ?? 'stopping',
            type: task.type,
            summary: task.summary,
            pid: task.pid,
            killedProcess,
            finalized: Boolean(finalized),
          },
        },
      );
    }

    const killedTask = bgManager.kill(taskId);
    if (!killedTask) {
      return this.makeError(
        `Background task '${taskId}' could not be stopped because it is no longer running.`,
        { structured: { taskId, status: 'not_running', killedProcess } },
      );
    }

    return this.makeResult(
      `Background task '${taskId}' has been stopped.` +
      (task.type === 'bash'
        ? ` Process ${killedProcess ? 'was terminated' : 'was not found in the local process registry'}.`
        : ''),
      {
        structured: {
          taskId,
          status: 'killed',
          type: task.type,
          summary: task.summary,
          pid: task.pid,
          killedProcess,
        },
      },
    );
  }
}

async function waitForRecentBackgroundResult(
  bgManager: BackgroundTaskManager,
  taskId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recent = bgManager.getRecentTaskResult(taskId);
    if (recent) return recent;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return bgManager.getRecentTaskResult(taskId);
}

function normalizeTaskId(params: Record<string, unknown>): string | null {
  const value = params.taskId ?? params.task_id;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
