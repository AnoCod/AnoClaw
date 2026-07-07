// WriteTool - writes content to a file on the local filesystem
// Creates parent directories automatically if they don't exist.
// RiskLevel: Medium (destructive, but reversible via git).

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { atomicWriteFile, resolvePath } from './FileUtils.js';

export class WriteTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Writes content to a file on the local filesystem.';
  name(): string {
    return 'Write';
  }

  description(): string {
    return 'Writes a file to the local filesystem. Create parent directories if needed.' +
      ' This tool will overwrite the existing file if there is one at the provided path.' +
      ' If this is an existing file, you MUST read the file first.';
  }

  prompt(): string {
    return '## Write Usage\n' +
      '- Prefer Edit for modifying existing files - it only sends the diff\n' +
      '- Only use Write for new files or complete rewrites\n' +
      '- NEVER create documentation files (*.md) or README files unless explicitly requested by the user\n' +
      '- Do not create planning, decision, or analysis documents unless asked';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'The absolute path to the file to write (must be absolute, not relative)',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Medium;
  }

  isDestructive(): boolean {
    return true;
  }

  workspacePathParams(): string[] {
    return ['file_path'];
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const content = params.content as string;

    if (!filePath || typeof filePath !== 'string') {
      return this.makeError('file_path is required');
    }
    if (content === undefined || content === null) {
      return this.makeError('content is required');
    }

    const startedAt = Date.now();

    try {
      const resolved = resolvePath(filePath, ctx.workspace);

      // Check if file exists already - warn about overwriting with empty content
      let existed = false;
      try {
        await fs.stat(resolved);
        existed = true;
      } catch { /* file doesn't exist yet */ }

      await atomicWriteFile(resolved, content, 'utf-8');

      let msg = `Successfully wrote ${content.length} chars to ${resolved}`;
      if (existed && content.length === 0) {
        msg += '\n[Warning: file was overwritten with empty content]';
      }
      return this.makeResult(msg, { startedAt });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Write failed: ${errMsg}`);
    }
  }

  // ── UI helpers ──

  userFacingName(_input?: Record<string, unknown>): string {
    return 'Write';
  }

  getToolUseSummary(input?: Record<string, unknown>): string | null {
    if (input?.file_path && typeof input.file_path === 'string') {
      return path.basename(input.file_path);
    }
    return null;
  }

  getActivityDescription(_input?: Record<string, unknown>): string | null {
    return 'Writing file';
  }
}
