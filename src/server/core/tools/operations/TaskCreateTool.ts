import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import type { CoordinationTaskPriority } from '../../../../shared/types/coordination.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  booleanParam,
  rootSessionIdFor,
  stringArrayParam,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';

const PRIORITIES = new Set<CoordinationTaskPriority>(['low', 'normal', 'high', 'urgent']);

export class TaskCreateTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Creates a durable task with acceptance criteria, dependencies, and workspace scope.';
  name(): string { return 'TaskCreate'; }
  description(): string { return 'Create a durable hierarchy or team task.'; }
  prompt(): string {
    return [
      'Create one Task per independently verifiable unit of work.',
      'Conversation, review, research, and status tasks should use readOnly=true and never need a workspace lease.',
      'If readOnly and writeScope are both omitted, the task safely defaults to read-only.',
      'For workspace edits, use readOnly=false with the narrowest writeScope. Omitting writeScope on an explicit write task locks the whole workspace.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', minLength: 1, maxLength: 20000 },
        acceptanceCriteria: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2000 }, minItems: 1, maxItems: 50 },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        dependsOn: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 50 },
        readOnly: {
          type: 'boolean',
          description: 'Defaults to true when writeScope is omitted. Set false only for tasks that modify workspace files.',
        },
        writeScope: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 500 },
          maxItems: 50,
          description: 'Workspace-relative paths the task may edit. Supplying a scope implies readOnly=false when readOnly is omitted.',
        },
      },
      required: ['subject', 'description', 'acceptanceCriteria'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const teamId = stringParam(params.teamId, 'teamId', 200, true);
      const priorityRaw = stringParam(params.priority, 'priority', 20, true) || 'normal';
      if (!PRIORITIES.has(priorityRaw as CoordinationTaskPriority)) return this.makeError(`Invalid priority: ${priorityRaw}`);
      const writeScope = stringArrayParam(params.writeScope, 'writeScope', {
        optional: true,
        maxItems: 50,
        maxLength: 500,
      });
      const readOnly = booleanParam(params.readOnly, writeScope.length === 0);
      const task = await CoordinationService.getInstance().createTask({
        rootSessionId: rootSessionIdFor(ctx),
        sourceSessionId: ctx.sessionId,
        teamId,
        mode: teamId ? 'swarm' : 'hierarchy',
        subject: stringParam(params.subject, 'subject', 200)!,
        description: stringParam(params.description, 'description', 20_000)!,
        acceptanceCriteria: stringArrayParam(params.acceptanceCriteria, 'acceptanceCriteria', { maxItems: 50, maxLength: 2_000 }),
        priority: priorityRaw as CoordinationTaskPriority,
        creatorAgentId: ctx.agentId,
        dependsOn: stringArrayParam(params.dependsOn, 'dependsOn', { optional: true, maxItems: 50, maxLength: 200 }),
        readOnly,
        writeScope,
      });
      return this.makeResult(`Task created: ${task.id} [${task.status}/v${task.version}] ${task.subject}`, {
        structured: { task },
      });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
