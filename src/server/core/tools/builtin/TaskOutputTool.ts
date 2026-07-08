// TaskOutputTool - get the output/result from a delegated task
// Returns the result if the task has completed, or the current status if still running.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SessionManager } from '../../session/index.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

export class TaskOutputTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Retrieves the output or status of a delegated or background task.';
  name(): string {
    return 'TaskOutput';
  }

  description(): string {
    return 'Retrieve output for a delegated task by taskId. Use after a task notification or when TaskList indicates completion, failure, or unclear status.';
  }

  prompt(): string {
    return [
      '## TaskOutput Usage',
      'Use TaskOutput to inspect a specific task result, especially after a <task-notification>.',
      '',
      'Use it when you need the child output to integrate, review, retry, or report the final result.',
      'If the task is still running, use the returned status to decide whether to wait, amend with AgentMessage, or stop it.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'The task ID or sub-session ID to retrieve output from',
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

  isReadOnly(): boolean {
    return true;
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const taskId = normalizeTaskId(params);
    if (!taskId) {
      return this.makeError('taskId is required');
    }

    // <task-notification> IDs use bt- prefix (BackgroundTask format),
    // not sub-session IDs. Try BackgroundTaskManager first for bt- IDs.
    if (taskId.startsWith('bt-')) {
      const btm = BackgroundTaskManager.getInstance();
      const task = btm.getTask(taskId);
      if (task) {
        const status =
          task.status === 'completed' ? 'completed' :
          task.status === 'failed' ? 'failed' :
          task.status === 'killed' ? 'killed' :
          'running';
        return this.makeResult(
          `Task "${taskId}" is ${status}.\nSummary: ${task.summary}\nResult: ${task.fullContent || task.error || '(none yet)'}`,
          {
            structured: {
              taskId,
              status,
              summary: task.summary,
              result: task.fullContent,
              error: task.error,
              type: task.type,
              durationMs: task.durationMs,
              pid: task.pid,
              active: true,
            },
          },
        );
      }
      const recent = btm.getRecentTaskResult(taskId);
      if (recent) {
        const output = recent.content || recent.error || '(no output)';
        const structured = {
          taskId,
          status: recent.status,
          summary: recent.summary,
          result: recent.content,
          error: recent.error,
          type: recent.type,
          durationMs: recent.durationMs,
          finishedAt: recent.finishedAt,
          pid: recent.pid,
          active: false,
          recent: true,
        };
        if (recent.status === 'completed') {
          return this.makeResult(
            `Task "${taskId}" completed.\nSummary: ${recent.summary}\nResult: ${output}`,
            { structured },
          );
        }
        return this.makeError(
          `Task "${taskId}" ${recent.status}.\nSummary: ${recent.summary}\nResult: ${output}`,
          { structured },
        );
      }
      return this.makeError(
        `Task "${taskId}" not found in BackgroundTaskManager. It may have expired from the recent result cache. Use TaskList to see active and recent tasks.`,
        { structured: { taskId, status: 'not_found' } },
      );
    }

    const sessionManager = SessionManager.getInstance();
    const session = sessionManager.session(taskId);

    if (!session) {
      return this.makeError(
        `Task session '${taskId}' not found. Use TaskList to see all active tasks.`,
      );
    }

    // If archived, task completed - return the full history
    if (session.isArchived()) {
      const history = await sessionManager.getHistory(taskId);
      if (history.length === 0) {
        return this.makeResult(
          `Task '${taskId}' is archived but has no message history.`,
        );
      }

      // Extract assistant messages (the task output)
      const outputMessages = history.filter(
        (m) => m.role === 'assistant' || m.role === 'tool',
      );
      const output = outputMessages
        .map((m) => `[${m.role}] ${m.content.slice(0, 1000)}`)
        .join('\n\n');

      return this.makeResult(
        `Task '${taskId}' completed.\n` +
        `Agent: ${session.agentId}\n` +
        `Messages: ${history.length}\n\n` +
        `--- Output ---\n${output || '(no output content)'}`,
        {
          structured: {
            taskId,
            status: 'completed',
            agentId: session.agentId,
            messageCount: history.length,
          },
        },
      );
    }

    // Still active - return current status
    const history = await sessionManager.getHistory(taskId);
    const lastMessage = history[history.length - 1];

    return this.makeResult(
      `Task '${taskId}' is still in progress.\n` +
      `Status: ${session.status}\n` +
      `Agent: ${session.agentId}\n` +
      `Messages so far: ${history.length}\n` +
      `Last update: ${lastMessage?.timestamp ?? 'N/A'}\n\n` +
      'Check back later or use TaskList to monitor progress.',
      {
        structured: {
          taskId,
          status: session.status,
          agentId: session.agentId,
          messageCount: history.length,
          lastUpdate: lastMessage?.timestamp,
        },
      },
    );
  }
}

function normalizeTaskId(params: Record<string, unknown>): string | null {
  const value = params.taskId ?? params.task_id;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
