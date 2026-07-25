import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface GitInspection {
  isGitRepository: boolean;
  workspaceRoot: string;
  repositoryRoot?: string;
  head?: string;
  dirtyPaths: string[];
}

export interface BaselineFile {
  relativePath: string;
  state: 'present' | 'deleted';
  sha256?: string;
}

export interface MissionWorkspace {
  mode: 'git-worktree';
  workId: string;
  missionId: string;
  sourceWorkspaceRoot: string;
  repositoryRoot: string;
  baselineHead: string;
  baselineFiles: BaselineFile[];
  integrationBranch: string;
  integrationPath: string;
}

export interface LeaseWorkspaceFallback {
  mode: 'lease';
  workspaceRoot: string;
  reason: 'not_git_repository' | 'git_unavailable';
}

export type PreparedMissionWorkspace = MissionWorkspace | LeaseWorkspaceFallback;

export interface TaskWorkspace {
  taskId: string;
  branch: string;
  worktreePath: string;
  integrationBranch: string;
}

export type IntegrationResult =
  | { status: 'merged'; commit: string }
  | { status: 'conflict'; conflictingPaths: string[] };

export interface GitWorkspaceIsolationOptions {
  dataRoot?: string;
  gitExecutable?: string;
}

/**
 * Creates task-local Git worktrees below AnoClaw's data directory.
 *
 * The user's checkout is only inspected and snapshotted. Task work happens in
 * isolated branches; integration conflicts are surfaced instead of resolved by
 * overwriting either side.
 */
export class GitWorkspaceIsolationService {
  readonly dataRoot: string;
  private readonly gitExecutable: string;

  constructor(options: GitWorkspaceIsolationOptions = {}) {
    this.dataRoot = path.resolve(
      options.dataRoot ?? path.join('data', 'v3', 'worktrees'),
    );
    this.gitExecutable = options.gitExecutable ?? 'git';
  }

  async inspect(workspaceRoot: string): Promise<GitInspection> {
    const requestedRoot = path.resolve(workspaceRoot);
    try {
      const repositoryRoot = path.resolve(
        (await this.git(requestedRoot, ['rev-parse', '--show-toplevel'])).trim(),
      );
      const head = (await this.git(repositoryRoot, ['rev-parse', 'HEAD'])).trim();
      const status = await this.git(repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);
      return {
        isGitRepository: true,
        workspaceRoot: requestedRoot,
        repositoryRoot,
        head,
        dirtyPaths: parsePorcelainPaths(status),
      };
    } catch {
      return {
        isGitRepository: false,
        workspaceRoot: requestedRoot,
        dirtyPaths: [],
      };
    }
  }

  async prepareMission(input: {
    workId: string;
    missionId: string;
    workspaceRoot: string;
  }): Promise<PreparedMissionWorkspace> {
    assertSafeId(input.workId, 'workId');
    assertSafeId(input.missionId, 'missionId');
    const inspection = await this.inspect(input.workspaceRoot);
    if (
      !inspection.isGitRepository
      || !inspection.repositoryRoot
      || !inspection.head
    ) {
      return {
        mode: 'lease',
        workspaceRoot: inspection.workspaceRoot,
        reason: inspection.isGitRepository ? 'git_unavailable' : 'not_git_repository',
      };
    }

    const missionRoot = this.missionRoot(input.workId, input.missionId);
    const integrationPath = path.join(missionRoot, 'integration');
    const integrationBranch = branchName(input.workId, input.missionId, 'integration');
    await fsp.mkdir(missionRoot, { recursive: true });
    await this.addWorktree(
      inspection.repositoryRoot,
      integrationPath,
      integrationBranch,
      inspection.head,
    );

    const baselineFiles = await snapshotDirtyFiles(
      inspection.repositoryRoot,
      integrationPath,
      inspection.dirtyPaths,
    );
    await writeJsonAtomic(path.join(missionRoot, 'baseline.json'), {
      schemaVersion: 3,
      workId: input.workId,
      missionId: input.missionId,
      sourceWorkspaceRoot: inspection.repositoryRoot,
      baselineHead: inspection.head,
      baselineFiles,
      createdAt: new Date().toISOString(),
    });

    return {
      mode: 'git-worktree',
      workId: input.workId,
      missionId: input.missionId,
      sourceWorkspaceRoot: inspection.workspaceRoot,
      repositoryRoot: inspection.repositoryRoot,
      baselineHead: inspection.head,
      baselineFiles,
      integrationBranch,
      integrationPath,
    };
  }

  async prepareTask(
    mission: MissionWorkspace,
    taskId: string,
  ): Promise<TaskWorkspace> {
    assertSafeId(taskId, 'taskId');
    const worktreePath = path.join(
      this.missionRoot(mission.workId, mission.missionId),
      'tasks',
      taskId,
    );
    const branch = branchName(mission.workId, mission.missionId, `task-${taskId}`);
    await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
    await this.addWorktree(
      mission.integrationPath,
      worktreePath,
      branch,
      mission.integrationBranch,
    );
    await snapshotDirtyFiles(
      mission.integrationPath,
      worktreePath,
      mission.baselineFiles.map((file) => file.relativePath),
    );
    return {
      taskId,
      branch,
      worktreePath,
      integrationBranch: mission.integrationBranch,
    };
  }

