import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../builtin/FileUtils.js';

let tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-file-utils-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('FileUtils atomicWriteFile', () => {
  it('rejects directory targets without leaving temp files behind', async () => {
    const workspace = await makeWorkspace();
    const target = path.join(workspace, 'target-dir');
    await mkdir(target);

    await expect(atomicWriteFile(target, 'content\n')).rejects.toThrow('target is a directory');

    const entries = await readdir(workspace);
    expect(entries.filter(entry => entry.startsWith('.') && entry.endsWith('.tmp'))).toEqual([]);
  });

  const itPreservesMode = process.platform === 'win32' ? it.skip : it;
  itPreservesMode('preserves existing file permission bits on overwrite', async () => {
    const workspace = await makeWorkspace();
    const target = path.join(workspace, 'script.sh');
    await writeFile(target, '#!/bin/sh\necho old\n');
    await chmod(target, 0o755);

    await atomicWriteFile(target, '#!/bin/sh\necho new\n');

    await expect(readFile(target, 'utf-8')).resolves.toBe('#!/bin/sh\necho new\n');
    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o755);
  });
});
