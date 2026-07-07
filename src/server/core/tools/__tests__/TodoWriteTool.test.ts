import { describe, expect, it } from 'vitest';
import { TodoWriteTool } from '../builtin/TodoWriteTool.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'todo-session',
  agentId: 'todo-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('TodoWriteTool', () => {
  it('normalizes todos, computes summary metadata, and emits normalized events', async () => {
    const events: unknown[] = [];
    const unsubscribe = TypedEventBus.on('todo:updated', (payload) => events.push(payload));

    try {
      const result = await new TodoWriteTool().execute({
        todos: [
          {
            content: '  Inspect   tool state  ',
            status: 'completed',
            activeForm: '  Inspecting   tool state ',
          },
          {
            content: 'Add focused tests',
            status: 'in_progress',
            activeForm: ' Adding   focused tests ',
          },
          {
            content: 'Run verification',
            status: 'pending',
            activeForm: 'Running verification',
          },
        ],
      }, ctx);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Status: 1 pending, 1 in progress, 1 completed');
      expect(result.structured).toMatchObject({
        summary: {
          total: 3,
          pending: 1,
          in_progress: 1,
          completed: 1,
          activeTask: 'Add focused tests',
          completionRatio: 1 / 3,
        },
        todos: [
          {
            content: 'Inspect tool state',
            status: 'completed',
            activeForm: 'Inspecting tool state',
          },
          {
            content: 'Add focused tests',
            status: 'in_progress',
            activeForm: 'Adding focused tests',
          },
          {
            content: 'Run verification',
            status: 'pending',
            activeForm: 'Running verification',
          },
        ],
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        summary: {
          total: 3,
          activeTask: 'Add focused tests',
        },
        todos: [
          expect.objectContaining({ content: 'Inspect tool state' }),
          expect.objectContaining({ activeForm: 'Adding focused tests' }),
          expect.objectContaining({ content: 'Run verification' }),
        ],
      });
    } finally {
      unsubscribe();
    }
  });

  it('supports clearing the visible todo list with an empty array', async () => {
    const result = await new TodoWriteTool().execute({ todos: [] }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('(Todo list cleared)');
    expect(result.structured).toMatchObject({
      summary: {
        total: 0,
        pending: 0,
        in_progress: 0,
        completed: 0,
        activeTask: null,
        completionRatio: 1,
      },
      todos: [],
    });
  });

  it('rejects multiple in-progress todos', async () => {
    const result = await new TodoWriteTool().execute({
      todos: [
        { content: 'First task', status: 'in_progress', activeForm: 'Doing first task' },
        { content: 'Second task', status: 'in_progress', activeForm: 'Doing second task' },
      ],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('2 tasks are "in_progress". Only ONE task should be in_progress at a time.');
  });

  it('rejects duplicate task content after trimming and case-folding', async () => {
    const result = await new TodoWriteTool().execute({
      todos: [
        { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
        { content: '  write   tests ', status: 'completed', activeForm: 'Wrote tests' },
      ],
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('Todo 2: duplicate content "write tests"');
  });

  it('rejects oversized todo lists and invalid item shapes', async () => {
    const tooMany = await new TodoWriteTool().execute({
      todos: Array.from({ length: 51 }, (_, i) => ({
        content: `Task ${i}`,
        status: 'pending',
        activeForm: `Doing task ${i}`,
      })),
    }, ctx);

    expect(tooMany.success).toBe(false);
    expect(tooMany.errorMessage).toBe('todos must contain 50 items or fewer');

    const invalidShape = await new TodoWriteTool().execute({
      todos: ['not an object'],
    }, ctx);

    expect(invalidShape.success).toBe(false);
    expect(invalidShape.errorMessage).toBe('Todo 1: must be an object');
  });
});
