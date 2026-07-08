// PlanTool - writes a plan file to the workspace and guides step-by-step execution.
// Unlike EnterPlanMode/ExitPlanMode (which toggle a global flag),
// this creates a concrete markdown file the agent reads and follows.
// shouldDefer: true (does not consume a model turn).
// RiskLevel: Safe.

import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWriteFile } from './FileUtils.js';

const MAX_RAW_NAME_CHARS = 60;
const MAX_SAFE_NAME_CHARS = 40;
const MAX_CONTENT_CHARS = 50000;

export class PlanTool extends Tool {
  static category = 'Planning & Communication';
  static toolDescription = 'Writes a plan markdown file to the workspace and executes it step by step.';

  name(): string {
    return 'Plan';
  }

  description(): string {
    return 'Write a structured plan to a plan-{name}.md file in the workspace, then execute each step. Supports dry_run and overwrite controls so existing plans are not silently replaced.';
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
      '5. Update or overwrite an existing plan only when intentionally continuing the same plan\n' +
      '6. After finishing all steps, report completion\n\n' +
      '**Plan file format:** Use markdown with clear step headers (`## Step 1: ...`), file paths in backticks, and checkboxes for tracking.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RAW_NAME_CHARS,
          pattern: '\\S',
          description: 'Short descriptive name for the plan (used in filename: plan-{name}.md). Use kebab-case, max 40 chars.',
        },
        content: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_CONTENT_CHARS,
          pattern: '\\S',
          description: 'Full plan content in markdown. Include: goal, steps with checkboxes, files involved, decisions made. Each step should be specific and verifiable.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Allow replacing an existing plan file with the same sanitized name. Default false.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate and preview the plan file path/metadata without writing.',
        },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Low;
  }

  isReadOnly(): boolean {
    return false; // Writes a plan file in the workspace.
  }

  shouldDefer(): boolean {
    return true; // Does not consume a model turn
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const nameResult = normalizeString(params.name, 'name', { allowEmpty: false });
    if (nameResult.error) return this.makeError(nameResult.error);
    const rawName = nameResult.value!.trim();

    const contentResult = normalizeString(params.content, 'content', { allowEmpty: false });
    if (contentResult.error) return this.makeError(contentResult.error);
    const content = contentResult.value!.trim();

    const overwriteResult = normalizeBoolean(params.overwrite, 'overwrite', false);
    if (overwriteResult.error) return this.makeError(overwriteResult.error);
    const overwrite = overwriteResult.value!;

    const dryRunResult = normalizeBoolean(params.dry_run, 'dry_run', false);
    if (dryRunResult.error) return this.makeError(dryRunResult.error);
    const dryRun = dryRunResult.value!;

    if (rawName.length > MAX_RAW_NAME_CHARS) {
      return this.makeError(`Plan name too long (max ${MAX_RAW_NAME_CHARS} chars).`);
    }
    if (content.length > MAX_CONTENT_CHARS) {
      return this.makeError(`Plan content too long (max ${MAX_CONTENT_CHARS} chars). Split the work into smaller plans.`);
    }
    if (content.includes('\u0000')) {
      return this.makeError('Plan content must be UTF-8 text; NUL content is not supported.');
    }

    // Sanitize name for filename: lowercase, replace non-alphanum with dash, collapse dashes
    const safeName = rawName
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SAFE_NAME_CHARS);

    if (!safeName) {
      return this.makeError('Plan name must contain at least one letter, digit, or Chinese character.');
    }

    const workspace = ctx.workspace || process.cwd();
    const filename = `plan-${safeName}.md`;
    const filePath = path.join(workspace, filename);
    const startedAt = Date.now();

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
    const bytes = Buffer.byteLength(fullContent, 'utf-8');
    const metadata = {
      planFile: filename,
      planPath: filePath,
      rawName,
      safeName,
      dryRun,
      overwrite,
      contentChars: content.length,
      totalChars: fullContent.length,
      bytes,
      lineCount: fullContent.split(/\r?\n/).length,
      checkboxCount: countCheckboxes(content),
      stepHeadingCount: countStepHeadings(content),
    };

    try {
      if (ctx.signal?.aborted) {
        return this.makeError('Plan cancelled by user before file validation started', { startedAt });
      }
      await fs.mkdir(workspace, { recursive: true });
      const existing = await statIfExists(filePath);
      if (existing && !overwrite) {
        return this.makeError(
          `Plan file already exists: ${filename}. Use overwrite=true to replace it intentionally.`,
          {
            startedAt,
            structured: {
              ...metadata,
              existed: true,
              previousBytes: existing.size,
            },
          },
        );
      }
      if (!dryRun) {
        await atomicWriteFile(filePath, fullContent, 'utf-8');
      }
      const existed = Boolean(existing);
      const resultPrefix = dryRun
        ? 'Dry run succeeded'
        : existed
          ? 'Plan file overwritten'
          : 'Plan file written';
      return this.makeResult(
        `${resultPrefix}: ${filename}\n\n` +
        `Path: ${filePath}\n\n` +
        'Next steps:\n' +
        '1. Read the plan file to confirm it\n' +
        '2. Execute each step in order, using TodoWrite for within-step tracking\n' +
        '3. Update the plan file (via Edit) to check off completed steps',
        {
          startedAt,
          structured: {
            ...metadata,
            existed,
            previousBytes: existing?.size,
          },
        },
      );
    } catch (err) {
      return this.makeError(`Failed to write plan file: ${(err as Error).message}`, { startedAt });
    }
  }
}

function normalizeString(
  value: unknown,
  name: string,
  opts: { allowEmpty: boolean },
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { error: `Plan "${name}" is required.` };
  if (typeof value !== 'string') return { error: `Plan "${name}" must be a string.` };
  if (!opts.allowEmpty && value.trim().length === 0) return { error: `Plan "${name}" is required.` };
  return { value };
}

function normalizeBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'boolean') return { error: `Plan "${name}" must be a boolean.` };
  return { value };
}

async function statIfExists(filePath: string): Promise<{ size: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    return { size: stat.size };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

function countCheckboxes(content: string): number {
  return (content.match(/^\s*[-*]\s+\[[ xX]\]/gm) || []).length;
}

function countStepHeadings(content: string): number {
  return (content.match(/^#{2,6}\s+step\b/gim) || []).length;
}
