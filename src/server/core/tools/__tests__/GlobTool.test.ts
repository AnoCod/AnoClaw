import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobTool } from '../builtin/GlobTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string): ExecutionContext {
  return {
    sessionId: 'glob-session',
    agentId: 'glob-agent',
    workspace,
    userConfirmed: true,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-glob-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('GlobTool', () => {
  it('finds matches after many non-matching files instead of only searching the first window', async () => {
    const workspace = await makeWorkspace();
    for (let i = 0; i < 450; i++) {
      await writeFile(path.join(workspace, `a-${String(i).padStart(3, '0')}.txt`), 'noise');
    }
    const lateDir = path.join(workspace, 'z-late');
    await mkdir(lateDir);
    const target = path.join(lateDir, 'target.ts');
    await writeFile(target, 'export const found = true;');

    const result = await new GlobTool().execute({ pattern: '**/*.ts', path: workspace }, ctx(workspace));

    expect(result.success).toBe(true);
    expect(result.content).toContain(target);
  });

  it('keeps the newest matching files when max_results is smaller than total matches', async () => {
    const workspace = await makeWorkspace();
    const oldFile = path.join(workspace, 'old.ts');
    const midFile = path.join(workspace, 'mid.ts');
    const newFile = path.join(workspace, 'new.ts');
    await writeFile(oldFile, 'old');
    await writeFile(midFile, 'mid');
    await writeFile(newFile, 'new');

    const oldDate = new Date('2024-01-01T00:00:00Z');
    const midDate = new Date('2025-01-01T00:00:00Z');
    const newDate = new Date('2026-01-01T00:00:00Z');
    await utimes(oldFile, oldDate, oldDate);
    await utimes(midFile, midDate, midDate);
    await utimes(newFile, newDate, newDate);

    const result = await new GlobTool().execute(
      { pattern: '**/*.ts', path: workspace, max_results: 2 },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain(newFile);
    expect(result.content).toContain(midFile);
    expect(result.content).not.toContain(oldFile);
    expect(result.content).toContain('matching files omitted');
    expect(result.wasTruncated).toBe(true);
  });
});
