// EditTool — performs exact string replacements in files
// Based on Claude Code's FileEditTool pattern.
// RiskLevel: Low (reversible via git, single-string replacement).

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

export class EditTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Performs exact string replacements in existing files.';
  name(): string {
    return 'Edit';
  }

  description(): string {
    return 'Performs exact string replacements in files.' +
      ' Usage: You must use your Read tool at least once before editing.' +
      ' The edit will FAIL if old_string is not unique in the file.' +
      ' Either provide a larger string with more surrounding context to make it unique.' +
      ' Use replace_all to replace every occurrence of old_string.';
  }

  prompt(): string {
    return '## Edit Usage\n' +
      '- ALWAYS prefer Edit over Write for modifying existing files — Edit only sends the diff\n' +
      '- Only use Write to create new files or for complete rewrites\n' +
      '- You must Read the file before editing\n' +
      '- Match existing code style exactly — consistency over your preference\n' +
      '- Touch ONLY lines relevant to the change — do not fix adjacent formatting';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'The absolute path to the file to modify (must be absolute, not relative)',
        },
        old_string: {
          type: 'string',
          description: 'The text to replace',
        },
        new_string: {
          type: 'string',
          description:
            'The text to replace it with (must be different from old_string)',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of old_string (default false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Low;
  }

  isDestructive(): boolean {
    return true;
  }

  workspacePathParams(): string[] {
    return ['file_path'];
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const oldString = (params.old_string ?? '') as string;
    const newString = (params.new_string ?? '') as string;
    const replaceAll = (params.replace_all as boolean) ?? false;

    if (!filePath || typeof filePath !== 'string') {
      return this.makeError('file_path is required');
    }
    if (!oldString) {
      return this.makeError('old_string is required');
    }
    if (oldString === newString) {
      return this.makeError('old_string and new_string must be different');
    }

    const startedAt = Date.now();

    try {
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(ctx.workspace, filePath);

      // Read existing content
      let original: string;
      try {
        original = await fs.readFile(resolved, 'utf-8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`File not found: ${filePath}`);
        }
        throw err;
      }

      // Find the string to replace
      if (!original.includes(oldString)) {
        return this.makeError(
          `Cannot find string to replace in file: "${oldString.slice(0, 100)}"`
        );
      }

      // For non-replace_all, ensure uniqueness
      if (!replaceAll) {
        const firstIdx = original.indexOf(oldString);
        const secondIdx = original.indexOf(oldString, firstIdx + 1);
        if (secondIdx !== -1) {
          return this.makeError(
            `old_string is not unique in the file. Found ${countOccurrences(original, oldString)} occurrences. ` +
            `Use replace_all: true to replace all, or provide a larger string with more surrounding context.`
          );
        }
      }

      // Perform replacement
      let result: string;
      if (replaceAll) {
        const parts = original.split(oldString);
        result = parts.join(newString);
      } else {
        const idx = original.indexOf(oldString);
        result = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
      }

      // Write back
      await fs.writeFile(resolved, result, 'utf-8');

      const changedChars = Math.abs(result.length - original.length);
      return this.makeResult(
        `Successfully edited ${resolved}: ` +
        `replaced "${oldString.slice(0, 50)}" with "${newString.slice(0, 50)}"` +
        (changedChars > 0 ? ` (${changedChars > 0 ? '+' : ''}${changedChars} chars)` : ''),
        { startedAt },
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Edit failed: ${errMsg}`);
    }
  }

  // ── UI helpers ──

  userFacingName(input?: Record<string, unknown>): string {
    if (input?.old_string === '') return 'Create';
    return 'Update';
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (input?.file_path && typeof input.file_path === 'string') {
      return path.basename(input.file_path);
    }
    return null;
  }

  getActivityDescription(_input?: Record<string, unknown>): string | null {
    return 'Editing file';
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
