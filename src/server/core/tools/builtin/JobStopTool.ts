import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import { BashTool } from './BashTool.js';
import { RunProgramTool } from './RunProgramTool.js';

export class JobStopTool extends Tool {
  static category = 'Background Jobs';
  static toolDescription = 'Stops a running non-agent background process job.';
  name(): string { return 'JobStop'; }
  description(): string { return 'Stop a Bash or RunProgram background job by jobId.'; }
  riskLevel(): RiskLevel { return RiskLevel.High; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: { jobId: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['jobId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    const jobId = typeof params.jobId === 'string' ? params.jobId.trim() : '';
    if (!jobId) return this.makeError('jobId is required');
    const manager = BackgroundTaskManager.getInstance();
    const job = manager.getTask(jobId);
    if (!job || job.type === 'subagent') return this.makeError(`Active background process job not found: ${jobId}`);
    let processKilled = false;
    if (job.type === 'bash' && typeof job.pid === 'number') {
      processKilled = BashTool.killBackgroundProcessByPid(job.pid);
    } else if (job.type === 'program' && typeof job.pid === 'number') {
      processKilled = RunProgramTool.killBackgroundProcessByPid(job.pid);
    }
    if (!processKilled) manager.kill(jobId, 'Stopped through JobStop');
    return this.makeResult(`Background job ${jobId} stop requested.`, {
      structured: { jobId, type: job.type, pid: job.pid, processKilled },
    });
  }
}
