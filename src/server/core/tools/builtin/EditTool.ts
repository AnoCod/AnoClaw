// EditTool - performs exact string replacements in files
// Based on Claude Code's FileEditTool pattern.
// RiskLevel: Low (reversible via git, single-string replacement).

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel, InterruptBehavior } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { atomicWriteFile, resolvePath } from './FileUtils.js';

const BINARY_SAMPLE_BYTES = 4096;
const MAX_DIAGNOSTIC_MATCHES = 5;

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
      ' Use replace_all to replace every occurrence of old_string.' +
      ' Supports expected_replacements for safety checks and dry_run for previewing edits.';
  }

  prompt(): string {
    return '## Edit Usage\n' +
      '- ALWAYS prefer Edit over Write for modifying existing files - Edit only sends the diff\n' +
      '- Only use Write to create new files or for complete rewrites\n' +
      '- You must Read the file before editing\n' +
      '- Match existing code style exactly - consistency over your preference\n' +
      '- Touch ONLY lines relevant to the change - do not fix adjacent formatting\n' +
      '- Use expected_replacements when replacing repeated text to guard against accidental broad edits\n' +
      '- Use dry_run=true to validate a risky replacement before writing';
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
        expected_replacements: {
          type: 'number',
          description: 'Optional safety check: fail unless the edit would replace exactly this many occurrences.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the edit and validation result without writing the file.',
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
    const expectedReplacements = normalizeExpectedReplacements(params.expected_replacements as number | undefined);
    const dryRun = (params.dry_run as boolean) ?? false;

    if (!filePath || typeof filePath !== 'string') {
      return this.makeError('file_path is required');
    }
    if (!oldString) {
      return this.makeError('old_string is required');
    }
    if (oldString === newString) {
      return this.makeError('old_string and new_string must be different');
    }
    if (expectedReplacements !== undefined && expectedReplacements < 1) {
      return this.makeError('expected_replacements must be a positive integer');
    }

    const startedAt = Date.now();

    try {
      const resolved = resolvePath(filePath, ctx.workspace);
      if (ctx.signal?.aborted) {
        return this.makeError('Edit cancelled by user before file read started', { startedAt });
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(resolved);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`File not found: ${filePath}`);
        }
        throw err;
      }
      if (stat.isDirectory()) {
        return this.makeError(`Cannot edit directory: ${filePath}`);
      }
      if (await looksBinary(resolved)) {
        return this.makeError(`Refusing to edit binary file: ${filePath}`);
      }

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

      const lineEnding = detectDominantLineEnding(original);
      let effectiveOld = oldString;
      let effectiveNew = alignLineEndings(newString, lineEnding);
      let lineEndingsAdjusted = effectiveNew !== newString;

      if (!original.includes(effectiveOld)) {
        const adjustedOld = alignLineEndings(oldString, lineEnding);
        if (adjustedOld !== oldString && original.includes(adjustedOld)) {
          effectiveOld = adjustedOld;
          lineEndingsAdjusted = true;
        }
      }

      const occurrenceCount = countOccurrences(original, effectiveOld);
      if (occurrenceCount === 0) {
        return this.makeError(createNotFoundMessage(original, oldString));
      }

      // For non-replace_all, ensure uniqueness
      if (!replaceAll && occurrenceCount > 1) {
        return this.makeError(
          `old_string is not unique in the file. Found ${occurrenceCount} occurrences. ` +
          `Use replace_all: true to replace all, or provide a larger string with more surrounding context.\n` +
          formatOccurrenceDiagnostics(original, effectiveOld),
        );
      }

      const replacementCount = replaceAll ? occurrenceCount : 1;
      if (expectedReplacements !== undefined && replacementCount !== expectedReplacements) {
        return this.makeError(
          `Replacement count mismatch: expected ${expectedReplacements}, would replace ${replacementCount}. ` +
          `No changes were written.\n` +
          formatOccurrenceDiagnostics(original, effectiveOld),
        );
      }

      // Perform replacement
      let result: string;
      if (replaceAll) {
        const parts = original.split(effectiveOld);
        result = parts.join(effectiveNew);
      } else {
        const idx = original.indexOf(effectiveOld);
        result = original.slice(0, idx) + effectiveNew + original.slice(idx + effectiveOld.length);
      }

      if (!dryRun) {
        // Write back atomically
        await atomicWriteFile(resolved, result, 'utf-8');
      }

      const charDelta = result.length - original.length;
      const previewPrefix = dryRun ? 'Dry run succeeded' : 'Successfully edited';
      return this.makeResult(
        `${previewPrefix} ${resolved}: ` +
        `replaced ${replacementCount} occurrence${replacementCount === 1 ? '' : 's'} ` +
        `of "${oldString.slice(0, 50)}" with "${newString.slice(0, 50)}"` +
        (charDelta !== 0 ? ` (${formatSigned(charDelta)} chars)` : '') +
        (lineEndingsAdjusted ? '\n[Line endings normalized to match the target file]' : ''),
        {
          startedAt,
          structured: {
            replacements: replacementCount,
            dryRun,
            charDelta,
            lineEndingsAdjusted,
          },
        },
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

function normalizeExpectedReplacements(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
}

async function looksBinary(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SAMPLE_BYTES, 0);
    if (bytesRead === 0) return false;
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return true;
    let suspicious = 0;
    for (const byte of sample) {
      if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
    }
    return suspicious / sample.length > 0.3;
  } finally {
    await handle.close();
  }
}

