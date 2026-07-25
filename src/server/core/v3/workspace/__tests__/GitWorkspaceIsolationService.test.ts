import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitWorkspaceIsolationService,
  type MissionWorkspace,
} from '../GitWorkspaceIsolationService.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe('GitWorkspaceIsolationService', () => {
  it('falls back to leases outside a Git repository', async () => {
    const root = await temporaryRoot();
    const service = new GitWorkspaceIsolationService({
      dataRoot: path.join(root, 'managed'),
    });
    await expect(service.prepareMission({
      workId: 'work-1',
      missionId: 'mission-1',
      workspaceRoot: path.join(root, 'plain'),
    })).resolves.toMatchObject({
      mode: 'lease',
      reason: 'not_git_repository',
    });
  });

  it('copies a dirty baseline into isolated task worktrees', async () => {
    const root = await temporaryRoot();
    const repository = path.join(root, 'repository');
    await initRepository(repository);
    await fsp.writeFile(path.join(repository, 'tracked.txt'), 'dirty\n', 'utf-8');
    await fsp.writeFile(path.join(repository, 'untracked.txt'), 'new\n', 'utf-8');

    const service = new GitWorkspaceIsolationService({
      dataRoot: path.join(root, 'managed'),
    });
    const prepared = await service.prepareMission({
      workId: 'work-1',
      missionId: 'mission-1',
      workspaceRoot: repository,
    });
    expect(prepared.mode).toBe('git-worktree');
    if (prepared.mode !== 'git-worktree') return;
    expect(await fsp.readFile(
      path.join(prepared.integrationPath, 'tracked.txt'),
      'utf-8',
    )).toMatch(/^dirty\r?\n$/);
    expect(await fsp.readFile(
      path.join(prepared.integrationPath, 'untracked.txt'),
      'utf-8',
    )).toMatch(/^new\r?\n$/);

    const task = await service.prepareTask(prepared, 'task-1');
    expect(await fsp.readFile(
      path.join(task.worktreePath, 'tracked.txt'),
      'utf-8',
    )).toMatch(/^dirty\r?\n$/);
  });

  it('commits and integrates a task branch without writing the source checkout', async () => {
    const root = await temporaryRoot();
    const repository = path.join(root, 'repository');
    await initRepository(repository);
    const service = new GitWorkspaceIsolationService({
      dataRoot: path.join(root, 'managed'),
    });
    const prepared = await service.prepareMission({
      workId: 'work-2',
      missionId: 'mission-2',
      workspaceRoot: repository,
    }) as MissionWorkspace;
    const task = await service.prepareTask(prepared, 'task-2');
    await fsp.writeFile(path.join(task.worktreePath, 'result.txt'), 'result\n', 'utf-8');
    const committed = await service.commitTask(task, 'task result');
    expect(committed.changed).toBe(true);
    await expect(service.integrateTask(prepared, task)).resolves.toMatchObject({
      status: 'merged',
    });
    await expect(
      fsp.access(path.join(repository, 'result.txt')),
    ).rejects.toThrow();
    expect(await fsp.readFile(
      path.join(prepared.integrationPath, 'result.txt'),
      'utf-8',
    )).toMatch(/^result\r?\n$/);
  });

  it('reports integration conflicts instead of overwriting task changes', async () => {
    const root = await temporaryRoot();
    const repository = path.join(root, 'repository');
    await initRepository(repository);
    const service = new GitWorkspaceIsolationService({
      dataRoot: path.join(root, 'managed'),
    });
    const prepared = await service.prepareMission({
      workId: 'work-3',
      missionId: 'mission-3',
      workspaceRoot: repository,
    }) as MissionWorkspace;
    const first = await service.prepareTask(prepared, 'task-a');
    const second = await service.prepareTask(prepared, 'task-b');
    await fsp.writeFile(path.join(first.worktreePath, 'tracked.txt'), 'first\n', 'utf-8');
    await fsp.writeFile(path.join(second.worktreePath, 'tracked.txt'), 'second\n', 'utf-8');
    await service.commitTask(first, 'first task');
    await service.commitTask(second, 'second task');
    await expect(service.integrateTask(prepared, first)).resolves.toMatchObject({
      status: 'merged',
    });
    await expect(service.integrateTask(prepared, second)).resolves.toEqual({
      status: 'conflict',
      conflictingPaths: ['tracked.txt'],
    });
    expect(await fsp.readFile(
      path.join(prepared.integrationPath, 'tracked.txt'),
      'utf-8',
    )).toMatch(/^first\r?\n$/);
  });

  it('detects source-checkout changes made after the mission baseline', async () => {
    const root = await temporaryRoot();
    const repository = path.join(root, 'repository');
    await initRepository(repository);
    await fsp.writeFile(path.join(repository, 'tracked.txt'), 'initial dirty\n', 'utf-8');
    const service = new GitWorkspaceIsolationService({
      dataRoot: path.join(root, 'managed'),
    });
    const prepared = await service.prepareMission({
      workId: 'work-4',
      missionId: 'mission-4',
      workspaceRoot: repository,
    }) as MissionWorkspace;
    await expect(service.compareSourceWithBaseline(prepared)).resolves.toEqual([]);
    await fsp.writeFile(path.join(repository, 'tracked.txt'), 'user changed it\n', 'utf-8');
    await expect(service.compareSourceWithBaseline(prepared)).resolves.toEqual([
      'tracked.txt',
    ]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-v3-worktree-'));
  temporaryRoots.push(root);
  return root;
}

async function initRepository(repository: string): Promise<void> {
  await fsp.mkdir(repository, { recursive: true });
  await git(repository, ['init']);
  await git(repository, ['config', 'user.name', 'AnoClaw Test']);
  await git(repository, ['config', 'user.email', 'test@anoclaw.invalid']);
  await fsp.writeFile(path.join(repository, 'tracked.txt'), 'base\n', 'utf-8');
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'baseline']);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}
