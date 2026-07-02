// ExitPlanModeTool — signals the agent to exit plan mode
// Returns to normal execution mode, allowing destructive tools.
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { ToolPipeline } from '../ToolPipeline.js';

export class ExitPlanModeTool extends Tool {

  static category = 'Planning & Communication';
  static toolDescription = 'Exits plan mode and presents the plan for user approval.';
  name(): string {
    return 'ExitPlanMode';
  }

  description(): string {
    return 'Exit plan mode and return to normal execution. File modification tools are re-enabled.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        allowedPrompts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                enum: ['Bash'],
              },
              prompt: {
                type: 'string',
              },
            },
            required: ['tool', 'prompt'],
          },
          description: 'Optional list of Bash prompts that should be auto-approved during implementation.',
        },
      },
      required: [],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isReadOnly(): boolean {
    return true;
  }

  shouldDefer(): boolean {
    return true; // Does not consume a model turn
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Cancel;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    ToolPipeline.exitPlanMode();
    const allowedPrompts = params.allowedPrompts as
      | Array<{ tool: string; prompt: string }>
      | undefined;

    let result = 'Exiting plan mode. Returning to normal execution mode.' +
      '\nDestructive tools (Write, Edit, Bash) are now allowed.' +
      '\nProceed with implementation according to the plan.';

    if (allowedPrompts && allowedPrompts.length > 0) {
      const prompts = allowedPrompts
        .map((p) => `  - ${p.tool}: ${p.prompt}`)
        .join('\n');
      result += `\n\nAuto-approved prompts:\n${prompts}`;
    }

    return this.makeResult(result);
  }
}