function detectDominantLineEnding(content: string): '\n' | '\r\n' {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function alignLineEndings(value: string, lineEnding: '\n' | '\r\n'): string {
  return value.replace(/\r\n|\r|\n/g, lineEnding);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function createNotFoundMessage(content: string, oldString: string): string {
  const diagnostics = findSimilarLineDiagnostics(content, oldString);
  return [
    `Cannot find string to replace in file: "${oldString.slice(0, 100)}"`,
    diagnostics ? `Nearby lines that may help refine old_string:\n${diagnostics}` : '',
  ].filter(Boolean).join('\n');
}

function findSimilarLineDiagnostics(content: string, oldString: string): string {
  const candidates = oldString
    .split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(line => line.length >= 8)
    .sort((a, b) => b.length - a.length);
  const anchor = candidates[0] || oldString.trim();
  if (!anchor) return '';

  const lines = content.split(/\r\n|\r|\n/);
  const exactFragment = anchor.slice(0, Math.min(60, anchor.length));
  const matches: string[] = [];
  for (let i = 0; i < lines.length && matches.length < MAX_DIAGNOSTIC_MATCHES; i++) {
    const line = lines[i];
    if (line.includes(exactFragment) || normalizedIncludes(line, anchor)) {
      matches.push(`line ${i + 1}: ${line.trim().slice(0, 180)}`);
    }
  }
  return matches.join('\n');
}

function normalizedIncludes(line: string, anchor: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const normalizedLine = normalize(line);
  const normalizedAnchor = normalize(anchor);
  if (!normalizedAnchor) return false;
  return normalizedLine.includes(normalizedAnchor.slice(0, Math.min(60, normalizedAnchor.length)));
}

function formatOccurrenceDiagnostics(content: string, needle: string): string {
  const lines = content.split(/\r\n|\r|\n/);
  const diagnostics: string[] = [];
  let searchStart = 0;
  let occurrenceIndex = 0;
  while (diagnostics.length < MAX_DIAGNOSTIC_MATCHES) {
    const index = content.indexOf(needle, searchStart);
    if (index === -1) break;
    occurrenceIndex++;
    const prefix = content.slice(0, index);
    const lineNumber = prefix.split(/\r\n|\r|\n/).length;
    const line = lines[lineNumber - 1] ?? '';
    diagnostics.push(`occurrence ${occurrenceIndex} at line ${lineNumber}: ${line.trim().slice(0, 180)}`);
    searchStart = index + needle.length;
  }
  return diagnostics.length > 0 ? diagnostics.join('\n') : '(no line diagnostics available)';
}
