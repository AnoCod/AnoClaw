import { RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  buildActionSchema,
  executeToolAction,
  getToolAction,
  withoutAction,
  type ToolActionMap,
} from '../ToolActionRouter.js';
import { TeamCreateTool } from '../operations/TeamCreateTool.js';
import { TeamDeleteTool } from '../operations/TeamDeleteTool.js';
import { TeamStatusTool } from '../operations/TeamStatusTool.js';
import { TeamUpdateTool } from '../operations/TeamUpdateTool.js';

export class TeamTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Manages the current root session collaboration team.';

  private readonly actions: ToolActionMap = {
    create: {
      description: 'Create the one active collaboration team for this root session.',
      tool: new TeamCreateTool(),
    },
    update: {
      description: 'Add or remove members, or transfer team leadership.',
      tool: new TeamUpdateTool(),
    },
    status: {
      description: 'Inspect the team, tasks, messages, and workspace leases.',
      tool: new TeamStatusTool(),
    },
    delete: {
      description: 'Disband the team, optionally cancelling active work.',
      tool: new TeamDeleteTool(),
    },
  };

  name(): string { return 'Team'; }

  description(): string {
    return 'Manage temporary collaboration with action="create", "update", "status", or "delete". This never changes the durable Organization.';
  }

  prompt(): string {
    return [
      'Create a Team only when parallel work benefits from shared peer coordination.',
      'Use Organization action="list" to choose existing employees.',
      'Use action="status" at milestones; do not poll continuously.',
    ].join('\n');
  }

  minRole(): string { return 'Member'; }
  parametersSchema(): Record<string, unknown> { return buildActionSchema(this.actions); }

  riskLevel(params?: Record<string, unknown>): RiskLevel {
    const definition = params ? getToolAction(this.actions, params) : undefined;
    return definition?.tool.riskLevel(withoutAction(params!)) ?? RiskLevel.High;
  }

  isReadOnly(params?: Record<string, unknown>): boolean {
    const definition = params ? getToolAction(this.actions, params) : undefined;
    return definition?.tool.isReadOnly(withoutAction(params!)) ?? false;
  }

  execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    return executeToolAction(this.actions, params, ctx);
  }
}
