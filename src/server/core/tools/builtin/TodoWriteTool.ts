// TodoWriteTool — writes and manages a structured task list
// The agent uses this to track progress on complex multi-step tasks.
// All todos are merged/replaced on each call (not appended).
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export class TodoWriteTool extends Tool {
  static category = 'Planning & Communication';
  static toolDescription = 'Creates and manages a structured task list for tracking progress.';

  name(): string {
    return 'TodoWrite';
  }

  description(): string {
    return 'Create and manage a structured task list for multi-step work. Tracks progress with pending/in_progress/completed states.';
  }

  prompt(): string {
    return '## TodoWrite Usage\n' +
      '### When to Use\n' +
      '- 3+ distinct steps required\n' +
      '- Non-trivial multi-step task\n' +
      '- User provides multiple tasks\n\n' +
      '### When NOT to Use\n' +
      '- Single trivial task — just do it directly\n' +
      '- Informational questions (no coding work)\n' +
      '- Tasks completable in <3 trivial steps\n\n' +
      '### Rules\n' +
      '- Exactly ONE task in_progress at a time\n' +
      '- Mark complete IMMEDIATELY after finishing — do not batch\n' +
      '- Remove tasks that are no longer relevant from the list';
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
                description: 'The task description in imperative form (e.g. "Add dark mode toggle")',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current status of the task',
              },
              activeForm: {
                type: 'string',
                description: 'Present continuous form for displaying during execution (e.g. "Adding dark mode toggle")',
              },
            },
            required: ['content', 'status', 'activeForm'],
          },
          description: 'The complete todo list (replaces any previous list)',
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

  // No UI display — todo list is rendered by TodoWriteDelegate via AppState
  userFacingName(_input?: Record<string, unknown>): string { return ''; }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const todos = params.todos as TodoItem[] | undefined;

    if (!todos || !Array.isArray(todos)) {
      return this.makeError('todos array is required');
    }

    // Validate todos
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      if (!t.content || typeof t.content !== 'string') {
        return this.makeError(`Todo ${i + 1}: "content" is required`);
      }
      if (!t.status || !['pending', 'in_progress', 'completed'].includes(t.status)) {
        return this.makeError(
          `Todo ${i + 1}: "status" must be one of: pending, in_progress, completed`
        );
      }
      if (!t.activeForm || typeof t.activeForm !== 'string') {
        return this.makeError(`Todo ${i + 1}: "activeForm" is required`);
      }
    }

    // Check for multiple in_progress items
    const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      return this.makeError(
        `${inProgressCount} tasks are "in_progress". Only ONE task should be in_progress at a time.`
      );
    }

    // Compute summary
    const summary = {
      total: todos.length,
      pending: todos.filter((t) => t.status === 'pending').length,
      in_progress: inProgressCount,
      completed: todos.filter((t) => t.status === 'completed').length,
    };

    // Format display
    const lines: string[] = [];
    lines.push(`## Todo List (${summary.total} tasks)`);
    lines.push(
      `Status: ${summary.pending} pending, ${summary.in_progress} in progress, ${summary.completed} completed`
    );
    lines.push('');

    for (const t of todos) {
      const icon =
        t.status === 'completed' ? '[x]' :
        t.status === 'in_progress' ? '[>]' :
        '[ ]';
      lines.push(`${icon} ${t.content}`);
    }

    // TODO: persist to TodoWrite store / emit event for UI sync
    // For now, return the formatted list

    return this.makeResult(lines.join('\n'), {
      structured: { summary, todos },
    });
  }
}
