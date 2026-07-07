// PlanTool - writes a plan file to the workspace and guides step-by-step execution.
// Unlike EnterPlanMode/ExitPlanMode (which toggle a global flag),
// this creates a concrete markdown file the agent reads and follows.
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import * as fs from 'fs';
import * as path from 'path';

export class PlanTool extends Tool {
  static category = 'Planning & Communication';
  static toolDescription = 'Writes a plan markdown file to the workspace and executes it step by step.';

  name(): string {
    return 'Plan';
  }

  description(): string {
    return 'Write a structured plan to a plan-{name}.md file in the workspace, then execute each step. The plan file is a concrete artifact - after writing, read it back and follow it step by step, checking off items as you go.';
  }

  prompt(): string {
    return '## Plan Tool Usage\n\n' +
      'Use Plan to write a concrete plan file BEFORE implementing anything non-trivial. Unlike EnterPlanMode (which blocks tools), Plan creates a real file you follow.\n\n' +
      '**When to use Plan:**\n' +
      '- Multi-step implementation (3+ distinct steps)\n' +
      '- Architectural decisions to make\n' +
      '- Feature with unclear scope - plan first, then execute\n' +
      '- User asks for a "plan" or "design" before coding\n\n' +
      '**When NOT to use Plan:**\n' +
      '- Single-line fix or trivial change\n' +
      '- User explicitly said "just do it"\n' +
      '- Pure research/exploratory questions\n\n' +
      '**How to use Plan:**\n' +
      '1. Call Plan with a short name and the full plan content (steps, decisions, file list)\n' +
      '2. The tool writes `plan-{name}.md` to the workspace and returns the path\n' +
      '3. Read the plan file to confirm it\n' +
      '4. Execute each step in order, using TodoWrite to track within each step\n' +
      '5. After finishing all steps, report completion\n\n' +
      '**Plan file format:** Use markdown with clear step headers (`## Step 1: ...`), file paths in backticks, and checkboxes for tracking.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short descriptive name for the plan (used in filename: plan-{name}.md). Use kebab-case, max 40 chars.',
        },
        content: {
          type: 'string',
          description: 'Full plan content in markdown. Include: goal, steps with checkboxes, files involved, decisions made. Each step should be specific and verifiable.',
        },
      },
      required: ['name', 'content'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isReadOnly(): boolean {
    return false; // Writes a plan file in the workspace.
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
    const rawName = (params.name as string || '').trim();
    const content = (params.content as string || '').trim();

    if (!rawName) {
      return this.makeError('Plan "name" is required.');
    }
    if (!content) {
      return this.makeError('Plan "content" is required.');
    }
    if (rawName.length > 60) {
      return this.makeError('Plan name too long (max 60 chars).');
    }

    // Sanitize name for filename: lowercase, replace non-alphanum with dash, collapse dashes
    const safeName = rawName
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    if (!safeName) {
      return this.makeError('Plan name must contain at least one letter, digit, or Chinese character.');
    }

    const workspace = ctx.workspace || process.cwd();
    const filename = `plan-${safeName}.md`;
    const filePath = path.join(workspace, filename);

    // Build the plan file with a header
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const fullContent = [
      `# Plan: ${rawName}`,
      '',
      `> Created: ${timestamp}`,
      `> Session: ${ctx.sessionId}`,
      '',
      content,
    ].join('\n');

    try {
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(filePath, fullContent, 'utf-8');
    } catch (err) {
      return this.makeError(`Failed to write plan file: ${(err as Error).message}`);
    }

    return this.makeResult(
      `Plan file written: ${filename}\n\n` +
      `Path: ${filePath}\n\n` +
      'Next steps:\n' +
      '1. Read the plan file to confirm it\n' +
      '2. Execute each step in order, using TodoWrite for within-step tracking\n' +
      '3. Update the plan file (via Edit) to check off completed steps',
      { structured: { planFile: filename, planPath: filePath } },
    );
  }
}
