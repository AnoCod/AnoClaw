// TaskOutputTool - get the output/result from a delegated task
// Returns the result if the task has completed, or the current status if still running.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext, Message } from '../../../../shared/types/session.js';
import { SessionManager } from '../../session/index.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

const DEFAULT_MAX_CHARS = 4000;
const MIN_MAX_CHARS = 200;
const MAX_MAX_CHARS = 50000;
const DEFAULT_TAIL_MESSAGES = 50;
const MAX_TAIL_MESSAGES = 100;

interface NormalizedTaskOutputParams {
  taskId: string;
  maxChars: number;
  includeHistory: boolean;
  includeToolMessages: boolean;
  tailMessages: number;
}

type Normalization<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

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
        max_chars: {
          type: 'integer',
          minimum: MIN_MAX_CHARS,
          maximum: MAX_MAX_CHARS,
          description: `Maximum output characters to return. Default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}.`,
        },
        include_history: {
          type: 'boolean',
          description: 'Whether to include transcript/output excerpts for delegated session tasks. Default true.',
        },
        include_tool_messages: {
          type: 'boolean',
          description: 'Whether delegated session output should include tool messages in addition to assistant messages. Default true.',
        },
        tail_messages: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TAIL_MESSAGES,
          description: `Maximum assistant/tool messages to include from the end of a delegated session. Default ${DEFAULT_TAIL_MESSAGES}.`,
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
    const normalized = normalizeTaskOutputParams(params);
    if (!normalized.ok) return this.makeError(normalized.error);

    const {
      taskId,
      maxChars,
      includeHistory,
      includeToolMessages,
      tailMessages,
    } = normalized.value;

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
        const rendered = truncateMiddle(task.fullContent || task.error || '(none yet)', maxChars);
        return this.makeResult(
          `Task "${taskId}" is ${status}.\nSummary: ${task.summary}\nResult: ${rendered.text}`,
          {
            structured: {
              taskId,
              status,
              summary: task.summary,
              result: rendered.text,
              error: task.error,
              type: task.type,
              durationMs: task.durationMs,
              pid: task.pid,
              active: true,
              maxChars,
              outputChars: rendered.text.length,
              originalOutputChars: rendered.originalChars,
              wasTruncated: rendered.wasTruncated,
            },
          },
        );
      }
      const recent = btm.getRecentTaskResult(taskId);
      if (recent) {
        const rendered = truncateMiddle(recent.content || recent.error || '(no output)', maxChars);
        const structured = {
          taskId,
          status: recent.status,
          summary: recent.summary,
          result: rendered.text,
          error: recent.error,
          type: recent.type,
          durationMs: recent.durationMs,
          finishedAt: recent.finishedAt,
          pid: recent.pid,
          active: false,
          recent: true,
          maxChars,
          outputChars: rendered.text.length,
          originalOutputChars: rendered.originalChars,
          wasTruncated: rendered.wasTruncated,
        };
        if (recent.status === 'completed') {
          return this.makeResult(
            `Task "${taskId}" completed.\nSummary: ${recent.summary}\nResult: ${rendered.text}`,
            { structured },
          );
        }
        return this.makeError(
          `Task "${taskId}" ${recent.status}.\nSummary: ${recent.summary}\nResult: ${rendered.text}`,
          { structured },
        );
      }
      return this.makeError(
        `Task "${taskId}" not found in BackgroundTaskManager. It may have expired from the recent result cache. Use TaskList to see active and recent tasks.`,
        { structured: { taskId, status: 'not_found', type: 'background' } },
      );
    }

    const sessionManager = SessionManager.getInstance();
    const session = sessionManager.session(taskId);

    if (!session) {
      return this.makeError(
        `Task session '${taskId}' not found. Use TaskList to see all active tasks.`,
        { structured: { taskId, status: 'not_found', type: 'session' } },
      );
    }

    // If archived, task completed - return the full history
    if (session.isArchived()) {
      const history = await sessionManager.getHistory(taskId, true);
      if (history.length === 0) {
        return this.makeResult(
          `Task '${taskId}' is archived but has no message history.`,
          {
            structured: {
              taskId,
              status: 'completed',
              agentId: session.agentId,
              messageCount: 0,
              outputMessageCount: 0,
              includeHistory,
              includeToolMessages,
              tailMessages,
              maxChars,
              wasTruncated: false,
            },
          },
        );
      }

      // Extract assistant messages (the task output)
      const outputMessages = history.filter(
        (m) => isTaskOutputMessage(m, includeToolMessages),
      );
      const selectedMessages = outputMessages.slice(-tailMessages);
      const omittedMessages = Math.max(0, outputMessages.length - selectedMessages.length);
      const rawOutput = includeHistory
        ? selectedMessages
          .map((m) => formatOutputMessage(m, includeToolMessages))
          .filter((text) => text.length > 0)
          .join('\n\n')
        : '';
      const rendered = truncateMiddle(rawOutput, maxChars);
      const outputSection = includeHistory
        ? `--- Output ---\n${rendered.text || '(no output content)'}`
        : '--- Output ---\n(omitted because include_history=false)';

      return this.makeResult(
        `Task '${taskId}' completed.\n` +
        `Agent: ${session.agentId}\n` +
        `Messages: ${history.length}\n\n` +
        outputSection,
        {
          structured: {
            taskId,
            status: 'completed',
            agentId: session.agentId,
            messageCount: history.length,
            outputMessageCount: outputMessages.length,
            returnedMessageCount: selectedMessages.length,
            omittedMessages,
            includeHistory,
            includeToolMessages,
            tailMessages,
            maxChars,
            outputChars: rendered.text.length,
            originalOutputChars: rendered.originalChars,
            wasTruncated: rendered.wasTruncated || omittedMessages > 0,
          },
        },
      );
    }

    // Still active - return current status
    const history = await sessionManager.getHistory(taskId);
    const lastMessage = history[history.length - 1];
    const lastMessageText = lastMessage
      ? `[${lastMessage.role}] ${lastMessage.content}`
      : '';
    const renderedLastMessage = includeHistory
      ? truncateMiddle(lastMessageText, Math.min(maxChars, 2000))
      : { text: '', originalChars: 0, wasTruncated: false };
    const lastMessageSection = includeHistory && lastMessage
      ? `\nLast message:\n${renderedLastMessage.text}\n`
      : '';

    return this.makeResult(
      `Task '${taskId}' is still in progress.\n` +
      `Status: ${session.status}\n` +
      `Agent: ${session.agentId}\n` +
      `Messages so far: ${history.length}\n` +
      `Last update: ${lastMessage?.timestamp ?? 'N/A'}\n\n` +
      lastMessageSection +
      'Check back later or use TaskList to monitor progress.',
      {
        structured: {
          taskId,
          status: session.status,
          agentId: session.agentId,
          messageCount: history.length,
          lastUpdate: lastMessage?.timestamp,
          lastMessageRole: lastMessage?.role,
          includeHistory,
          maxChars,
          outputChars: renderedLastMessage.text.length,
          originalOutputChars: renderedLastMessage.originalChars,
          wasTruncated: renderedLastMessage.wasTruncated,
        },
      },
    );
  }
}

