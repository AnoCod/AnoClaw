import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type { Message } from '../../../../shared/types/session.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  booleanParam,
  integerParam,
  rootSessionIdFor,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { SessionManager } from '../../session/SessionManager.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';

export class TaskOutputTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Reads durable task status and transcript-backed output.';
  name(): string { return 'TaskOutput'; }
  description(): string { return 'Read a task result after notification, optionally waiting for one terminal event.'; }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        wait: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
        maxChars: { type: 'integer', minimum: 200, maximum: 50000 },
      },
      required: ['taskId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const taskId = stringParam(params.taskId, 'taskId', 200)!;
      const service = CoordinationService.getInstance();
      let task = service.getTask(rootSessionId, taskId);
      if (!task) return this.makeError(`Task not found: ${taskId}`);
      if (booleanParam(params.wait, false) && !isTerminal(task.status)) {
        await waitForTask(rootSessionId, taskId, integerParam(params.timeoutMs, 'timeoutMs', { optional: true, min: 100, max: 60_000 }) || 30_000);
        task = service.getTask(rootSessionId, taskId) || task;
      }
      const maxChars = integerParam(params.maxChars, 'maxChars', { optional: true, min: 200, max: 50_000 }) || 4_000;
      let transcript = '';
      if (task.sessionId) {
        const history = await SessionManager.getInstance().getHistory(task.sessionId).catch(() => [] as Message[]);
        const startedAt = task.startedAt ? Date.parse(task.startedAt) : Number.NEGATIVE_INFINITY;
        const completedAt = task.completedAt ? Date.parse(task.completedAt) : Number.POSITIVE_INFINITY;
        transcript = history
          .filter((message) => {
            const timestamp = Date.parse(message.timestamp);
            return timestamp >= startedAt && timestamp <= completedAt;
          })
          .filter((message) => message.role === 'assistant' || message.role === 'tool')
          .slice(-50)
          .map((message) => `[${message.role}] ${message.content}`)
          .join('\n');
      }
      const rendered = truncateMiddle(transcript || task.resultSummary || task.error || '(no output yet)', maxChars);
      return this.makeResult(
        `${task.id} is ${task.status}.\nSummary: ${task.resultSummary || task.subject}\nOutput: ${rendered}`,
        { structured: { task, output: rendered } },
      );
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function waitForTask(rootSessionId: string, taskId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = TypedEventBus.on('coordination:task_changed', (payload) => {
      if (payload.rootSessionId === rootSessionId && payload.task.id === taskId && isTerminal(payload.task.status)) done();
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const side = Math.floor((max - 40) / 2);
  return `${value.slice(0, side)}\n...[truncated ${value.length - side * 2} chars]...\n${value.slice(-side)}`;
}
