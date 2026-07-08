// TaskAssignTool - delegate a task to a subordinate agent
// Creates a sub-session for the subordinate and runs their AgentLoop
// with the task as a user message. Returns the sub-session ID.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { createLogger } from '../../logger.js';

const MAX_TARGET_AGENT_ID_CHARS = 200;
const MAX_TASK_CHARS = 20000;
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export class TaskAssignTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Delegates a distinct tracked task to a subordinate agent and returns immediately.';
  name(): string {
    return 'TaskAssign';
  }

  description(): string {
    return 'Assign a distinct tracked task to a subordinate agent. The child works in its persistent session and the system sends a task notification on completion or failure.';
  }

  prompt(): string {
    return [
      '## TaskAssign Usage',
      'Use TaskAssign for a separate unit of durable work that needs ownership, tracking, and a completion notification.',
      '',
      'TaskAssign is not a chat message. It creates or queues formal work in the subordinate persistent session.',
      '',
      'Every task must include:',
      '- Goal and reason the work matters.',
      '- Scope: files, systems, data, or constraints to inspect or change.',
      '- Acceptance criteria and required verification.',
      '- Priority and expected report format.',
      '',
      'Use AgentMessage instead when you need to clarify, amend, interrupt, or review a task that is already running.',
      'After assigning, do not duplicate the same work yourself unless the task fails or the user changes direction.',
    ].join('\n');
  }

  minRole(): string { return 'Manager'; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        targetAgentId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_TARGET_AGENT_ID_CHARS,
          pattern: '\\S',
          description: 'ID of the subordinate agent to delegate the task to',
        },
        task: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_TASK_CHARS,
          pattern: '\\S',
          description: 'The task description and instructions for the subordinate',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Task priority. Default: "normal".',
        },
      },
      required: ['targetAgentId', 'task'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Medium;
  }

  isAsync(): boolean {
    return true; // Non-blocking - delegateTask now returns immediately
  }

  defaultTimeoutMs(): number {
    return 30000; // The dispatch itself is fast; delegateTask returns in ~100ms
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const targetResult = normalizeString(params.targetAgentId, 'targetAgentId', MAX_TARGET_AGENT_ID_CHARS);
    if (targetResult.error) return this.makeError(targetResult.error);
    const targetAgentId = targetResult.value!;

    const taskResult = normalizeString(params.task, 'task', MAX_TASK_CHARS);
    if (taskResult.error) return this.makeError(taskResult.error);
    const task = taskResult.value!;

    const priorityResult = normalizeEnum(params.priority, 'priority', TASK_PRIORITIES, 'normal');
    if (priorityResult.error) return this.makeError(priorityResult.error);
    const priority = priorityResult.value!;

    const logger = createLogger('anochat.tools');
    logger.debug('TaskAssign executed', { targetAgentId, taskPreview: task.slice(0, 60), sid: ctx.sessionId, aid: ctx.agentId });

    // ── Validate subordinate relationship ──
    // Task can only be delegated down the org tree.
    const registry = AgentRegistry.getInstance();
    const target = registry.findAgent(targetAgentId);
    if (!target) {
      return this.makeError(`Target agent '${targetAgentId}' not found in registry`);
    }
    if (target.parentAgentId !== ctx.agentId) {
      logger.warn('TaskAssign validation failed - not a subordinate', { targetAgentId, callerAid: ctx.agentId });
      return this.makeError(
        `Cannot assign task to '${targetAgentId}': ` +
        'tasks can only be assigned to direct subordinates (immediate children).',
      );
    }

    const runtime = AgentRuntime.getInstance();

    // Delegate task (non-blocking - returns immediately after dispatching)
    const result = await runtime.delegateTask(targetAgentId, task, ctx.sessionId, ctx.agentId, priority);

    if (!result.success) {
      return result;
    }

    return this.makeResult(
      `Task dispatched to '${targetAgentId}'.\n` +
      `Priority: ${priority}\n` +
      `${result.content}\n\n` +
      'The system will notify you when the task completes.',
      {
        structured: {
          ...(isRecord(result.structured) ? result.structured : {}),
          targetAgentId,
          parentSessionId: ctx.sessionId,
          parentAgentId: ctx.agentId,
          priority,
          taskPreview: task.slice(0, 120),
        },
      },
    );
  }
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  if (trimmed.length > maxLength) {
    return { error: `${field} must be ${maxLength} characters or less` };
  }
  return { value: trimmed };
}

function normalizeEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  fallback: T[number],
): { value: T[number]; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { value: fallback };
  if (!allowed.includes(trimmed)) return { error: `${field} must be one of: ${allowed.join(', ')}` };
  return { value: trimmed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
