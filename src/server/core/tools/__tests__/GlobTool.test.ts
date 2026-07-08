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
  it('rejects invalid parameters instead of silently correcting them', async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, 'main.ts'), 'export {};');
    const tool = new GlobTool();

    const badMax = await tool.execute(
      { pattern: '**/*.ts', path: workspace, max_results: 0 },
      ctx(workspace),
    );
    expect(badMax.success).toBe(false);
    expect(badMax.errorMessage).toContain('max_results must be at least 1');

    const badBoolean = await tool.execute(
      { pattern: '**/*.ts', path: workspace, include_hidden: 'true' },
      ctx(workspace),
    );
    expect(badBoolean.success).toBe(false);
    expect(badBoolean.errorMessage).toContain('include_hidden must be a boolean');

    const badExclude = await tool.execute(
      { pattern: '**/*.ts', path: workspace, exclude: 'dist/**' },
      ctx(workspace),
    );
    expect(badExclude.success).toBe(false);
    expect(badExclude.errorMessage).toContain('exclude must be an array');

    const badPath = await tool.execute(
      { pattern: '**/*.ts', path: 'undefined' },
      ctx(workspace),
    );
    expect(badPath.success).toBe(false);
    expect(badPath.errorMessage).toContain('path must be omitted');
  });

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

  it('skips hidden paths and node_modules by default while allowing explicit opt-in', async () => {
    const workspace = await makeWorkspace();
    const visible = path.join(workspace, 'src', 'main.ts');
    const hidden = path.join(workspace, '.config', 'secret.ts');
    const dependency = path.join(workspace, 'node_modules', 'pkg', 'index.ts');
    await mkdir(path.dirname(visible), { recursive: true });
    await mkdir(path.dirname(hidden), { recursive: true });
    await mkdir(path.dirname(dependency), { recursive: true });
    await writeFile(visible, 'export const visible = true;');
    await writeFile(hidden, 'export const hidden = true;');
    await writeFile(dependency, 'export const dependency = true;');

    const defaultResult = await new GlobTool().execute(
      { pattern: '**/*.ts', path: workspace },
      ctx(workspace),
    );

    expect(defaultResult.success).toBe(true);
    expect(defaultResult.content).toContain(visible);
    expect(defaultResult.content).not.toContain(hidden);
    expect(defaultResult.content).not.toContain(dependency);
    expect(defaultResult.structured).toMatchObject({
      includeHidden: false,
      includeNodeModules: false,
      skippedHidden: 1,
      skippedNodeModules: 1,
    });

    const includedResult = await new GlobTool().execute(
      {
        pattern: '**/*.ts',
        path: workspace,
        include_hidden: true,
        include_node_modules: true,
      },
      ctx(workspace),
    );

    expect(includedResult.success).toBe(true);
    expect(includedResult.content).toContain(visible);
    expect(includedResult.content).toContain(hidden);
    expect(includedResult.content).toContain(dependency);
    expect(includedResult.structured).toMatchObject({
      includeHidden: true,
      includeNodeModules: true,
      resultCount: 3,
      totalMatches: 3,
    });
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

  it('applies exclude and max_output_chars with structured truncation metadata', async () => {
    const workspace = await makeWorkspace();
    const keptDir = path.join(workspace, 'kept');
    const ignoredDir = path.join(workspace, 'ignored');
    await mkdir(keptDir);
    await mkdir(ignoredDir);
    const ignored = path.join(ignoredDir, 'drop.ts');
    await writeFile(ignored, 'export const drop = true;');

    for (let i = 0; i < 12; i++) {
      await writeFile(path.join(keptDir, `file-${i}.ts`), `export const file${i} = true;`);
    }

    const result = await new GlobTool().execute(
      {
        pattern: '**/*.ts',
        path: workspace,
        exclude: ['ignored/**'],
        max_output_chars: 140,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Glob output truncated at 140 characters');
    expect(result.content).not.toContain(ignored);
    expect(result.wasTruncated).toBe(true);
    expect(result.structured).toMatchObject({
      exclude: ['ignored/**'],
      maxOutputChars: 140,
      totalMatches: 12,
      skippedExcluded: 1,
      truncatedByChars: true,
      wasTruncated: true,
    });
  });
});
