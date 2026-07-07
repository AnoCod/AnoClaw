// TodoWriteTool - writes and manages a structured task list
// The agent uses this to track progress on complex multi-step tasks.
// All todos are merged/replaced on each call (not appended).
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';

const MAX_TODOS = 50;
const MAX_CONTENT_CHARS = 300;
const MAX_ACTIVE_FORM_CHARS = 160;
const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export class TodoWriteTool extends Tool {
  static category = 'Planning & Communication';
  static toolDescription = 'Maintains a concise progress checklist for multi-step work.';

  name(): string {
    return 'TodoWrite';
  }

  description(): string {
    return 'Create or update a structured task list for multi-step work. Use pending, in_progress, and completed states.';
  }

  prompt(): string {
    return [
      '## TodoWrite Usage',
      'Use TodoWrite for visible progress on multi-step work, especially when coordinating implementation, verification, and delegation.',
      '',
      'Rules:',
      '- Keep tasks concrete and outcome-oriented.',
      '- Exactly one task may be in_progress at a time.',
      '- Mark each task completed immediately after it is actually done.',
      '- Remove or rewrite tasks that no longer match the plan.',
      '',
      'Do not use TodoWrite for a single trivial action or pure Q&A.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: `The task description in imperative form (e.g. "Add dark mode toggle"). Max ${MAX_CONTENT_CHARS} chars.`,
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current status of the task',
              },
              activeForm: {
                type: 'string',
                description: `Present continuous form for displaying during execution (e.g. "Adding dark mode toggle"). Max ${MAX_ACTIVE_FORM_CHARS} chars.`,
              },
            },
            required: ['content', 'status', 'activeForm'],
          },
          description: `The complete todo list (replaces any previous list). Max ${MAX_TODOS} items. Empty array clears the visible list.`,
        },
      },
      required: ['todos'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isReadOnly(): boolean {
    return false; // Modifies todo state
  }

  shouldDefer(): boolean {
    return true; // Does not consume a model turn
  }

  // No UI display - todo list is rendered by TodoWriteDelegate via AppState
  userFacingName(_input?: Record<string, unknown>): string { return ''; }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const todos = params.todos as unknown[] | undefined;

    if (!todos || !Array.isArray(todos)) {
      return this.makeError('todos array is required', { startedAt });
    }
    if (todos.length > MAX_TODOS) {
      return this.makeError(`todos must contain ${MAX_TODOS} items or fewer`, { startedAt });
    }

    const normalizedTodos: TodoItem[] = [];
    const seenContent = new Set<string>();

    for (let i = 0; i < todos.length; i++) {
      const raw = todos[i];
      if (!isRecord(raw)) {
        return this.makeError(`Todo ${i + 1}: must be an object`, { startedAt });
      }

      const contentResult = normalizeText(raw.content, 'content', MAX_CONTENT_CHARS);
      if (contentResult.error) {
        return this.makeError(`Todo ${i + 1}: ${contentResult.error}`, { startedAt });
      }

      if (typeof raw.status !== 'string' || !VALID_STATUSES.has(raw.status)) {
        return this.makeError(
          `Todo ${i + 1}: "status" must be one of: pending, in_progress, completed`,
          { startedAt },
        );
      }

      const activeFormResult = normalizeText(raw.activeForm, 'activeForm', MAX_ACTIVE_FORM_CHARS);
      if (activeFormResult.error) {
        return this.makeError(`Todo ${i + 1}: ${activeFormResult.error}`, { startedAt });
      }

      const dedupeKey = contentResult.value!.toLowerCase();
      if (seenContent.has(dedupeKey)) {
        return this.makeError(`Todo ${i + 1}: duplicate content "${contentResult.value}"`, { startedAt });
      }
      seenContent.add(dedupeKey);

      normalizedTodos.push({
        content: contentResult.value!,
        status: raw.status as TodoItem['status'],
        activeForm: activeFormResult.value!,
      });
    }

    // Check for multiple in_progress items
    const inProgressCount = normalizedTodos.filter((t) => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      return this.makeError(
        `${inProgressCount} tasks are "in_progress". Only ONE task should be in_progress at a time.`,
        { startedAt },
      );
    }

    // Compute summary
    const summary = {
      total: normalizedTodos.length,
      pending: normalizedTodos.filter((t) => t.status === 'pending').length,
      in_progress: inProgressCount,
      completed: normalizedTodos.filter((t) => t.status === 'completed').length,
      activeTask: normalizedTodos.find((t) => t.status === 'in_progress')?.content ?? null,
      completionRatio: normalizedTodos.length === 0
        ? 1
        : normalizedTodos.filter((t) => t.status === 'completed').length / normalizedTodos.length,
    };

    // Format display
    const lines: string[] = [];
    lines.push(`## Todo List (${summary.total} tasks)`);
    lines.push(
      `Status: ${summary.pending} pending, ${summary.in_progress} in progress, ${summary.completed} completed`
    );
    lines.push('');

    if (normalizedTodos.length === 0) {
      lines.push('(Todo list cleared)');
    }

    for (const t of normalizedTodos) {
      const icon =
        t.status === 'completed' ? '[x]' :
        t.status === 'in_progress' ? '[>]' :
        '[ ]';
      lines.push(`${icon} ${t.content}`);
    }

    // Emit event for UI sync and downstream consumers (surrogate store, activity log, etc.)
    TypedEventBus.emit('todo:updated', {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      summary,
      todos: normalizedTodos,
    });

    return this.makeResult(lines.join('\n'), {
      startedAt,
      structured: { summary, todos: normalizedTodos },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(
  value: unknown,
  field: string,
  maxLength: number,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `"${field}" is required` };
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return { error: `"${field}" must not be empty` };
  if (normalized.length > maxLength) return { error: `"${field}" must be ${maxLength} characters or fewer` };
  return { value: normalized };
}
