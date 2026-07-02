// ActiveTaskSection — injects running background tasks into the prompt
// so agents never forget what they've delegated. Based on Claude Code's
// task_reminder / task_status attachment pattern.

import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { SessionManager } from '../../session/index.js';

export const sectionMeta = {
  name: 'activetasks',
  type: 'dynamic' as const,
  priority: 84, // right before OrgContext (80) + SessionGuidance (90)
};
export function createActiveTaskSection(): SystemPromptSection {
  return {
    name: 'ActiveTasks',
    cacheBreak: true, // recompute every turn — tasks change frequently
    compute: (ctx: PromptContext) => {
      const sm = SessionManager.getInstance();
      const bgm = BackgroundTaskManager.getInstance();

      // Collect tasks for THIS session and its direct sub-sessions
      const myTasks = bgm.getTasksForParent(ctx.sessionId);
      const subs = sm.subsessionsOf(ctx.sessionId);
      for (const sub of subs) {
        const subTasks = bgm.getTasksForParent(sub.id);
        for (const t of subTasks) {
          if (!myTasks.find(mt => mt.id === t.id)) myTasks.push(t);
        }
      }

      const running = myTasks.filter(t => t.status === 'running');
      if (running.length === 0) return '';

      const lines: string[] = [];
      lines.push('# Active Background Tasks');
      lines.push('');
      lines.push(`You have **${running.length} active background task(s)**. You will be automatically notified when each completes.`);
      lines.push('');

      for (const task of running) {
        const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
        const elapsedStr = elapsed > 60
          ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
          : `${elapsed}s`;
        const agent = task.parentAgentId || '(unknown)';
        const turn = task.turnCount ?? 0;
        const tool = task.currentTool ? ` | Tool: ${task.currentTool}` : '';
        lines.push(`- \`${task.id}\` [${task.status}] Agent: ${agent} | ${elapsedStr} | Turn ${turn}${tool}`);
        lines.push(`  Summary: ${task.summary.slice(0, 120)}`);
      }

      lines.push('');
      lines.push('**Rules for active tasks:**');
      lines.push('- Do NOT re-delegate the same work while a task is running — you will get a notification when it finishes');
      lines.push('- If you need to add requirements, use AgentMessage — do NOT create a second TaskAssign');
      lines.push('- Check progress with TaskList only if a task seems stuck (no progress after 3+ of your turns)');
      lines.push('- Trust the notification system. You do not need to poll.');

      return lines.join('\n');
    },
  };
}
