import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandPolicy } from '../CommandPolicy.js';

describe('CommandPolicy', () => {
  const root = path.resolve('C:/workspace/project');
  const policy = new CommandPolicy();

  it('rejects a cwd outside the task workspace', () => {
    expect(policy.evaluate({
      toolName: 'Bash',
      workspaceRoot: root,
      cwd: path.resolve('C:/other'),
      command: 'npm test',
    })).toMatchObject({
      allowed: false,
      code: 'cwd_outside_workspace',
    });
  });

  it('disables arbitrary shell text in strict mode', () => {
    expect(policy.evaluate({
      toolName: 'Bash',
      workspaceRoot: root,
      cwd: root,
      command: 'npm test',
      mode: 'strict',
    })).toMatchObject({
      allowed: false,
      code: 'shell_disabled_in_strict_mode',
    });
  });

  it('blocks explicit network-capable commands when network is denied', () => {
    expect(policy.evaluate({
      toolName: 'Bash',
      workspaceRoot: root,
      cwd: root,
      command: 'curl https://example.com',
      network: 'deny',
    })).toMatchObject({
      allowed: false,
      code: 'network_denied',
    });
  });

  it('rejects explicit paths outside the task workspace', () => {
    const outsidePath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts';
    expect(policy.evaluate({
      toolName: 'Bash',
      workspaceRoot: root,
      cwd: root,
      command: `type "${outsidePath}"`,
    })).toMatchObject({
      allowed: false,
      code: 'path_outside_workspace',
    });
  });

  it('removes undeclared environment variables', () => {
    const result = policy.evaluate({
      toolName: 'RunProgram',
      workspaceRoot: root,
      cwd: root,
      command: 'node ./scripts/check.mjs',
      environment: {
        PATH: 'bin',
        API_SECRET: 'should-not-pass',
        TASK_FLAG: 'yes',
      },
      allowedEnvironmentKeys: ['TASK_FLAG'],
    });
    expect(result).toMatchObject({
      allowed: true,
      environment: {
        PATH: 'bin',
        TASK_FLAG: 'yes',
      },
    });
    if (result.allowed) expect(result.environment.API_SECRET).toBeUndefined();
  });
});
