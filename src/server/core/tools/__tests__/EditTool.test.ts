import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditTool } from '../builtin/EditTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string, signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'edit-session',
    agentId: 'edit-agent',
    workspace,
    userConfirmed: true,
    signal,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-edit-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('EditTool', () => {
  it('replaces a unique string and reports structured metadata', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.ts');
    await writeFile(file, 'export const value = 1;\n');

    const result = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'value = 1',
        new_string: 'value = 2',
        expected_replacements: 1,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.structured).toMatchObject({
      replacements: 1,
      dryRun: false,
      firstLine: 1,
      lastLine: 1,
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe('export const value = 2;\n');
  });

  it('rejects invalid typed parameters instead of treating strings as truthy flags', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.ts');
    await writeFile(file, 'needle\nneedle\n');
    const tool = new EditTool();

    const badReplaceAll = await tool.execute(
      {
        file_path: file,
        old_string: 'needle',
        new_string: 'thread',
        replace_all: 'true',
      },
      ctx(workspace),
    );
    expect(badReplaceAll.success).toBe(false);
    expect(badReplaceAll.errorMessage).toContain('replace_all must be a boolean');

    const badDryRun = await tool.execute(
      {
        file_path: file,
        old_string: 'needle',
        new_string: 'thread',
        dry_run: 'true',
      },
      ctx(workspace),
    );
    expect(badDryRun.success).toBe(false);
    expect(badDryRun.errorMessage).toContain('dry_run must be a boolean');

    const badExpected = await tool.execute(
      {
        file_path: file,
        old_string: 'needle',
        new_string: 'thread',
        replace_all: true,
        expected_replacements: 1.5,
      },
      ctx(workspace),
    );
    expect(badExpected.success).toBe(false);
    expect(badExpected.errorMessage).toContain('expected_replacements must be an integer');

    const badNewString = await tool.execute(
      {
        file_path: file,
        old_string: 'needle',
        new_string: 42,
      },
      ctx(workspace),
    );
    expect(badNewString.success).toBe(false);
    expect(badNewString.errorMessage).toContain('new_string must be a string');

    const blankPath = await tool.execute(
      {
        file_path: '   ',
        old_string: 'needle',
        new_string: 'thread',
      },
      ctx(workspace),
    );
    expect(blankPath.success).toBe(false);
    expect(blankPath.errorMessage).toContain('file_path must not be empty');

    const unexpectedParam = await tool.execute(
      {
        file_path: file,
        old_string: 'needle',
        new_string: 'thread',
        mode: 'append',
      },
      ctx(workspace),
    );
    expect(unexpectedParam.success).toBe(false);
    expect(unexpectedParam.errorMessage).toContain('Unexpected parameter: "mode"');

    await expect(readFile(file, 'utf-8')).resolves.toBe('needle\nneedle\n');
  });

  it('returns line diagnostics when old_string is not unique', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.ts');
    await writeFile(file, [
      'const status = "pending";',
      'const status = "pending";',
    ].join('\n'));

    const result = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'status = "pending"',
        new_string: 'status = "done"',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Found 2 occurrences');
    expect(result.errorMessage).toContain('line 1');
    expect(result.errorMessage).toContain('line 2');
  });

  it('fails without writing when expected_replacements does not match', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'needle\nneedle\n');

    const result = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'needle',
        new_string: 'thread',
        replace_all: true,
        expected_replacements: 3,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('expected 3, would replace 2');
    await expect(readFile(file, 'utf-8')).resolves.toBe('needle\nneedle\n');
  });

  it('uses expected_sha256 to prevent stale edits and reports output hashes', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    const original = 'left right\n';
    await writeFile(file, original);

    const staleHash = sha256('older content\n');
    const staleResult = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'left',
        new_string: 'up',
        expected_sha256: staleHash,
      },
      ctx(workspace),
    );

    expect(staleResult.success).toBe(false);
    expect(staleResult.errorMessage).toContain('does not match expected_sha256');
    expect(staleResult.structured).toMatchObject({
      expectedSha256: staleHash,
      previousSha256: sha256(original),
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe(original);

    const dryRun = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'left',
        new_string: 'up',
        expected_sha256: sha256(original),
        dry_run: true,
      },
      ctx(workspace),
    );

    expect(dryRun.success).toBe(true);
    expect(dryRun.structured).toMatchObject({
      dryRun: true,
      previousSha256: sha256(original),
      sha256: sha256('up right\n'),
      bytes: Buffer.byteLength('up right\n', 'utf-8'),
      previousBytes: Buffer.byteLength(original, 'utf-8'),
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe(original);
  });

  it('allows replacing text with an empty string for deletion', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'left middle right\n');

    const result = await new EditTool().execute(
      {
        file_path: file,
        old_string: ' middle',
        new_string: '',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    await expect(readFile(file, 'utf-8')).resolves.toBe('left right\n');
  });

  it('matches LF input against CRLF files and preserves CRLF line endings', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'alpha\r\nbeta\r\ngamma\r\n');

    const result = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'alpha\nbeta',
        new_string: 'alpha\nBETA',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Line endings normalized');
    await expect(readFile(file, 'utf-8')).resolves.toBe('alpha\r\nBETA\r\ngamma\r\n');
  });

  it('supports dry_run without modifying the file', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'left right\n');

    const result = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'left',
        new_string: 'up',
        dry_run: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Dry run succeeded');
    expect(result.structured).toMatchObject({
      replacements: 1,
      dryRun: true,
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe('left right\n');
  });

  it('refuses to edit binary files', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'blob.bin');
    await writeFile(file, Buffer.from([0, 1, 2, 3, 255]));

    const result = await new EditTool().execute(
      {
        file_path: file,
        old_string: 'needle',
        new_string: 'x',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('binary file');
  });
});
