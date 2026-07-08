import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GrepTool } from '../builtin/GrepTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string, signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'grep-session',
    agentId: 'grep-agent',
    workspace,
    userConfirmed: true,
    signal,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-grep-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('GrepTool', () => {
  it('supports literal searches without treating regex characters as wildcards', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'sample.txt');
    await writeFile(file, [
      'exact user.*name token',
      'regex-like userXYZname token',
    ].join('\n'));

    const result = await new GrepTool().execute(
      {
        pattern: 'user.*name',
        path: workspace,
        output_mode: 'content',
        literal: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('exact user.*name token');
    expect(result.content).not.toContain('regex-like userXYZname token');
  });

  it('requires include_hidden before searching hidden files', async () => {
    const workspace = await makeWorkspace();
    const hidden = path.join(workspace, '.secret.txt');
    await writeFile(hidden, 'hidden-needle');

    const defaultResult = await new GrepTool().execute(
      { pattern: 'hidden-needle', path: workspace, literal: true },
      ctx(workspace),
    );
    expect(defaultResult.success).toBe(true);
    expect(defaultResult.content).toBe('(no matches)');

    const hiddenResult = await new GrepTool().execute(
      { pattern: 'hidden-needle', path: workspace, literal: true, include_hidden: true },
      ctx(workspace),
    );
    expect(hiddenResult.success).toBe(true);
    expect(hiddenResult.content).toContain(hidden);
  });

  it('returns a failure result for invalid regex patterns', async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, 'sample.txt'), 'anything');

    const result = await new GrepTool().execute(
      { pattern: '[', path: workspace },
      ctx(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/regex|pattern|parse/i);
  });

  it('rejects invalid numeric and boolean parameters instead of silently clamping', async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, 'sample.txt'), 'needle');
    const tool = new GrepTool();

    const badContext = await tool.execute(
      { pattern: 'needle', path: workspace, '-A': -1 },
      ctx(workspace),
    );
    expect(badContext.success).toBe(false);
    expect(badContext.errorMessage).toContain('-A must be at least 0');

    const badBoolean = await tool.execute(
      { pattern: 'needle', path: workspace, literal: 'true' },
      ctx(workspace),
    );
    expect(badBoolean.success).toBe(false);
    expect(badBoolean.errorMessage).toContain('literal must be a boolean');

    const badLimit = await tool.execute(
      { pattern: 'needle', path: workspace, head_limit: 999999 },
      ctx(workspace),
    );
    expect(badLimit.success).toBe(false);
    expect(badLimit.errorMessage).toContain('head_limit must be 5000 or less');
  });

  it('applies max_output_chars inside the tool and reports structured metadata', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'long.txt');
    await writeFile(file, Array.from({ length: 20 }, (_unused, index) => `needle ${index} ${'x'.repeat(40)}`).join('\n'));

    const result = await new GrepTool().execute(
      {
        pattern: 'needle',
        path: workspace,
        output_mode: 'content',
        literal: true,
        max_output_chars: 140,
        head_limit: 0,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.wasTruncated).toBe(true);
    expect(result.content).toContain('Grep output truncated at 140 characters');
    expect(result.content).not.toContain('needle 19');
    expect(result.structured).toMatchObject({
      outputMode: 'content',
      literal: true,
      maxOutputChars: 140,
      truncatedByChars: true,
      wasTruncated: true,
    });
  });

  it('reports cancellation immediately when the execution signal is already aborted', async () => {
    const workspace = await makeWorkspace();
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'sample.ts'), 'const needle = true;');
    const controller = new AbortController();
    controller.abort();

    const result = await new GrepTool().execute(
      { pattern: 'needle', path: workspace },
      ctx(workspace, controller.signal),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('cancelled by user');
  });

  it('includes file paths when searching a single file in content mode', async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, 'single.ts');
    await writeFile(file, 'export const singleNeedle = true;');

    const result = await new GrepTool().execute(
      { pattern: 'singleNeedle', path: file, output_mode: 'content' },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain(file);
    expect(result.content).toContain('singleNeedle');
  });
});
