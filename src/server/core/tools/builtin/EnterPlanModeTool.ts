// EnterPlanModeTool - signals the agent to enter plan mode
// Plan mode pauses implementation and focuses on exploration/design.
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { ToolPipeline } from '../ToolPipeline.js';

export class EnterPlanModeTool extends Tool {

  static category = 'Planning & Communication';
  static toolDescription = 'Enters plan mode for designing implementation approaches before coding.';
  name(): string {
    return 'EnterPlanMode';
  }

  description(): string {
    return 'Enter plan mode to explore and design an implementation approach before writing code. File modification tools are restricted in plan mode.';
  }

  prompt(): string {
    return '## EnterPlanMode / ExitPlanMode Usage\n' +
      'Plan mode is for designing your approach BEFORE writing code. Use it when the task has multiple valid approaches, architectural decisions to make, or enough complexity that planning upfront saves rework.\n\n' +
      '**When to EnterPlanMode:** Multi-file changes. Architectural decisions. New feature where structure matters. User asked for a plan first.\n\n' +
      '**When NOT to EnterPlanMode:** Single-line fix. Obvious implementation. Trivial rename. User explicitly said "just do it".\n\n' +
      '**In plan mode:** Explore code, design approach, present plan for user approval. **ExitPlanMode** when the user approves and you\'re ready to implement.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
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
    ToolPipeline.enterPlanMode(ctx.sessionId);
    return this.makeResult(
      'Entering plan mode. The agent will now explore and design before implementing.' +
      ' Destructive tools are restricted until ExitPlanMode is called.' +
      '\n\nIn plan mode, you should:' +
      '\n- Read relevant files to understand the codebase' +
      '\n- Analyze requirements and edge cases' +
      '\n- Design the implementation approach' +
      '\n- Create a structured plan before writing code' +
      '\n\nCall ExitPlanMode when the plan is ready for review.',
    );
  }
}
