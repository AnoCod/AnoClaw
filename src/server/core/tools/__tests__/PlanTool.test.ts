import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanTool } from '../builtin/PlanTool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

let tempDirs: string[] = [];

function ctx(workspace: string, signal?: AbortSignal): ExecutionContext {
  return {
    sessionId: 'plan-session',
    agentId: 'plan-agent',
    workspace,
    userConfirmed: true,
    signal,
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anoclaw-plan-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe('PlanTool', () => {
  it('writes a sanitized plan file with structured metadata', async () => {
    const workspace = await makeWorkspace();
    const content = [
      '## Step 1: Inspect',
      '- [ ] Read files',
      '## Step 2: Verify',
      '- [ ] Run tests',
    ].join('\n');

    const result = await new PlanTool().execute(
      { name: 'Feature Plan!', content },
      ctx(workspace),
    );

    const planPath = path.join(workspace, 'plan-feature-plan.md');
    expect(result.success).toBe(true);
    expect(result.content).toContain('Plan file written');
    expect(result.structured).toMatchObject({
      planFile: 'plan-feature-plan.md',
      planPath,
      rawName: 'Feature Plan!',
      safeName: 'feature-plan',
      dryRun: false,
      overwrite: false,
      existed: false,
      checkboxCount: 2,
      stepHeadingCount: 2,
    });
    const file = await readFile(planPath, 'utf-8');
    expect(file).toContain('# Plan: Feature Plan!');
    expect(file).toContain('> Session: plan-session');
    expect(file).toContain(content);
  });

  it('supports dry_run without writing the plan file', async () => {
    const workspace = await makeWorkspace();

    const result = await new PlanTool().execute(
      {
        name: 'Preview',
        content: '## Step 1: Think\n- [ ] Decide',
        dry_run: true,
      },
      ctx(workspace),
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('Dry run succeeded');
    expect(result.structured).toMatchObject({
      planFile: 'plan-preview.md',
      dryRun: true,
      existed: false,
    });
    await expect(readFile(path.join(workspace, 'plan-preview.md'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses to overwrite an existing plan unless overwrite is explicit', async () => {
    const workspace = await makeWorkspace();
    const planPath = path.join(workspace, 'plan-existing.md');
    await writeFile(planPath, 'keep me\n', 'utf-8');

    const refused = await new PlanTool().execute(
      { name: 'Existing', content: '## Step 1: Replace\n- [ ] Work' },
      ctx(workspace),
    );

    expect(refused.success).toBe(false);
    expect(refused.errorMessage).toContain('already exists');
    expect(refused.structured).toMatchObject({
      planFile: 'plan-existing.md',
      existed: true,
      overwrite: false,
      previousBytes: Buffer.byteLength('keep me\n', 'utf-8'),
    });
    await expect(readFile(planPath, 'utf-8')).resolves.toBe('keep me\n');

    const overwritten = await new PlanTool().execute(
      {
        name: 'Existing',
        content: '## Step 1: Replace\n- [ ] Work',
        overwrite: true,
      },
      ctx(workspace),
    );

    expect(overwritten.success).toBe(true);
    expect(overwritten.content).toContain('Plan file overwritten');
    expect(overwritten.structured).toMatchObject({
      existed: true,
      overwrite: true,
    });
    await expect(readFile(planPath, 'utf-8')).resolves.toContain('## Step 1: Replace');
  });

  it('rejects invalid parameter types and unsafe content', async () => {
    const workspace = await makeWorkspace();
    const tool = new PlanTool();

    const badName = await tool.execute(
      { name: 42, content: '## Step 1: Work' },
      ctx(workspace),
    );
    expect(badName.success).toBe(false);
    expect(badName.errorMessage).toContain('Plan "name" must be a string');

    const badOverwrite = await tool.execute(
      { name: 'Bad Flag', content: '## Step 1: Work', overwrite: 'true' },
      ctx(workspace),
    );
    expect(badOverwrite.success).toBe(false);
    expect(badOverwrite.errorMessage).toContain('Plan "overwrite" must be a boolean');

    const badContent = await tool.execute(
      { name: 'Bad Content', content: 'hello\u0000world' },
      ctx(workspace),
    );
    expect(badContent.success).toBe(false);
    expect(badContent.errorMessage).toContain('NUL content is not supported');
  });

  it('reports cancellation before writing', async () => {
    const workspace = await makeWorkspace();
    const controller = new AbortController();
    controller.abort();

    const result = await new PlanTool().execute(
      { name: 'Cancelled', content: '## Step 1: Noop' },
      ctx(workspace, controller.signal),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('cancelled by user');
    await expect(readFile(path.join(workspace, 'plan-cancelled.md'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
