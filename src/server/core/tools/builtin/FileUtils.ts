// FileUtils - shared atomic file operations for tools
// Write-tmp-rename pattern prevents partial writes on crash.

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * Write content to a file atomically: write to a temp file in the same
 * directory, then rename into place. Prevents partial/corrupt writes on crash.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8',
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const existingMode = await getExistingFileMode(filePath);
  const tmpPath = path.join(dir, `.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(tmpPath, 'wx', existingMode ?? 0o666);
    await handle.writeFile(content, { encoding });
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (existingMode !== undefined) {
      await fs.chmod(tmpPath, existingMode);
    }

    await fs.rename(tmpPath, filePath);
    await fsyncDirectoryBestEffort(dir);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    // Clean up temp file on failure
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Resolve a file path - absolute paths pass through, relative paths are
 * resolved against the workspace directory.
 */
export function resolvePath(filePath: string, workspace: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
}

async function getExistingFileMode(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      throw new Error(`Cannot write file because target is a directory: ${filePath}`);
    }
    return stat.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

async function fsyncDirectoryBestEffort(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems.
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }
}