  async commitTask(
    task: TaskWorkspace,
    message: string,
  ): Promise<{ commit: string; changed: boolean }> {
    await this.git(task.worktreePath, ['add', '-A']);
    const staged = await this.git(task.worktreePath, ['diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      const commit = (await this.git(task.worktreePath, ['rev-parse', 'HEAD'])).trim();
      return { commit, changed: false };
    }
    await this.git(task.worktreePath, [
      '-c',
      'user.name=AnoClaw',
      '-c',
      'user.email=local@anoclaw.invalid',
      'commit',
      '-m',
      message.trim() || `AnoClaw task ${task.taskId}`,
    ]);
    const commit = (await this.git(task.worktreePath, ['rev-parse', 'HEAD'])).trim();
    return { commit, changed: true };
  }

  async integrateTask(
    mission: MissionWorkspace,
    task: TaskWorkspace,
  ): Promise<IntegrationResult> {
    try {
      await this.git(mission.integrationPath, [
        '-c',
        'user.name=AnoClaw',
        '-c',
        'user.email=local@anoclaw.invalid',
        'merge',
        '--no-ff',
        '--no-edit',
        task.branch,
      ]);
      const commit = (
        await this.git(mission.integrationPath, ['rev-parse', 'HEAD'])
      ).trim();
      return { status: 'merged', commit };
    } catch {
      const conflictingPaths = (
        await this.git(mission.integrationPath, [
          'diff',
          '--name-only',
          '--diff-filter=U',
        ]).catch(() => '')
      )
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      await this.git(mission.integrationPath, ['merge', '--abort']).catch(() => '');
      return { status: 'conflict', conflictingPaths };
    }
  }

  async compareSourceWithBaseline(
    mission: MissionWorkspace,
  ): Promise<string[]> {
    const changed: string[] = [];
    for (const baseline of mission.baselineFiles) {
      const source = path.join(mission.repositoryRoot, baseline.relativePath);
      const current = await hashFile(source);
      if (
        (baseline.state === 'deleted' && current != null)
        || (baseline.state === 'present' && current !== baseline.sha256)
      ) {
        changed.push(baseline.relativePath);
      }
    }
    return changed.sort();
  }

  private async addWorktree(
    repositoryRoot: string,
    worktreePath: string,
    branch: string,
    startPoint: string,
  ): Promise<void> {
    this.assertManagedPath(worktreePath);
    try {
      await fsp.access(path.join(worktreePath, '.git'));
      return;
    } catch {
      // The worktree does not exist yet.
    }
    await this.git(repositoryRoot, [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      startPoint,
    ]);
  }

  private missionRoot(workId: string, missionId: string): string {
    const root = path.resolve(this.dataRoot, workId, missionId);
    this.assertManagedPath(root);
    return root;
  }

  private assertManagedPath(candidate: string): void {
    const relative = path.relative(this.dataRoot, path.resolve(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Worktree path escapes AnoClaw data root: ${candidate}`);
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync(this.gitExecutable, args, {
      cwd,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  }
}

function parsePorcelainPaths(raw: string): string[] {
  const records = raw.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    if (firstPath) paths.push(firstPath);
    if ((status.includes('R') || status.includes('C')) && records[index + 1]) {
      paths.push(records[index + 1] as string);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

async function snapshotDirtyFiles(
  sourceRoot: string,
  destinationRoot: string,
  dirtyPaths: string[],
): Promise<BaselineFile[]> {
  const files: BaselineFile[] = [];
  for (const relativePath of dirtyPaths) {
    const source = safeChild(sourceRoot, relativePath);
    const destination = safeChild(destinationRoot, relativePath);
    let stat;
    try {
      stat = await fsp.lstat(source);
    } catch {
      await fsp.rm(destination, { force: true, recursive: true });
      files.push({ relativePath, state: 'deleted' });
      continue;
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(source);
      await fsp.rm(destination, { force: true, recursive: true });
      await fsp.symlink(linkTarget, destination);
      files.push({
        relativePath,
        state: 'present',
        sha256: sha256(`symlink:${linkTarget}`),
      });
    } else if (stat.isFile()) {
      await fsp.copyFile(source, destination);
      files.push({
        relativePath,
        state: 'present',
        sha256: await hashFile(source) ?? sha256(''),
      });
    }
  }
  return files;
}

function safeChild(parent: string, relativePath: string): string {
  const candidate = path.resolve(parent, relativePath);
  const relative = path.relative(path.resolve(parent), candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return candidate;
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    return sha256(await fsp.readFile(filePath));
  } catch {
    return null;
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function branchName(workId: string, missionId: string, suffix: string): string {
  return `anoclaw/${workId}/${missionId}/${suffix}`;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} contains unsafe characters.`);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await fsp.rename(temporary, filePath);
}
