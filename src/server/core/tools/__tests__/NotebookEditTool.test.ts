import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotebookEditTool } from '../builtin/NotebookEditTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string): ExecutionContext {
  return {
    sessionId: 'notebook-edit-session',
    agentId: 'notebook-edit-agent',
    workspace,
    userConfirmed: true,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-notebook-edit-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function notebook(cells: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    cells,
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
}

async function writeNotebook(file: string, data: Record<string, unknown>): Promise<string> {
  const raw = JSON.stringify(data, null, 1) + '\n';
  await writeFile(file, raw, 'utf-8');
  return raw;
}

async function readNotebook(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, 'utf-8'));
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('NotebookEditTool', () => {
  it('replaces a cell by id, preserves source array format, and reports structured metadata', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'analysis.ipynb');
    const raw = await writeNotebook(file, notebook([
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: ['# Intro\n'] },
      { id: 'calc', cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: ['x = 1\n', 'x\n'] },
    ]));

    const result = await new NotebookEditTool().execute(
      {
        notebook_path: file,
        cell_id: 'calc',
        new_source: 'x = 2\nx\n',
        expected_sha256: sha256(raw),
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      editMode: 'replace',
      cellIndex: 1,
      cellId: 'calc',
      cellType: 'code',
      beforeCellCount: 2,
      afterCellCount: 2,
      previousSha256: sha256(raw),
    });
    const updated = await readNotebook(file);
    expect(updated.cells[1].source).toEqual(['x = 2\n', 'x\n']);
    expect(updated.cells[1].outputs).toEqual([]);
  });

  it('clears stale code outputs by default when replacing source', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'analysis.ipynb');
    await writeNotebook(file, notebook([
      {
        id: 'calc',
        cell_type: 'code',
        metadata: {},
        execution_count: 7,
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'old result\n' }],
        source: 'x = 1\nx\n',
      },
    ]));

    const result = await new NotebookEditTool().execute(
      {
        notebook_path: file,
        cell_id: 'calc',
        new_source: 'x = 2\nx\n',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      editMode: 'replace',
      cellId: 'calc',
      cellType: 'code',
      clearOutputs: true,
      outputsCleared: true,
      previousOutputCount: 1,
      previousExecutionCount: 7,
    });
    const updated = await readNotebook(file);
    expect(updated.cells[0].source).toBe('x = 2\nx\n');
    expect(updated.cells[0].outputs).toEqual([]);
    expect(updated.cells[0].execution_count).toBeNull();
  });

  it('preserves code outputs when clear_outputs is false', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'analysis.ipynb');
    const output = { output_type: 'execute_result', data: { 'text/plain': '1' }, metadata: {}, execution_count: 3 };
    await writeNotebook(file, notebook([
      {
        id: 'calc',
        cell_type: 'code',
        metadata: {},
        execution_count: 3,
        outputs: [output],
        source: 'x = 1\n',
      },
    ]));

    const result = await new NotebookEditTool().execute(
      {
        notebook_path: file,
        cell_id: 'calc',
        new_source: 'x = 2\n',
        clear_outputs: false,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      editMode: 'replace',
      cellId: 'calc',
      clearOutputs: false,
      outputsCleared: false,
      previousOutputCount: 1,
      previousExecutionCount: 3,
    });
    const updated = await readNotebook(file);
    expect(updated.cells[0].source).toBe('x = 2\n');
    expect(updated.cells[0].outputs).toEqual([output]);
    expect(updated.cells[0].execution_count).toBe(3);
  });

  it('supports dry-run inserts without modifying the notebook', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'analysis.ipynb');
    const raw = await writeNotebook(file, notebook([
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Intro\n' },
    ]));

    const result = await new NotebookEditTool().execute(
      {
        notebook_path: file,
        edit_mode: 'insert',
        cell_type: 'markdown',
        new_source: '## Notes\n',
        dry_run: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Dry run succeeded');
    expect(result.structured).toMatchObject({
      editMode: 'insert',
      dryRun: true,
      beforeCellCount: 1,
      afterCellCount: 2,
      cellIndex: -1,
      cellType: 'markdown',
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe(raw);
  });

  it('uses expected_sha256 to prevent stale notebook edits', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'analysis.ipynb');
    const raw = await writeNotebook(file, notebook([
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Intro\n' },
    ]));
    const staleHash = sha256('older notebook\n');

    const result = await new NotebookEditTool().execute(
      {
        notebook_path: file,
        cell_id: 'intro',
        new_source: '# Changed\n',
        expected_sha256: staleHash,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('does not match expected_sha256');
    expect(result.structured).toMatchObject({
      expectedSha256: staleHash,
      previousSha256: sha256(raw),
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe(raw);
  });

  it('rejects invalid parameters instead of silently accepting ambiguous edits', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'analysis.ipynb');
    await writeNotebook(file, notebook([
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Intro\n' },
    ]));
    const tool = new NotebookEditTool();

    const badCellNumber = await tool.execute(
      { notebook_path: file, cell_number: 0.5, new_source: '# Changed\n' },
      ctx(workspace),
    );
    expect(badCellNumber.success).toBe(false);
    expect(badCellNumber.errorMessage).toContain('cell_number must be an integer');

    const badDryRun = await tool.execute(
      { notebook_path: file, dry_run: 'true', new_source: '# Changed\n' },
      ctx(workspace),
    );
    expect(badDryRun.success).toBe(false);
    expect(badDryRun.errorMessage).toContain('dry_run must be a boolean');

    const badClearOutputs = await tool.execute(
      { notebook_path: file, clear_outputs: 'false', new_source: '# Changed\n' },
      ctx(workspace),
    );
    expect(badClearOutputs.success).toBe(false);
    expect(badClearOutputs.errorMessage).toContain('clear_outputs must be a boolean');

    const ambiguousTarget = await tool.execute(
      { notebook_path: file, cell_id: 'intro', cell_number: 0, new_source: '# Changed\n' },
      ctx(workspace),
    );
    expect(ambiguousTarget.success).toBe(false);
    expect(ambiguousTarget.errorMessage).toContain('Specify either cell_id or cell_number');

    const missingId = await tool.execute(
      { notebook_path: file, cell_id: 'missing', new_source: '# Changed\n' },
      ctx(workspace),
    );
    expect(missingId.success).toBe(false);
    expect(missingId.errorMessage).toContain('Cell id not found');
  });

  it('deletes a cell by number and preserves surrounding cells', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'analysis.ipynb');
    await writeNotebook(file, notebook([
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Intro\n' },
      { id: 'scratch', cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: 'tmp = 1\n' },
      { id: 'summary', cell_type: 'markdown', metadata: {}, source: 'Done\n' },
    ]));

    const result = await new NotebookEditTool().execute(
      {
        notebook_path: file,
        edit_mode: 'delete',
        cell_number: 1,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      editMode: 'delete',
      cellIndex: 1,
      cellId: 'scratch',
      beforeCellCount: 3,
      afterCellCount: 2,
    });
    const updated = await readNotebook(file);
    expect(updated.cells.map((cell: any) => cell.id)).toEqual(['intro', 'summary']);
  });
});
