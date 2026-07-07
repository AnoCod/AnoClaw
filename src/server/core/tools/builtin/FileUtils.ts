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
  const tmpPath = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, content, encoding);
    await fs.rename(tmpPath, filePath);
  } catch (err) {
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
