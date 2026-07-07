// NotebookEditTool - edits Jupyter notebook (.ipynb) cells
// Supports replacing, inserting, and deleting cells by ID or index.
// RiskLevel: Safe (file edit, but limited to notebook cells).

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool } from '../Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { RiskLevel } from '../../../../shared/types/tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { atomicWriteFile, resolvePath } from './FileUtils.js';

interface NotebookCell {
  cell_type: 'code' | 'markdown';
  source: string;
  id?: string;
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
    return 'Replace, insert, or delete a single cell in a Jupyter notebook (.ipynb file). Use this instead of Write for notebook edits - Write would overwrite the entire file.';
  }

  prompt(): string {
    return '## NotebookEdit Usage\n' +
      'Edit cells in .ipynb Jupyter notebooks. Use this instead of Write or Edit for notebook files - those tools work on raw JSON, this works on the cell structure.\n\n' +
      '**Operations:** `replace` (default) - changes a cell\'s source. `insert` - adds a new cell after the given cell_id. `delete` - removes a cell.\n\n' +
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
      },
      required: ['notebook_path'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isDestructive(): boolean {
    return true;
  }

  workspacePathParams(): string[] {
    return ['notebook_path'];
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const notebookPath = params.notebook_path as string;
    const newSource = params.new_source as string;
    const cellId = params.cell_id as string | undefined;
    const cellNumber = params.cell_number as number | undefined;
    const cellType = (params.cell_type as 'code' | 'markdown') ?? 'code';
    const editMode = (params.edit_mode as 'replace' | 'insert' | 'delete') ?? 'replace';

    if (!notebookPath || typeof notebookPath !== 'string') {
      return this.makeError('notebook_path is required');
    }
    if (editMode !== 'delete' && (newSource === undefined || newSource === null)) {
      return this.makeError('new_source is required for replace and insert modes');
    }

    const startedAt = Date.now();

    try {
      const resolved = resolvePath(notebookPath, ctx.workspace);

      let raw: string;
      try {
        raw = await fs.readFile(resolved, 'utf-8');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.makeError(`Notebook not found: ${notebookPath}`);
        }
        throw err;
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

      // Find target cell index
      let targetIdx = -1;
      if (cellId) {
        targetIdx = nb.cells.findIndex((c) => c.id === cellId);
      } else if (cellNumber !== undefined && cellNumber >= 0) {
        targetIdx = cellNumber;
      } else {
        targetIdx = 0;
      }

      let message = '';

      switch (editMode) {
        case 'replace': {
          if (targetIdx < 0 || targetIdx >= nb.cells.length) {
            return this.makeError(
              `Cell index ${targetIdx} out of range. Notebook has ${nb.cells.length} cells.`
            );
          }
          const oldType = nb.cells[targetIdx].cell_type;
          nb.cells[targetIdx].source = newSource;
          message = `Replaced source of cell ${targetIdx} (${oldType}) in ${path.basename(resolved)}`;
          break;
        }

        case 'insert': {
          const newCell: NotebookCell = {
            cell_type: cellType ?? 'code',
            source: newSource ?? '',
          };
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
          nb.cells.splice(targetIdx, 1);
          message = `Deleted ${removed.cell_type} cell ${targetIdx} from ${path.basename(resolved)}`;
          break;
        }
      }

      await atomicWriteFile(resolved, JSON.stringify(nb, null, 1) + '\n', 'utf-8');

      return this.makeResult(message, { startedAt });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.makeError(`NotebookEdit failed: ${errMsg}`);
    }
  }
}
