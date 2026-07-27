import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { SessionManager } from '../../session/index.js';

export const sectionMeta = {
  name: 'activetasks',
  type: 'dynamic' as const,
  priority: 84,
};

export function createActiveTaskSection(): SystemPromptSection {
  return {
    name: 'ActiveTasks',
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const sm = SessionManager.getInstance();
      const bgm = BackgroundTaskManager.getInstance();
      const coordination = CoordinationService.getInstance();
      const rootSessionId = (() => {
        try { return sm.getRootSession(ctx.sessionId).id; } catch { return ctx.sessionId; }
      })();
      const coordinated = coordination.isInitialized()
        ? coordination.listTasks(rootSessionId).filter((task) =>
          task.creatorAgentId === ctx.agentId
          && !['completed', 'failed', 'cancelled'].includes(task.status))
        : [];
      const myTasks = bgm.getTasksForParent(ctx.sessionId);
      const subs = sm.subsessionsOf(ctx.sessionId);

      for (const sub of subs) {
        for (const task of bgm.getTasksForParent(sub.id)) {
          if (!myTasks.find(existing => existing.id === task.id)) myTasks.push(task);
        }
      }

      const running = myTasks.filter(t => t.status === 'running');
      if (running.length === 0 && coordinated.length === 0) return '';

      const lines: string[] = [
        '# Active Coordination Tasks and Process Jobs',
        '',
        `Durable coordination tasks: ${coordinated.length}; running process jobs: ${running.length}.`,
        '',
      ];

      for (const task of coordinated) {
        lines.push(`- ${task.id} [${task.status}] ${task.subject} | assignee: ${task.assigneeAgentId || 'unassigned'} | progress: ${task.progress ?? 0}%`);
      }
      for (const task of running) {
        const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
        const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
        const tool = task.currentTool ? ` | Tool: ${task.currentTool}` : '';
        lines.push(`- ${task.id} [${task.status}] Agent: ${task.parentAgentId || 'unknown'} | ${elapsedStr} | Turn ${task.turnCount ?? 0}${tool}`);
        lines.push(`  Summary: ${task.summary.slice(0, 140)}`);
      }

      lines.push(
        '',
        'Active task rules:',
        '- Do not duplicate equivalent running work.',
        '- Use AgentMessage to amend or clarify an active child task.',
        '- Use Task action="create" with targetAgentId for separate delegated work.',
        '- Use Task action="list" or action="output" when coordinating many tasks or when progress appears stuck.',
        '- JobList/JobOutput/JobStop manage only Bash and RunProgram background processes.',
      );

      return lines.join('\n');
    },
  };
}
