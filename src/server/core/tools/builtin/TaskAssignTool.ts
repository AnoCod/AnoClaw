import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import {
  integerParam,
  requireActiveAgent,
  rootSessionIdFor,
  stringParam,
  toolFailure,
} from '../../coordination/CoordinationToolHelpers.js';
import { CoordinationError } from '../../coordination/CoordinationError.js';

export class TaskAssignTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Assigns an existing durable task to an eligible hierarchy or team member.';
  name(): string { return 'TaskAssign'; }
  description(): string { return 'Assign a TaskCreate result to a direct subordinate or active team member.'; }
  prompt(): string {
    return [
      'TaskAssign no longer creates a task. Call TaskCreate first, then assign its taskId.',
      'Hierarchy tasks may target only direct subordinates. Team tasks may target any active member of that team.',
      'The scheduler starts ready tasks automatically; completion arrives as a coordination event.',
    ].join('\n');
  }
  minRole(): string { return 'Member'; }
  riskLevel(): RiskLevel { return RiskLevel.Low; }
  isAsync(): boolean { return true; }
  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 200 },
        targetAgentId: { type: 'string', minLength: 1, maxLength: 200 },
        expectedVersion: { type: 'integer', minimum: 1 },
      },
      required: ['taskId', 'targetAgentId'],
      additionalProperties: false,
    };
  }
  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const rootSessionId = rootSessionIdFor(ctx);
      const taskId = stringParam(params.taskId, 'taskId', 200)!;
      const targetAgentId = stringParam(params.targetAgentId, 'targetAgentId', 200)!;
      requireActiveAgent(targetAgentId);
      const service = CoordinationService.getInstance();
      const task = service.getTask(rootSessionId, taskId);
      if (!task) throw new CoordinationError('not_found', `Task not found: ${taskId}`);
      if (task.creatorAgentId !== ctx.agentId) {
        const team = task.teamId ? service.getTeam(rootSessionId, task.teamId) : undefined;
        if (team?.leaderAgentId !== ctx.agentId) {
          throw new CoordinationError('forbidden', 'Only the task creator or team leader may assign it');
        }
      }
      if (task.mode === 'hierarchy') {
        const target = AgentRegistry.getInstance().findAgent(targetAgentId);
        if (target?.parentAgentId !== ctx.agentId) {
          throw new CoordinationError('forbidden', 'Hierarchy tasks can only be assigned to a direct subordinate');
        }
      } else if (task.mode === 'swarm') {
        const team = task.teamId ? service.getTeam(rootSessionId, task.teamId) : undefined;
        if (!team?.memberAgentIds.includes(targetAgentId)) {
          throw new CoordinationError('validation', 'Swarm assignee must belong to the task team');
        }
      }
      const assigned = await service.assignTask(
        rootSessionId,
        taskId,
        targetAgentId,
        ctx.agentId,
        integerParam(params.expectedVersion, 'expectedVersion', { optional: true, min: 1 }),
      );
      await service.queueMessage({
        rootSessionId,
        teamId: assigned.teamId,
        taskId: assigned.id,
        fromAgentId: ctx.agentId,
        toAgentId: targetAgentId,
        kind: 'task_assignment',
        summary: assigned.subject,
        content: assigned.description,
        idempotencyKey: `assignment:${assigned.id}:${assigned.version}`,
      });
      return this.makeResult(`Task ${assigned.id} assigned to ${targetAgentId}; scheduler will start it when ready.`, {
        structured: { task: assigned },
      });
    } catch (error) {
      return toolFailure(this, error);
    }
  }
}
