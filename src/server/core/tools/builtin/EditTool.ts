// EditTool - performs exact string replacements in files
// Based on Claude Code's FileEditTool pattern.
// RiskLevel: Low (reversible via git, single-string replacement).

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
const MAX_DIAGNOSTIC_MATCHES = 5;
const PARAM_KEYS = [
  'file_path',
  'old_string',
  'new_string',
  'replace_all',
  'expected_replacements',
  'expected_sha256',
  'dry_run',
];

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
      ' Supports expected_replacements, expected_sha256, and dry_run for safety checks.';
  }

  prompt(): string {
    return '## Edit Usage\n' +
      '- ALWAYS prefer Edit over Write for modifying existing files - Edit only sends the diff\n' +
      '- Only use Write to create new files or for complete rewrites\n' +
      '- You must Read the file before editing\n' +
      '- Match existing code style exactly - consistency over your preference\n' +
      '- Touch ONLY lines relevant to the change - do not fix adjacent formatting\n' +
      '- Use expected_replacements when replacing repeated text to guard against accidental broad edits\n' +
      '- Use expected_sha256 after reading a file to guard against stale edits\n' +
      '- Use dry_run=true to validate a risky replacement before writing';
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
            'The absolute path to the file to modify (must be absolute, not relative)',
        },
        old_string: {
          type: 'string',
          minLength: 1,
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
          type: 'integer',
          minimum: 1,
          description: 'Optional safety check: fail unless the edit would replace exactly this many occurrences.',
        },
        expected_sha256: {
          type: 'string',
          pattern: '^[a-fA-F0-9]{64}$',
          description: 'Optional SHA-256 hash of the current file. Fails if the file changed since it was read.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview the edit and validation result without writing the file.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
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
    const unexpectedParam = findUnexpectedParam(params, PARAM_KEYS);
    if (unexpectedParam) return this.makeError(`Unexpected parameter: "${unexpectedParam}"`);

    const filePathResult = normalizeRequiredString(params.file_path, 'file_path');
    if (filePathResult.error) return this.makeError(filePathResult.error);
    const filePath = filePathResult.value as string;

    const oldStringResult = normalizeString(params.old_string, 'old_string', { allowEmpty: false });
    if (oldStringResult.error) return this.makeError(oldStringResult.error);
    const oldString = oldStringResult.value!;

    const newStringResult = normalizeString(params.new_string, 'new_string', { allowEmpty: true });
    if (newStringResult.error) return this.makeError(newStringResult.error);
    const newString = newStringResult.value!;

    const replaceAllResult = normalizeBoolean(params.replace_all, 'replace_all', false);
    if (replaceAllResult.error) return this.makeError(replaceAllResult.error);
    const replaceAll = replaceAllResult.value!;

    const expectedReplacementsResult = normalizeOptionalPositiveInteger(params.expected_replacements, 'expected_replacements');
    if (expectedReplacementsResult.error) return this.makeError(expectedReplacementsResult.error);
    const expectedReplacements = expectedReplacementsResult.value;

    const dryRunResult = normalizeBoolean(params.dry_run, 'dry_run', false);
    if (dryRunResult.error) return this.makeError(dryRunResult.error);
    const dryRun = dryRunResult.value!;

    const expectedSha256 = normalizeExpectedSha256(params.expected_sha256);
    if (expectedSha256 === null) {
      return this.makeError('expected_sha256 must be a 64-character SHA-256 hex string');
    }

    if (oldString === newString) {
      return this.makeError('old_string and new_string must be different');
    }
    if (oldString.includes('\u0000') || newString.includes('\u0000')) {
      return this.makeError('Edit supports UTF-8 text only; NUL content is not supported');
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

      // Read existing content
      let originalBuffer: Buffer;
      let original: string;
      try {
        originalBuffer = await fs.readFile(resolved);
        if (looksBinary(originalBuffer)) {
          return this.makeError(`Refusing to edit binary file: ${filePath}`, {
            startedAt,
            structured: {
              filePath: resolved,
              previousBytes: stat.size,
              previousSha256: sha256(originalBuffer),
            },
          });
        }
        original = originalBuffer.toString('utf-8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`File not found: ${filePath}`);
        }
        throw err;
      }

      const previousSha256 = sha256(originalBuffer);
      if (expectedSha256 && previousSha256 !== expectedSha256) {
        return this.makeError(
          `Edit refused: current file SHA-256 does not match expected_sha256 for ${resolved}. ` +
          `Expected ${expectedSha256}, found ${previousSha256}. Re-read the file before editing.`,
          {
            startedAt,
            structured: {
              filePath: resolved,
              expectedSha256,
              previousSha256,
              previousBytes: stat.size,
            },
          },
        );
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
        return this.makeError(createNotFoundMessage(original, oldString), {
          startedAt,
          structured: {
            filePath: resolved,
            occurrences: 0,
            previousSha256,
            previousBytes: stat.size,
          },
        });
      }
      const occurrenceSummary = summarizeOccurrences(original, effectiveOld);

      // For non-replace_all, ensure uniqueness
      if (!replaceAll && occurrenceCount > 1) {
        return this.makeError(
          `old_string is not unique in the file. Found ${occurrenceCount} occurrences. ` +
          `Use replace_all: true to replace all, or provide a larger string with more surrounding context.\n` +
          formatOccurrenceDiagnostics(original, effectiveOld),
          {
            startedAt,
            structured: {
              filePath: resolved,
              occurrences: occurrenceCount,
              sampledLines: occurrenceSummary.sampledLines,
              previousSha256,
              previousBytes: stat.size,
            },
          },
        );
      }

      const replacementCount = replaceAll ? occurrenceCount : 1;
      if (expectedReplacements !== undefined && replacementCount !== expectedReplacements) {
        return this.makeError(
          `Replacement count mismatch: expected ${expectedReplacements}, would replace ${replacementCount}. ` +
          `No changes were written.\n` +
          formatOccurrenceDiagnostics(original, effectiveOld),
          {
            startedAt,
            structured: {
              filePath: resolved,
              expectedReplacements,
              replacements: replacementCount,
              occurrences: occurrenceCount,
              sampledLines: occurrenceSummary.sampledLines,
              previousSha256,
              previousBytes: stat.size,
            },
          },
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
      const bytes = Buffer.byteLength(result, 'utf-8');
      const resultSha256 = sha256(Buffer.from(result, 'utf-8'));
      const noOp = result === original;
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
            filePath: resolved,
            replacements: replacementCount,
            replaceAll,
            dryRun,
            noOp,
            charDelta,
            previousBytes: stat.size,
            bytes,
            previousSha256,
            sha256: resultSha256,
            expectedSha256,
            firstLine: occurrenceSummary.firstLine,
            lastLine: occurrenceSummary.lastLine,
            sampledLines: occurrenceSummary.sampledLines,
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

function normalizeString(
  value: unknown,
  name: string,
  opts: { allowEmpty: boolean },
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { error: `${name} is required` };
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  if (!opts.allowEmpty && value.length === 0) return { error: `${name} is required` };
  return { value };
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

function normalizeOptionalPositiveInteger(
  value: unknown,
  name: string,
): { value?: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
  if (!Number.isInteger(value)) return { error: `${name} must be an integer` };
  if (value < 1) return { error: `${name} must be a positive integer` };
  return { value };
}

function normalizeExpectedSha256(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SHA256_HEX_RE.test(normalized) ? normalized : null;
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

function summarizeOccurrences(
  content: string,
  needle: string,
): { firstLine: number; lastLine: number; sampledLines: number[] } {
  const sampledLines: number[] = [];
  let searchStart = 0;
  let firstLine = 0;
  let lastLine = 0;
  while (true) {
    const index = content.indexOf(needle, searchStart);
    if (index === -1) break;
    const lineNumber = content.slice(0, index).split(/\r\n|\r|\n/).length;
    if (firstLine === 0) firstLine = lineNumber;
    lastLine = lineNumber;
    if (sampledLines.length < MAX_DIAGNOSTIC_MATCHES) sampledLines.push(lineNumber);
    searchStart = index + needle.length;
  }
  return { firstLine, lastLine, sampledLines };
}

function findUnexpectedParam(params: Record<string, unknown>, allowed: string[]): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(params).find(key => !allowedSet.has(key)) ?? null;
}
