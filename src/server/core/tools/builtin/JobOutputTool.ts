import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';

export class JobOutputTool extends Tool {
  static category = 'Background Jobs';
  static toolDescription = 'Reads output from a non-agent background process job.';
  name(): string { return 'JobOutput'; }
  description(): string { return 'Read active or recent Bash/RunProgram background job output.'; }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  isReadOnly(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        jobId: { type: 'string', minLength: 1, maxLength: 200 },
        maxChars: { type: 'integer', minimum: 200, maximum: 50000 },
      },
      required: ['jobId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    const jobId = typeof params.jobId === 'string' ? params.jobId.trim() : '';
    if (!jobId) return this.makeError('jobId is required');
    const maxChars = typeof params.maxChars === 'number' ? params.maxChars : 4_000;
    const manager = BackgroundTaskManager.getInstance();
    const active = manager.getTask(jobId);
    if (active && active.type !== 'subagent') {
      const output = truncate(active.fullContent || active.error || '(no output yet)', maxChars);
      return this.makeResult(`${jobId} is ${active.status}.\n${output}`, { structured: { job: active, output } });
    }
    const recent = manager.getRecentTaskResult(jobId);
    if (recent && recent.type !== 'subagent') {
      const output = truncate(recent.content || recent.error || '(no output)', maxChars);
      return this.makeResult(`${jobId} is ${recent.status}.\n${output}`, { structured: { job: recent, output } });
    }
    return this.makeError(`Background job not found: ${jobId}`);
  }
}
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.floor(max / 2))}\n...[truncated]...\n${value.slice(-Math.floor(max / 2))}`;
}
