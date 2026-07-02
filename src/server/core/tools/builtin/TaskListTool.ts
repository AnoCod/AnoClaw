// TaskListTool — list all delegated tasks and their status
// Returns the current tasks with elapsed time, current tool, and heartbeat status.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { SupervisionManager } from '../../agent/supervision/SupervisionManager.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

export class TaskListTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Lists all pending and completed tasks with detailed status.';
  name(): string {
    return 'TaskList';
  }

  description(): string {
    return 'List all delegated tasks and their status. Shows active tasks with elapsed time, current tool, and heartbeat status. Use to track progress of work delegated to subordinates.';
  }

  prompt(): string {
    return '## TaskList Usage\n' +
      'Check the status of your delegated tasks. Shows which tasks are running, completed, or stuck.\n\n' +
      '**When to check:**\n' +
      '- Once per major conversational turn if you have no other pending work.\n' +
      '- If a subordinate seems stuck (no progress after 3+ of your turns).\n' +
      '- Before reporting status to the user.\n\n' +
      '**When NOT to check:**\n' +
      '- Right after delegating — subordinates need time to produce results.\n' +
      '- Repeatedly in the same turn — frequent polling wastes tokens.\n' +
      '- When you have other work to do — keep working, the notification will arrive.\n\n' +
      'The system prompt already shows your active background tasks. TaskList gives you more detail.\n' +
      'Trust the notification system. You do NOT need to babysit your subordinates.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  async execute(
    _params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const { SessionManager } = await import('../../session/SessionManager.js');
    const sessionManager = SessionManager.getInstance();
    const sup = SupervisionManager.getInstance();

    // Find sub-sessions that are children of the current session
    const subSessions = sessionManager.subsessionsOf(ctx.sessionId);

    if (subSessions.length === 0) {
      return this.makeResult(
        'No delegated tasks found. No active sub-sessions exist for this session.\n\n' +
        'Use TaskAssign to delegate tasks to subordinate agents.',
      );
    }

    const now = Date.now();
    const lines: string[] = [`${subSessions.length} delegated task(s):\n`];

    for (const sub of subSessions) {
      const status = sub.status;
      const statusIcon =
        status === 'Active' ? '●' :
        status === 'Idle' ? '◐' :
        status === 'Archived' ? '✓' : '?';

      // Compute elapsed time
      const createdAt = sub.createdAt ? new Date(sub.createdAt).getTime() : now;
      const lastActiveAt = sub.lastActiveAt ? new Date(sub.lastActiveAt).getTime() : createdAt;
      const elapsedSec = Math.round((now - createdAt) / 1000);
      const elapsedStr = elapsedSec > 60
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${elapsedSec}s`;

      // Query supervision data
      const currentTool = sup.getCurrentTool(sub.id);
      const isUnresponsive = sup.isUnresponsive(sub.id);
      const secondsSinceHb = sup.secondsSinceLastHeartbeat(sub.id);

      let infoLine = `${statusIcon} [${status}] ${sub.title || '(untitled)'}`;
      infoLine += `  |  Agent: ${sub.agentId}`;
      infoLine += `  |  Elapsed: ${elapsedStr}`;
      if (status === 'Active' && currentTool) {
        infoLine += `  |  Tool: ${currentTool}`;
      }
      if (status === 'Active' && isUnresponsive) {
        infoLine += `  |  ⚠ Unresponsive (${Math.round(secondsSinceHb)}s since heartbeat)`;
      }

      lines.push(infoLine);
    }

    // Also report on background tasks from BackgroundTaskManager
    const bgManager = BackgroundTaskManager.getInstance();
    const bgTasks = bgManager.getTasksForParent(ctx.sessionId);

    if (bgTasks.length > 0) {
      lines.push(`\n${bgTasks.length} background task(s) — dispatched, not yet completed:`);
      for (const task of bgTasks) {
        const elapsedSec = Math.round((Date.now() - task.startedAt) / 1000);
        const elapsedStr = elapsedSec > 60
          ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
          : `${elapsedSec}s`;
        let taskLine = `  ● [running] ${task.summary}`;
        taskLine += `  |  Agent: ${task.parentAgentId}`;
        taskLine += `  |  Turn: ${task.turnCount}`;
        taskLine += `  |  Elapsed: ${elapsedStr}`;
        if (task.currentTool) {
          taskLine += `  |  Tool: ${task.currentTool}`;
        }
        lines.push(taskLine);
      }
    }

    // Also report on active AgentLoop sessions
    const runtime = AgentRuntime.getInstance();
    const activeSessionCount = runtime.activeSessionCount;
    if (activeSessionCount > 0) {
      lines.push(`\nActive AgentLoops running: ${activeSessionCount}`);
    }

    return this.makeResult(lines.join('\n'));
  }
}
