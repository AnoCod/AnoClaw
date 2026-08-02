import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogManager } from '../LogManager.js';

let logDir = '';

afterEach(async () => {
  vi.restoreAllMocks();
  await LogManager.getInstance().shutdown().catch(() => {});
  if (logDir) await rm(logDir, { recursive: true, force: true });
  logDir = '';
});

describe('LogManager console resilience', () => {
  it('keeps file and in-memory logging alive when stdout throws EPIPE', async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'anoclaw-log-manager-'));
    const manager = LogManager.getInstance();
    manager.initialize(logDir);

    const brokenPipe = Object.assign(new Error('broken pipe, write'), { code: 'EPIPE' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementationOnce(() => {
      throw brokenPipe;
    });

    expect(() => {
      manager.logger('anochat.core').info('EPIPE must not crash the app');
      manager.logger('anochat.core').info('Logging continues after console failure');
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(manager.recentEntries('anochat.core', 2).map((entry) => entry.msg)).toEqual([
      'Logging continues after console failure',
      'EPIPE must not crash the app',
    ]);
  });
});
