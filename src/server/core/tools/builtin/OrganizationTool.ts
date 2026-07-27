import { InterruptBehavior, RiskLevel, Tool } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  buildActionSchema,
  executeToolAction,
  getToolAction,
  withoutAction,
  type ToolActionMap,
} from '../ToolActionRouter.js';
import { HireEmployeeTool } from '../operations/HireEmployeeTool.js';
import { ListEmployeesTool } from '../operations/ListEmployeesTool.js';
import { UpdateOrgTool } from '../operations/UpdateOrgTool.js';

export class OrganizationTool extends Tool {
  static category = 'Agent Teams';
  static toolDescription = 'Lists and changes the durable organization roster.';

  private readonly actions: ToolActionMap = {
    list: {
      description: 'Inspect the complete organization roster and reporting tree.',
      tool: new ListEmployeesTool(),
    },
    hire: {
      description: 'Hire a persistent Manager or Member.',
      tool: new HireEmployeeTool(),
    },
    reassign: {
      description: 'Move an employee to a different manager. MainAgent only.',
      tool: new UpdateOrgTool(),
    },
  };

  name(): string { return 'Organization'; }

  description(): string {
    return 'Manage the durable organization with action="list", "hire", or "reassign". Use Team for temporary session collaboration.';
  }

  prompt(): string {
    return [
      'Use action="list" before hiring, reassigning, forming a Team, or assigning work.',
      'Use action="hire" only for lasting capacity; one-off work belongs in Task action="spawn".',
      'Use action="reassign" only to change durable reporting lines.',
    ].join('\n');
  }

  minRole(): string { return 'Member'; }
  interruptBehavior(): InterruptBehavior { return InterruptBehavior.Block; }
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