function normalizeTaskOutputParams(
  params: Record<string, unknown>,
): Normalization<NormalizedTaskOutputParams> {
  const taskIdResult = normalizeTaskId(params);
  if (!taskIdResult.ok) return taskIdResult;

  const maxCharsResult = normalizeInteger(params.max_chars, 'max_chars', DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS);
  if (!maxCharsResult.ok) return maxCharsResult;

  const includeHistoryResult = normalizeBoolean(params.include_history, 'include_history', true);
  if (!includeHistoryResult.ok) return includeHistoryResult;

  const includeToolMessagesResult = normalizeBoolean(params.include_tool_messages, 'include_tool_messages', true);
  if (!includeToolMessagesResult.ok) return includeToolMessagesResult;

  const tailMessagesResult = normalizeInteger(params.tail_messages, 'tail_messages', DEFAULT_TAIL_MESSAGES, 1, MAX_TAIL_MESSAGES);
  if (!tailMessagesResult.ok) return tailMessagesResult;

  return {
    ok: true,
    value: {
      taskId: taskIdResult.value,
      maxChars: maxCharsResult.value,
      includeHistory: includeHistoryResult.value,
      includeToolMessages: includeToolMessagesResult.value,
      tailMessages: tailMessagesResult.value,
    },
  };
}

