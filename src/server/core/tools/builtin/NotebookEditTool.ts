// NotebookEditTool - edits Jupyter notebook (.ipynb) cells
// Supports replacing, inserting, and deleting cells by ID or index.
// RiskLevel: Safe (file edit, but limited to notebook cells).

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { InterruptBehavior, RiskLevel } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { atomicWriteFile, resolvePath } from './FileUtils.js';

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

interface NotebookCell {
  cell_type: 'code' | 'markdown';
  source: string | string[];
  id?: string;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
  [key: string]: unknown;
}

interface NotebookData {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

export class NotebookEditTool extends Tool {

  static category = 'File & Code';
  static toolDescription = 'Edits cells in Jupyter notebooks (.ipynb files).';
  name(): string {
    return 'NotebookEdit';
  }

  description(): string {
    return 'Replace, insert, or delete a single cell in a Jupyter notebook (.ipynb file). Use this instead of Write for notebook edits. Supports dry_run, expected_sha256, and code-cell output clearing safety checks.';
  }

  prompt(): string {
    return '## NotebookEdit Usage\n' +
      'Edit cells in .ipynb Jupyter notebooks. Use this instead of Write or Edit for notebook files - those tools work on raw JSON, this works on the cell structure.\n\n' +
      '**Operations:** `replace` (default) - changes a cell\'s source. `insert` - adds a new cell after the given cell_id. `delete` - removes a cell.\n\n' +
      'When replacing a code cell, stale outputs and execution_count are cleared by default so the notebook does not imply that new code has already run. Set clear_outputs=false only when intentionally preserving outputs.\n\n' +
      'Use expected_sha256 after reading a notebook to guard against stale edits. Use dry_run=true to validate a risky notebook edit without writing.\n\n' +
      'You must Read the notebook first to see cell IDs. Only edit notebook files - for regular .ts/.js/.py files, use Edit.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        notebook_path: {
          type: 'string',
          description: 'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
        },
        new_source: {
          type: 'string',
          description: 'The new source for the cell',
        },
        cell_id: {
          type: 'string',
          description:
            'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
        },
        cell_number: {
          type: 'number',
          description:
            'The 0-indexed cell number to edit. Used when cell_id is not provided.',
        },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: 'The type of the cell (code or markdown). Required when inserting a new cell.',
        },
        edit_mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          description: 'The type of edit to make (replace, insert, delete). Defaults to replace.',
        },
        expected_sha256: {
          type: 'string',
          description: 'Optional SHA-256 hash of the current notebook. Fails if the notebook changed since it was read.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview and validate the notebook edit without writing the file.',
        },
        clear_outputs: {
          type: 'boolean',
          description: 'When replacing a code cell, clear stale outputs and execution_count. Defaults to true.',
        },
      },
      required: ['notebook_path'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Medium;
  }

  isDestructive(): boolean {
    return true;
  }

  workspacePathParams(): string[] {
    return ['notebook_path'];
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const notebookPathResult = normalizeString(params.notebook_path, 'notebook_path', { allowEmpty: false });
    if (notebookPathResult.error) return this.makeError(notebookPathResult.error);
    const notebookPath = notebookPathResult.value!;

    const newSourceResult = normalizeOptionalString(params.new_source, 'new_source');
    if (newSourceResult.error) return this.makeError(newSourceResult.error);
    const newSource = newSourceResult.value;

    const cellIdResult = normalizeOptionalString(params.cell_id, 'cell_id');
    if (cellIdResult.error) return this.makeError(cellIdResult.error);
    const cellId = cellIdResult.value;

    const cellNumberResult = normalizeOptionalInteger(params.cell_number, 'cell_number', 0, Number.MAX_SAFE_INTEGER);
    if (cellNumberResult.error) return this.makeError(cellNumberResult.error);
    const cellNumber = cellNumberResult.value;

    const cellTypeResult = normalizeEnum(params.cell_type, 'cell_type', ['code', 'markdown'] as const, 'code');
    if (cellTypeResult.error) return this.makeError(cellTypeResult.error);
    const cellType = cellTypeResult.value!;

    const editModeResult = normalizeEnum(params.edit_mode, 'edit_mode', ['replace', 'insert', 'delete'] as const, 'replace');
    if (editModeResult.error) return this.makeError(editModeResult.error);
    const editMode = editModeResult.value!;

    const expectedSha256 = normalizeExpectedSha256(params.expected_sha256);
    if (expectedSha256 === null) {
      return this.makeError('expected_sha256 must be a 64-character SHA-256 hex string');
    }

    const dryRunResult = normalizeBoolean(params.dry_run, 'dry_run', false);
    if (dryRunResult.error) return this.makeError(dryRunResult.error);
    const dryRun = dryRunResult.value!;

    const clearOutputsResult = normalizeBoolean(params.clear_outputs, 'clear_outputs', true);
    if (clearOutputsResult.error) return this.makeError(clearOutputsResult.error);
    const clearOutputs = clearOutputsResult.value!;

    if (editMode !== 'delete' && newSource === undefined) {
      return this.makeError('new_source is required for replace and insert modes');
    }
    if (newSource?.includes('\u0000')) {
      return this.makeError('NotebookEdit supports UTF-8 text only; NUL content is not supported');
    }
    if (cellId !== undefined && cellNumber !== undefined) {
      return this.makeError('Specify either cell_id or cell_number, not both');
    }

    const startedAt = Date.now();

    try {
      const resolved = resolvePath(notebookPath, ctx.workspace);
      if (path.extname(resolved).toLowerCase() !== '.ipynb') {
        return this.makeError(`NotebookEdit only supports .ipynb files: ${notebookPath}`);
      }

      let rawBuffer: Buffer;
      try {
        rawBuffer = await fs.readFile(resolved);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`Notebook not found: ${notebookPath}`);
        }
        throw err;
      }
      const raw = rawBuffer.toString('utf-8');
      const previousSha256 = sha256(rawBuffer);
      if (expectedSha256 && expectedSha256 !== previousSha256) {
        return this.makeError(
          `NotebookEdit refused: current notebook SHA-256 does not match expected_sha256 for ${resolved}. ` +
          `Expected ${expectedSha256}, found ${previousSha256}. Re-read the notebook before editing.`,
          {
            startedAt,
            structured: {
              path: resolved,
              expectedSha256,
              previousSha256,
              previousBytes: rawBuffer.byteLength,
            },
          },
        );
      }

      let nb: NotebookData;
      try {
        nb = JSON.parse(raw);
      } catch {
        return this.makeError(
          `Failed to parse notebook: ${notebookPath}. Ensure it is valid JSON.`
        );
      }

      if (!Array.isArray(nb.cells)) {
        return this.makeError(`Notebook has no cells array: ${notebookPath}`);
      }
      for (let index = 0; index < nb.cells.length; index++) {
        const cell = nb.cells[index];
        if (!cell || (cell.cell_type !== 'code' && cell.cell_type !== 'markdown')) {
          return this.makeError(`Notebook cell ${index} has unsupported cell_type: ${String(cell?.cell_type)}`);
        }
        if (typeof cell.source !== 'string' && !isStringArray(cell.source)) {
          return this.makeError(`Notebook cell ${index} has unsupported source format; expected string or string[]`);
        }
      }

      // Find target cell index
      let targetIdx = -1;
      if (cellId) {
        targetIdx = nb.cells.findIndex((c) => c.id === cellId);
      } else if (cellNumber !== undefined && cellNumber >= 0) {
        targetIdx = cellNumber;
      } else {
        targetIdx = editMode === 'insert' ? -1 : 0;
      }
      if (cellId && targetIdx === -1) {
        return this.makeError(`Cell id not found: ${cellId}. Re-read the notebook to inspect current cell IDs.`);
      }
      if (cellNumber !== undefined && (targetIdx < 0 || targetIdx >= nb.cells.length)) {
        return this.makeError(`Cell index ${cellNumber} out of range. Notebook has ${nb.cells.length} cells.`);
      }

      let message = '';
      const beforeCellCount = nb.cells.length;
      let affectedCellId: string | undefined;
      let affectedCellType: 'code' | 'markdown' | undefined;
      let sourceCharsBefore = 0;
      let sourceCharsAfter = 0;
      let previousOutputCount: number | undefined;
      let previousExecutionCount: number | null | undefined;
      let outputsCleared = false;

      switch (editMode) {
        case 'replace': {
          if (targetIdx < 0 || targetIdx >= nb.cells.length) {
            return this.makeError(
              `Cell index ${targetIdx} out of range. Notebook has ${nb.cells.length} cells.`
            );
          }
          const target = nb.cells[targetIdx];
          affectedCellId = target.id;
          affectedCellType = target.cell_type;
          sourceCharsBefore = sourceToString(target.source).length;
          sourceCharsAfter = newSource!.length;
          if (target.cell_type === 'code') {
            previousOutputCount = Array.isArray(target.outputs) ? target.outputs.length : undefined;
            previousExecutionCount = target.execution_count;
            if (clearOutputs) {
              target.execution_count = null;
              target.outputs = [];
              outputsCleared = (previousOutputCount ?? 0) > 0 ||
                (previousExecutionCount !== undefined && previousExecutionCount !== null);
            }
          }
          target.source = applySourceFormat(newSource!, target.source);
          message = `Replaced source of cell ${targetIdx} (${affectedCellType}) in ${path.basename(resolved)}`;
          break;
        }

        case 'insert': {
          const newCell: NotebookCell = {
            cell_type: cellType ?? 'code',
            source: newSource ?? '',
            metadata: {},
          };
          if (shouldCreateCellId(nb)) newCell.id = createNotebookCellId();
          if (cellType === 'code') {
            newCell.execution_count = null;
            newCell.outputs = [];
          }
          affectedCellId = newCell.id;
          affectedCellType = newCell.cell_type;
          sourceCharsAfter = sourceToString(newCell.source).length;
          if (targetIdx >= 0 && targetIdx < nb.cells.length) {
            nb.cells.splice(targetIdx + 1, 0, newCell);
            message = `Inserted ${cellType} cell after index ${targetIdx} in ${path.basename(resolved)}`;
          } else {
            nb.cells.unshift(newCell);
            message = `Inserted ${cellType} cell at beginning of ${path.basename(resolved)}`;
          }
          break;
        }

        case 'delete': {
          if (targetIdx < 0 || targetIdx >= nb.cells.length) {
            return this.makeError(
              `Cell index ${targetIdx} out of range. Notebook has ${nb.cells.length} cells.`
            );
          }
          const removed = nb.cells[targetIdx];
          affectedCellId = removed.id;
          affectedCellType = removed.cell_type;
          sourceCharsBefore = sourceToString(removed.source).length;
          nb.cells.splice(targetIdx, 1);
          message = `Deleted ${removed.cell_type} cell ${targetIdx} from ${path.basename(resolved)}`;
          break;
        }
      }

      const output = JSON.stringify(nb, null, 1) + '\n';
      const resultSha256 = sha256(Buffer.from(output, 'utf-8'));
      const structured = {
        path: resolved,
        editMode,
        dryRun,
        cellIndex: targetIdx,
        cellId: affectedCellId,
        cellType: affectedCellType,
        beforeCellCount,
        afterCellCount: nb.cells.length,
        sourceCharsBefore,
        sourceCharsAfter,
        sourceCharDelta: sourceCharsAfter - sourceCharsBefore,
        clearOutputs,
        outputsCleared,
        previousOutputCount,
        previousExecutionCount,
        previousBytes: rawBuffer.byteLength,
        bytes: Buffer.byteLength(output, 'utf-8'),
        previousSha256,
        sha256: resultSha256,
        expectedSha256,
      };

      if (!dryRun) {
        await atomicWriteFile(resolved, output, 'utf-8');
      }

      return this.makeResult(dryRun ? `Dry run succeeded: ${message}` : message, {
        startedAt,
        structured,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`NotebookEdit failed: ${errMsg}`);
    }
  }
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

function normalizeOptionalString(
  value: unknown,
  name: string,
): { value?: string; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  return { value };
}

function normalizeOptionalInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): { value?: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
  if (!Number.isInteger(value)) return { error: `${name} must be an integer` };
  if (value < min) return { error: `${name} must be at least ${min}` };
  if (value > max) return { error: `${name} must be ${max} or less` };
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

function normalizeEnum<T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T,
  defaultValue: T[number],
): { value: T[number]; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value !== 'string') return { error: `${name} must be a string` };
  if (!allowed.includes(value)) return { error: `${name} must be one of: ${allowed.join(', ')}` };
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function sourceToString(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

function applySourceFormat(source: string, previousSource: string | string[]): string | string[] {
  if (!Array.isArray(previousSource)) return source;
  if (source.length === 0) return [];
  return source.endsWith('\n')
    ? source.match(/.*\n|.+$/g) ?? []
    : [source];
}

function shouldCreateCellId(nb: NotebookData): boolean {
  return (nb.nbformat ?? 0) >= 4 || nb.cells.some(cell => typeof cell.id === 'string');
}

function createNotebookCellId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}
