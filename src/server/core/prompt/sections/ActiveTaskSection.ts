import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
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
      const myTasks = bgm.getTasksForParent(ctx.sessionId);
      const subs = sm.subsessionsOf(ctx.sessionId);

      for (const sub of subs) {
        for (const task of bgm.getTasksForParent(sub.id)) {
          if (!myTasks.find(existing => existing.id === task.id)) myTasks.push(task);
        }
      }

      const running = myTasks.filter(t => t.status === 'running');
      if (running.length === 0) return '';

      const lines: string[] = [
        '# Active Background Tasks',
        '',
        `Running tasks: ${running.length}. You will receive an automatic notification when each task completes or fails.`,
        '',
      ];

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
        '- Use TaskAssign only for a separate new task with distinct acceptance criteria.',
        '- Use TaskList or TaskOutput when coordinating many tasks or when progress appears stuck.',
      );

      return lines.join('\n');
    },
  };
}
