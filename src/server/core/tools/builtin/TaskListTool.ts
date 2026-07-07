// TaskListTool - list all delegated tasks and their status
// Returns the current tasks with elapsed time, current tool, and heartbeat status.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRuntime } from '../../agent/AgentRuntime.js';
import { SupervisionManager } from '../../agent/supervision/SupervisionManager.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

export class TaskListTool extends Tool {

  static category = 'Task Delegation';
  static toolDescription = 'Lists delegated and background tasks for oversight without repeated polling.';
  name(): string {
    return 'TaskList';
  }

  description(): string {
    return 'List delegated and background tasks with status, elapsed time, current tool, and heartbeat details. Use for oversight, not constant polling.';
  }

  prompt(): string {
    return [
      '## TaskList Usage',
      'Use TaskList to inspect delegated work when coordinating multiple tasks, preparing a status report, or investigating a stuck task.',
      '',
      'Do not call it immediately after every delegation. Task notifications will arrive automatically.',
      'Prefer one check at natural milestones, after several turns, or when active task context suggests a problem.',
    ].join('\n');
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

  isReadOnly(): boolean {
    return true;
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

    const now = Date.now();
    const lines: string[] = [];
    const structuredSubSessions: Array<Record<string, unknown>> = [];

    if (subSessions.length > 0) {
      lines.push(`${subSessions.length} delegated task(s):\n`);
    }

    for (const sub of subSessions) {
      const status = sub.status;
      const statusIcon =
        status === 'Active' ? '[active]' :
        status === 'Idle' ? '[idle]' :
        status === 'Archived' ? '[done]' : '?';

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
        infoLine += `  |  Warning: Unresponsive (${Math.round(secondsSinceHb)}s since heartbeat)`;
      }

      lines.push(infoLine);
      structuredSubSessions.push({
        id: sub.id,
        title: sub.title,
        status,
        agentId: sub.agentId,
        elapsedSec,
        currentTool,
        isUnresponsive,
        secondsSinceHeartbeat: secondsSinceHb,
      });
    }

    // Also report on background tasks from BackgroundTaskManager
    const bgManager = BackgroundTaskManager.getInstance();
    const bgTasks = bgManager.getTasksForParent(ctx.sessionId);
    const recentBgTasks = bgManager.getRecentTaskResultsForParent(ctx.sessionId);
    const structuredBgTasks: Array<Record<string, unknown>> = [];
    const structuredRecentTasks: Array<Record<string, unknown>> = [];

    if (bgTasks.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`${bgTasks.length} background task(s) dispatched, not yet completed:`);
      for (const task of bgTasks) {
        const elapsedSec = Math.round((Date.now() - task.startedAt) / 1000);
        const elapsedStr = elapsedSec > 60
          ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
          : `${elapsedSec}s`;
        let taskLine = `  [active] [running] ${task.summary}`;
        taskLine += `  |  Agent: ${task.parentAgentId}`;
        taskLine += `  |  Turn: ${task.turnCount}`;
        taskLine += `  |  Elapsed: ${elapsedStr}`;
        if (task.currentTool) {
          taskLine += `  |  Tool: ${task.currentTool}`;
        }
        lines.push(taskLine);
        structuredBgTasks.push({
          id: task.id,
          type: task.type,
          status: task.status,
          summary: task.summary,
          parentAgentId: task.parentAgentId,
          turnCount: task.turnCount,
          elapsedSec,
          currentTool: task.currentTool,
          pid: task.pid,
          command: task.command,
        });
      }
    }

    if (recentBgTasks.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`${recentBgTasks.length} recent background task result(s):`);
      for (const task of recentBgTasks) {
        const ageSec = Math.round((now - task.finishedAt) / 1000);
        const ageStr = ageSec > 60
          ? `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`
          : `${ageSec}s ago`;
        const statusIcon =
          task.status === 'completed' ? '[done]' :
          task.status === 'failed' ? '[failed]' :
          '[killed]';
        let taskLine = `  ${statusIcon} [${task.status}] ${task.summary}`;
        taskLine += `  |  Task: ${task.id}`;
        taskLine += `  |  Agent: ${task.parentAgentId}`;
        taskLine += `  |  Finished: ${ageStr}`;
        if (task.durationMs !== undefined) {
          taskLine += `  |  Duration: ${Math.round(task.durationMs / 1000)}s`;
        }
        lines.push(taskLine);
        structuredRecentTasks.push({
          id: task.id,
          type: task.type,
          status: task.status,
          summary: task.summary,
          parentAgentId: task.parentAgentId,
          finishedAt: task.finishedAt,
          durationMs: task.durationMs,
          pid: task.pid,
          command: task.command,
          hasContent: Boolean(task.content),
          hasError: Boolean(task.error),
        });
      }
    }

    // Also report on active AgentLoop sessions
    const runtime = AgentRuntime.getInstance();
    const activeSessionCount = runtime.activeSessionCount;
    if (activeSessionCount > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`Active AgentLoops running: ${activeSessionCount}`);
    }

    if (lines.length === 0) {
      lines.push(
        'No delegated or background tasks found for this session.\n\n' +
        'Use TaskAssign to delegate work to subordinate agents, or Bash with run_in_background for long-running commands.',
      );
    }

    return this.makeResult(lines.join('\n'), {
      structured: {
        sessionId: ctx.sessionId,
        delegatedTasks: structuredSubSessions,
        backgroundTasks: structuredBgTasks,
        recentBackgroundTasks: structuredRecentTasks,
        activeAgentLoops: activeSessionCount,
      },
    });
  }
}
