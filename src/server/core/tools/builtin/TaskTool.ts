import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  buildActionSchema,
  executeToolAction,
  getToolAction,
  withoutAction,
  type ToolActionMap,
} from '../ToolActionRouter.js';
import { TaskAssignTool } from '../operations/TaskAssignTool.js';
import { TaskClaimTool } from '../operations/TaskClaimTool.js';
import { TaskCreateTool } from '../operations/TaskCreateTool.js';
import { TaskListTool } from '../operations/TaskListTool.js';
import { TaskOutputTool } from '../operations/TaskOutputTool.js';
import { TaskStopTool } from '../operations/TaskStopTool.js';
import { TaskUpdateTool } from '../operations/TaskUpdateTool.js';
import { SubAgentSpawnTool } from '../operations/SubAgentSpawnTool.js';

export class TaskTool extends Tool {
  static category = 'Task Coordination';
  static toolDescription = 'Creates, routes, tracks, reads, stops, and executes durable coordination tasks.';

  private readonly actions: ToolActionMap = {
    create: {
      description: 'Create a durable task; targetAgentId optionally assigns it immediately.',
      tool: new TaskCreateTool(),
    },
    assign: {
      description: 'Assign an existing task to an eligible employee.',
      tool: new TaskAssignTool(),
    },
    claim: {
      description: 'Atomically claim one ready unowned team task.',
      tool: new TaskClaimTool(),
    },
    update: {
      description: 'Report progress, a blocker, result summary, evidence, or failure.',
      tool: new TaskUpdateTool(),
    },
    list: {
      description: 'List tasks by team, status, or assignee.',
      tool: new TaskListTool(),
    },
    output: {
      description: 'Read task details and transcript-backed output, optionally waiting once.',
      tool: new TaskOutputTool(),
    },
    stop: {
      description: 'Cancel a task and interrupt its running AgentLoop.',
      tool: new TaskStopTool(),
    },
    spawn: {
      description: 'Run a temporary Explore, Plan, or general-purpose helper.',
      tool: new SubAgentSpawnTool(),
    },
  };

  name(): string { return 'Task'; }

  description(): string {
    return 'Coordinate work with action="create", "assign", "claim", "update", "list", "output", "stop", or "spawn".';
  }

  prompt(): string {
    return [
      'Use action="create" for durable employee work. Include targetAgentId to create and assign in one call.',
      'Use action="spawn" only for a bounded temporary helper.',
      'Completion notifications are automatic. Use action="list" for oversight and action="output" for details or final results; do not poll.',
      'Use AgentMessage to clarify or steer work that is already running.',
    ].join('\n');
  }

  minRole(): string { return 'Member'; }
  isAsync(): boolean { return true; }
  defaultTimeoutMs(): number { return 300_000; }

  parametersSchema(): Record<string, unknown> {
    const schema = buildActionSchema(this.actions) as {
      properties: Record<string, Record<string, unknown>>;
    };
    schema.properties.targetAgentId = {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'For action="create", optionally assigns the new task immediately. For action="assign", identifies the assignee.',
    };
    return schema;
  }

  riskLevel(params?: Record<string, unknown>): RiskLevel {
    const definition = params ? getToolAction(this.actions, params) : undefined;
    return definition?.tool.riskLevel(withoutAction(params!)) ?? RiskLevel.High;
  }

  isReadOnly(params?: Record<string, unknown>): boolean {
    const definition = params ? getToolAction(this.actions, params) : undefined;
    return definition?.tool.isReadOnly(withoutAction(params!)) ?? false;
  }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    if (params.action !== 'create' || typeof params.targetAgentId !== 'string') {
      return executeToolAction(this.actions, params, ctx);
    }

    const { targetAgentId, ...createParams } = withoutAction(params);
    const createResult = await executeToolAction(this.actions, { action: 'create', ...createParams }, ctx);
    if (!createResult.success) return createResult;

    const createStructured = createResult.structured as { task?: { id?: string } } | undefined;
    const createdTask = createStructured?.task;
    if (!createdTask?.id) return this.makeError('Task was created but its ID was not returned.');

    const assignResult = await executeToolAction(this.actions, {
      action: 'assign',
      taskId: createdTask.id,
      targetAgentId,
    }, ctx);
    if (!assignResult.success) {
      return this.makeError(
        `Task ${createdTask.id} was created but could not be assigned: ${assignResult.errorMessage || assignResult.content}`,
        { structured: { task: createdTask, assignment: assignResult.structured } },
      );
    }

    return this.makeResult(
      `Task ${createdTask.id} created and assigned to ${targetAgentId}; scheduler will start it when ready.`,
      { structured: assignResult.structured as Record<string, unknown> },
    );
  }
}