function isTaskOutputMessage(message: Message, includeToolMessages: boolean): boolean {
  if (message.role === 'assistant' && hasVisibleText(message.content)) {
    return true;
  }

  if (!includeToolMessages) return false;

  return message.role === 'tool'
    || Boolean(message.toolCalls?.length)
    || Boolean(message.toolResults?.length);
}

function formatOutputMessage(message: Message, includeToolMessages: boolean): string {
  const parts: string[] = [];

  if (hasVisibleText(message.content)) {
    parts.push(`[${message.role}] ${message.content}`);
  }

  if (includeToolMessages) {
    for (const call of message.toolCalls ?? []) {
      parts.push(`[tool_call] ${call.toolName} ${safeJson(call.params)}`);
      const result = (call as { result?: ToolResult }).result;
      if (result) {
        parts.push(`[tool_result] ${result.success ? 'ok' : 'error'} ${result.content}`);
      }
    }

    for (const result of message.toolResults ?? []) {
      parts.push(`[tool_result] ${result.success ? 'ok' : 'error'} ${result.content}`);
    }
  }

  return parts.join('\n');
}

function hasVisibleText(content: string): boolean {
  return content.trim().length > 0
    && content !== '(tool calls)'
    && content !== '(reasoning only)';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function normalizeTaskId(
  params: Record<string, unknown>,
): Normalization<string> {
  const taskId = normalizeOptionalString(params.taskId, 'taskId');
  if (!taskId.ok) return taskId;

  const taskIdAlias = normalizeOptionalString(params.task_id, 'task_id');
  if (!taskIdAlias.ok) return taskIdAlias;

  if (taskId.value && taskIdAlias.value && taskId.value !== taskIdAlias.value) {
    return { ok: false, error: 'taskId and task_id must refer to the same task when both are provided' };
  }

  const value = taskId.value ?? taskIdAlias.value;
  if (!value) return { ok: false, error: 'taskId is required' };
  return { ok: true, value };
}

function normalizeOptionalString(
  value: unknown,
  name: string,
): Normalization<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${name} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: `${name} is required` };
  return { ok: true, value: trimmed };
}

function normalizeInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): Normalization<number> {
  if (value === undefined || value === null) return { ok: true, value: defaultValue };
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: `${name} must be an integer` };
  if (value < min) return { ok: false, error: `${name} must be at least ${min}` };
  if (value > max) return { ok: false, error: `${name} must be ${max} or less` };
  return { ok: true, value };
}

function normalizeBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): Normalization<boolean> {
  if (value === undefined || value === null) return { ok: true, value: defaultValue };
  if (typeof value !== 'boolean') return { ok: false, error: `${name} must be a boolean` };
  return { ok: true, value };
}

function truncateMiddle(
  text: string,
  maxChars: number,
): { text: string; originalChars: number; wasTruncated: boolean } {
  if (text.length <= maxChars) {
    return { text, originalChars: text.length, wasTruncated: false };
  }

  let marker = '\n\n... [truncated] ...\n\n';
  let headChars = 0;
  let tailChars = 0;

  for (let i = 0; i < 3; i++) {
    const budget = Math.max(0, maxChars - marker.length);
    headChars = Math.ceil(budget / 2);
    tailChars = budget - headChars;
    const omitted = Math.max(0, text.length - headChars - tailChars);
    const preciseMarker = `\n\n... [${omitted} chars truncated] ...\n\n`;
    if (preciseMarker.length === marker.length) {
      marker = preciseMarker;
      break;
    }
    marker = preciseMarker;
  }

  if (marker.length > maxChars) {
    const fallback = '...';
    return {
      text: text.slice(0, Math.max(0, maxChars - fallback.length)) + fallback,
      originalChars: text.length,
      wasTruncated: true,
    };
  }

  return {
    text: `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ''}`,
    originalChars: text.length,
    wasTruncated: true,
  };
}
