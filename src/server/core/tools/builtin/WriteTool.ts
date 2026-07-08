// WriteTool - writes content to a file on the local filesystem
// Creates parent directories automatically if they don't exist.
// RiskLevel: Medium (destructive, but reversible via git).

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { atomicWriteFile, resolvePath } from './FileUtils.js';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const BINARY_SAMPLE_BYTES = 4096;
const PARAM_KEYS = ['file_path', 'content', 'create_only', 'expected_sha256', 'dry_run'];

export class WriteTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Writes content to a file on the local filesystem.';
  name(): string {
    return 'Write';
  }

  description(): string {
    return 'Writes a file to the local filesystem. Create parent directories if needed.' +
      ' This tool will overwrite the existing file if there is one at the provided path.' +
      ' If this is an existing file, you MUST read the file first.' +
      ' Supports create_only, expected_sha256, and dry_run safety checks.';
  }

  prompt(): string {
    return '## Write Usage\n' +
      '- Prefer Edit for modifying existing files - it only sends the diff\n' +
      '- Only use Write for new files or complete rewrites\n' +
      '- Use create_only=true when creating a new file that must not overwrite anything\n' +
      '- Use expected_sha256 after reading an existing file to guard against stale overwrites\n' +
      '- Use dry_run=true to validate path and overwrite checks without writing\n' +
      '- NEVER create documentation files (*.md) or README files unless explicitly requested by the user\n' +
      '- Do not create planning, decision, or analysis documents unless asked';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description:
            'The absolute path to the file to write (must be absolute, not relative)',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
        create_only: {
          type: 'boolean',
          description: 'Fail if the target file already exists.',
        },
        expected_sha256: {
          type: 'string',
          pattern: '^[a-fA-F0-9]{64}$',
          description: 'Optional SHA-256 hash of the current file. Fails if the existing file has changed since it was read.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate the write and return metadata without modifying the file.',
        },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
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
    const unexpectedParam = findUnexpectedParam(params, PARAM_KEYS);
    if (unexpectedParam) return this.makeError(`Unexpected parameter: "${unexpectedParam}"`);

    const filePathResult = normalizeRequiredString(params.file_path, 'file_path');
    if (filePathResult.error) return this.makeError(filePathResult.error);
    const filePath = filePathResult.value as string;

    const content = params.content;
    const expectedSha256 = normalizeExpectedSha256(params.expected_sha256);
    const createOnlyResult = normalizeBoolean(params.create_only, 'create_only', false);
    if (createOnlyResult.error) return this.makeError(createOnlyResult.error);
    const createOnly = createOnlyResult.value!;

    const dryRunResult = normalizeBoolean(params.dry_run, 'dry_run', false);
    if (dryRunResult.error) return this.makeError(dryRunResult.error);
    const dryRun = dryRunResult.value!;

    if (content === undefined || content === null) {
      return this.makeError('content is required');
    }
    if (typeof content !== 'string') {
      return this.makeError('content must be a string');
    }
    if (content.includes('\u0000')) {
      return this.makeError('Write supports UTF-8 text only; binary/NUL content is not supported');
    }
    if (expectedSha256 === null) {
      return this.makeError('expected_sha256 must be a 64-character SHA-256 hex string');
    }
    if (createOnly && expectedSha256) {
      return this.makeError('create_only and expected_sha256 cannot be used together');
    }

    const startedAt = Date.now();

    try {
      const resolved = resolvePath(filePath, ctx.workspace);

      if (ctx.signal?.aborted) {
        return this.makeError('Write cancelled by user before file validation started', { startedAt });
      }

      let existed = false;
      let previousBytes = 0;
      let previousSha256: string | undefined;
      let previousContent: string | undefined;
      try {
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) {
          return this.makeError(`Cannot write file because target is a directory: ${resolved}`);
        }
        existed = true;
        previousBytes = stat.size;
        const currentBuffer = await fs.readFile(resolved);
        previousSha256 = sha256(currentBuffer);
        if (looksBinary(currentBuffer)) {
          return this.makeError(`Refusing to overwrite binary file with Write: ${resolved}`, {
            startedAt,
            structured: {
              existed,
              previousBytes,
              previousSha256,
            },
          });
        }
        previousContent = currentBuffer.toString('utf-8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw err;
        }
      }

      if (createOnly && existed) {
        return this.makeError(`Write refused: target already exists and create_only=true: ${resolved}`, {
          startedAt,
          structured: {
            existed,
            createOnly,
            previousBytes,
            previousSha256,
          },
        });
      }

      if (expectedSha256 && !existed) {
        return this.makeError(`Write refused: expected_sha256 was provided but target does not exist: ${resolved}`, {
          startedAt,
          structured: {
            existed,
            expectedSha256,
          },
        });
      }

      if (expectedSha256 && previousSha256 !== expectedSha256) {
        return this.makeError(
          `Write refused: current file SHA-256 does not match expected_sha256 for ${resolved}. ` +
          `Expected ${expectedSha256}, found ${previousSha256}. Re-read the file before overwriting.`,
          {
            startedAt,
            structured: {
              existed,
              expectedSha256,
              previousSha256,
              previousBytes,
            },
          },
        );
      }

      const bytes = Buffer.byteLength(content, 'utf-8');
      const contentSha256 = sha256(Buffer.from(content, 'utf-8'));
      const noOp = existed && previousContent === content;

      const structured = {
        created: !existed,
        overwritten: existed && !noOp,
        dryRun,
        noOp,
        chars: content.length,
        bytes,
        previousBytes: existed ? previousBytes : undefined,
        sha256: contentSha256,
        previousSha256,
        createOnly,
      };

      if (dryRun) {
        return this.makeResult(
          `Dry run succeeded for ${resolved}: would ${existed ? (noOp ? 'leave unchanged' : 'overwrite') : 'create'} ` +
          `${bytes} byte${bytes === 1 ? '' : 's'} (${content.length} chars)`,
          { startedAt, structured },
        );
      }

      if (noOp) {
        return this.makeResult(
          `No changes needed: ${resolved} already matches the provided content (${bytes} byte${bytes === 1 ? '' : 's'})`,
          { startedAt, structured },
        );
      }

      await atomicWriteFile(resolved, content, 'utf-8');

      let msg = `Successfully ${existed ? 'overwrote' : 'created'} ${resolved} with ${content.length} chars (${bytes} bytes)`;
      if (existed && content.length === 0) {
        msg += '\n[Warning: file was overwritten with empty content]';
      }
      return this.makeResult(msg, { startedAt, structured });
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

function normalizeExpectedSha256(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SHA256_HEX_RE.test(normalized) ? normalized : null;
}

function normalizeBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'boolean') return { error: `${name} must be a boolean` };
  return { value };
}

function normalizeRequiredString(
  value: unknown,
  name: string,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${name} is required` };
  const normalized = value.trim();
  if (!normalized) return { error: `${name} must not be empty` };
  return { value: normalized };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function looksBinary(data: Buffer): boolean {
  const sample = data.subarray(0, Math.min(BINARY_SAMPLE_BYTES, data.length));
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.3;
}

function findUnexpectedParam(params: Record<string, unknown>, allowed: string[]): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(params).find(key => !allowedSet.has(key)) ?? null;
}
