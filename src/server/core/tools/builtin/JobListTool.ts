import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

export class JobListTool extends Tool {
  static category = 'Background Jobs';
  static toolDescription = 'Lists non-agent background process jobs.';
  name(): string { return 'JobList'; }
  description(): string { return 'List Bash, RunProgram, and other non-agent background jobs for the current session.'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [], additionalProperties: false };
  }
  async execute(_params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const manager = BackgroundTaskManager.getInstance();
    const active = manager.getTasksForParent(ctx.sessionId).filter((job) => job.type !== 'subagent');
    const recent = manager.getRecentTaskResultsForParent(ctx.sessionId).filter((job) => job.type !== 'subagent');
    const lines = [
      ...active.map((job) => `${job.id} [running/${job.type}] ${job.summary}${job.pid ? ` pid=${job.pid}` : ''}`),
      ...recent.map((job) => `${job.id} [${job.status}/${job.type}] ${job.summary}`),
    ];
    return this.makeResult(lines.join('\n') || 'No background process jobs found.', {
      structured: { jobs: active, recentJobs: recent },
    });
  }
}
