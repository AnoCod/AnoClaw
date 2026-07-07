// TaskStopTool - stop a running delegated task
// Uses InterruptController to abort the target session's AgentLoop.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { InterruptController, InterruptReason } from '../../agent/supervision/InterruptController.js';

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
          description: 'The sub-session ID of the delegated task to stop',
        },
      },
      required: ['taskId'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const taskId = params.taskId as string;

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
}
