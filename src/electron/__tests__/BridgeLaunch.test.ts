import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

interface BridgeRun {
  spawn: ReturnType<typeof vi.fn>;
  child: {
    on: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  stdoutOn: ReturnType<typeof vi.fn>;
  stderrOn: ReturnType<typeof vi.fn>;
}

async function runBridge(isPackaged: boolean): Promise<BridgeRun> {
  const source = await readFile(new URL('../bridge.js', import.meta.url), 'utf8');
  const child = {
    on: vi.fn(),
    unref: vi.fn(),
  };
  const spawn = vi.fn(() => child);
  const stdoutOn = vi.fn();
  const stderrOn = vi.fn();
  const fakeProcess = {
    env: { ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'yes' },
    execPath: 'C:\\AnoClaw\\AnoClaw.exe',
    exit: vi.fn(),
    stdout: { on: stdoutOn },
    stderr: { on: stderrOn },
  };
  const fakeRequire = (id: string): unknown => {
    if (id === 'electron') return 'C:\\AnoClaw\\AnoClaw.exe';
    if (id === 'child_process') return { spawn };
    if (id === 'path') return path;
    if (id === 'fs') return { existsSync: vi.fn(() => isPackaged) };
    throw new Error(`Unexpected bridge dependency: ${id}`);
  };

  const executeBridge = new Function('require', 'process', '__dirname', source);
  executeBridge(fakeRequire, fakeProcess, 'C:\\AnoClaw\\resources\\app.asar\\dist\\electron');
  return { spawn, child, stdoutOn, stderrOn };
}

describe('Electron compatibility bridge launch', () => {
  it('detaches packaged Electron from launcher pipes', async () => {
    const { spawn, child, stdoutOn, stderrOn } = await runBridge(true);

    expect(spawn).toHaveBeenCalledOnce();
    expect(stdoutOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(stderrOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(spawn.mock.calls[0][2]).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: {
        KEEP_ME: 'yes',
      },
    });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.on).not.toHaveBeenCalled();
  });

  it('keeps terminal output attached during development', async () => {
    const { spawn, child } = await runBridge(false);

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][2]).toMatchObject({
      stdio: 'inherit',
      env: {
        KEEP_ME: 'yes',
      },
    });
    expect(child.unref).not.toHaveBeenCalled();
    expect(child.on).toHaveBeenCalledWith('close', expect.any(Function));
  });
});
