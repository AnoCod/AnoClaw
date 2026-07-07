import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = null;
  child.killed = false;
  return child;
}

describe('webFetch abort handling', () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  it('rejects promptly when the abort signal fires, even if curl never closes', async () => {
    const child = fakeChild();
    execFileMock.mockReturnValue(child);

    const { webFetch } = await import('../WebFetchHelper.js');
    const controller = new AbortController();
    const pending = webFetch('https://example.com', { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
