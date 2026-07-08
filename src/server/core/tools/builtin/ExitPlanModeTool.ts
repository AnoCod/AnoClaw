// ExitPlanModeTool - signals the agent to exit plan mode
// Returns to normal execution mode, allowing destructive tools.
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { ToolPipeline, type AllowedPrompt } from '../ToolPipeline.js';

const MAX_ALLOWED_PROMPTS = 20;
const MAX_ALLOWED_PROMPT_CHARS = 4000;

type AllowedPromptValidation =
  | { ok: true; prompts: AllowedPrompt[] }
  | { ok: false; error: string };

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
          maxItems: MAX_ALLOWED_PROMPTS,
          items: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                enum: ['Bash'],
              },
              prompt: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_ALLOWED_PROMPT_CHARS,
                pattern: '\\S',
              },
            },
            required: ['tool', 'prompt'],
          },
          description: 'Optional list of exact Bash commands that should be auto-approved during implementation.',
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
    const normalized = normalizeAllowedPrompts(params.allowedPrompts);
    if (!normalized.ok) {
      ToolPipeline.setAllowedPrompts(ctx.sessionId, []);
      return this.makeError(normalized.error);
    }

    ToolPipeline.exitPlanMode(ctx.sessionId);
    ToolPipeline.setAllowedPrompts(ctx.sessionId, normalized.prompts);

    let result = 'Exiting plan mode. Returning to normal execution mode.' +
      '\nDestructive tools (Write, Edit, Bash) are now allowed.' +
      '\nProceed with implementation according to the plan.';

    if (normalized.prompts.length > 0) {
      const prompts = normalized.prompts
        .map((p) => `  - ${p.tool}: ${p.prompt}`)
        .join('\n');
      result += `\n\nAuto-approved exact prompts:\n${prompts}`;
    }

    return this.makeResult(result, {
      structured: {
        allowedPromptCount: normalized.prompts.length,
        allowedTools: [...new Set(normalized.prompts.map((p) => p.tool))],
      },
    });
  }
}

function normalizeAllowedPrompts(value: unknown): AllowedPromptValidation {
  if (value === undefined || value === null) {
    return { ok: true, prompts: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: 'allowedPrompts must be an array when provided.' };
  }

  if (value.length > MAX_ALLOWED_PROMPTS) {
    return { ok: false, error: `allowedPrompts may include at most ${MAX_ALLOWED_PROMPTS} entries.` };
  }

  const prompts: AllowedPrompt[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const prefix = `allowedPrompts[${index}]`;

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `${prefix} must be an object.` };
    }

    const raw = entry as Record<string, unknown>;
    if (raw.tool !== 'Bash') {
      return { ok: false, error: `${prefix}.tool must be "Bash".` };
    }

    if (typeof raw.prompt !== 'string') {
      return { ok: false, error: `${prefix}.prompt must be a string.` };
    }

    const prompt = raw.prompt.trim();
    if (prompt.length === 0) {
      return { ok: false, error: `${prefix}.prompt must not be empty.` };
    }
    if (prompt.length > MAX_ALLOWED_PROMPT_CHARS) {
      return { ok: false, error: `${prefix}.prompt must be ${MAX_ALLOWED_PROMPT_CHARS} characters or less.` };
    }

    prompts.push({ tool: 'Bash', prompt });
  }

  return { ok: true, prompts };
}
