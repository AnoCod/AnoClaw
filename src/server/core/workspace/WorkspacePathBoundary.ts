import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspacePathResolution {
  workspacePath: string;
  candidatePath: string;
  relativePath: string;
}

/**
 * Resolve existing path segments through symlinks/junctions while still
 * supporting a not-yet-created leaf. This makes boundary checks useful for
 * both reads and writes.
 */
export function canonicalizePath(candidate: string): string {
  const absolute = path.resolve(candidate);
  const missing: string[] = [];
  let current = absolute;

  while (true) {
    try {
      fs.lstatSync(current);
      const real = fs.realpathSync.native(current);
      return path.resolve(real, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function resolveWorkspacePath(workspace: string, candidate: string): WorkspacePathResolution {
  const workspaceAbsolute = path.resolve(workspace);
  const candidateAbsolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspaceAbsolute, candidate);
  const workspacePath = canonicalizePath(workspaceAbsolute);
  const candidatePath = canonicalizePath(candidateAbsolute);
  const relativePath = path.relative(workspacePath, candidatePath);

  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(`Path resolves outside workspace: ${candidate}`);
  }

  return { workspacePath, candidatePath, relativePath: relativePath || '.' };
}
