import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WriteTool } from '../builtin/WriteTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string, signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'write-session',
    agentId: 'write-agent',
    workspace,
    userConfirmed: true,
    signal,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-write-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('WriteTool', () => {
  it('creates a new file and reports structured metadata', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'nested', 'sample.txt');

    const result = await new WriteTool().execute(
      {
        file_path: file,
        content: 'hello AnoClaw\n',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Successfully created');
    expect(result.structured).toMatchObject({
      created: true,
      overwritten: false,
      dryRun: false,
      noOp: false,
      chars: 'hello AnoClaw\n'.length,
      bytes: Buffer.byteLength('hello AnoClaw\n', 'utf-8'),
      sha256: sha256('hello AnoClaw\n'),
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe('hello AnoClaw\n');
  });

  it('returns no-op metadata when content is already identical', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'same content\n');

    const result = await new WriteTool().execute(
      {
        file_path: file,
        content: 'same content\n',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('No changes needed');
    expect(result.structured).toMatchObject({
      created: false,
      overwritten: false,
      dryRun: false,
      noOp: true,
      previousSha256: sha256('same content\n'),
      sha256: sha256('same content\n'),
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe('same content\n');
  });

  it('refuses to overwrite an existing file when create_only is true', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'original\n');

    const result = await new WriteTool().execute(
      {
        file_path: file,
        content: 'replacement\n',
        create_only: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('create_only=true');
    expect(result.structured).toMatchObject({
      existed: true,
      createOnly: true,
      previousSha256: sha256('original\n'),
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe('original\n');
  });

  it('refuses to write when expected_sha256 does not match the current file', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, 'current\n');

    const result = await new WriteTool().execute(
      {
        file_path: file,
        content: 'replacement\n',
        expected_sha256: sha256('stale\n'),
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('current file SHA-256 does not match');
    expect(result.errorMessage).toContain(sha256('current\n'));
    expect(result.structured).toMatchObject({
      expectedSha256: sha256('stale\n'),
      previousSha256: sha256('current\n'),
    });
    await expect(readFile(file, 'utf-8')).resolves.toBe('current\n');
  });

  it('dry-runs a create without writing the file', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'planned.txt');

    const result = await new WriteTool().execute(
      {
        file_path: file,
        content: 'planned\n',
        dry_run: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Dry run succeeded');
    expect(result.structured).toMatchObject({
      created: true,
      overwritten: false,
      dryRun: true,
      noOp: false,
      sha256: sha256('planned\n'),
    });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects non-boolean safety flags instead of silently writing', async () => {
    const workspace = await makeWorkspace();
    const existing = path.join(workspace, 'existing.txt');
    await writeFile(existing, 'original\n');

    const badCreateOnly = await new WriteTool().execute(
      {
        file_path: existing,
        content: 'replacement\n',
        create_only: 'true',
      },
      ctx(workspace),
    );

    expect(badCreateOnly.success).toBe(false);
    expect(badCreateOnly.errorMessage).toContain('create_only must be a boolean');
    await expect(readFile(existing, 'utf-8')).resolves.toBe('original\n');

    const dryRunTarget = path.join(workspace, 'dry-run-string.txt');
    const badDryRun = await new WriteTool().execute(
      {
        file_path: dryRunTarget,
        content: 'should not exist\n',
        dry_run: 'true',
      },
      ctx(workspace),
    );

    expect(badDryRun.success).toBe(false);
    expect(badDryRun.errorMessage).toContain('dry_run must be a boolean');
    await expect(stat(dryRunTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const blankPath = await new WriteTool().execute(
      {
        file_path: '   ',
        content: 'should not be written\n',
      },
      ctx(workspace),
    );

    expect(blankPath.success).toBe(false);
    expect(blankPath.errorMessage).toContain('file_path must not be empty');

    const unexpectedTarget = path.join(workspace, 'unexpected.txt');
    const unexpectedParam = await new WriteTool().execute(
      {
        file_path: unexpectedTarget,
        content: 'should not exist\n',
        encoding: 'utf16le',
      },
      ctx(workspace),
    );

    expect(unexpectedParam.success).toBe(false);
    expect(unexpectedParam.errorMessage).toContain('Unexpected parameter: "encoding"');
    await expect(stat(unexpectedTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to write to an existing directory path', async () => {
    const workspace = await makeWorkspace();
    const dir = path.join(workspace, 'target-dir');
    await mkdir(dir);

    const result = await new WriteTool().execute(
      {
        file_path: dir,
        content: 'not a file\n',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('target is a directory');
  });

  it('refuses to overwrite an existing binary file', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'blob.bin');
    const original = Buffer.from([0, 1, 2, 3, 255]);
    await writeFile(file, original);

    const result = await new WriteTool().execute(
      {
        file_path: file,
        content: 'replacement text\n',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Refusing to overwrite binary file');
    expect(result.structured).toMatchObject({
      existed: true,
      previousBytes: original.length,
    });
    await expect(readFile(file)).resolves.toEqual(original);
  });

  it('rejects NUL content as binary data', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'blob.txt');

    const result = await new WriteTool().execute(
      {
        file_path: file,
        content: 'text\u0000binary',
      },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('binary/NUL content');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function sha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf-8')).digest('hex');
}
