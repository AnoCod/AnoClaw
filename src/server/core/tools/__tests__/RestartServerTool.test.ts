import { afterEach, describe, expect, it } from 'vitest';
import { RestartServerTool } from '../builtin/RestartServerTool.js';
import { BackgroundTaskManager } from '../../agent/supervision/BackgroundTaskManager.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'restart-session',
  agentId: 'restart-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

describe('RestartServerTool', () => {
  afterEach(() => {
    BackgroundTaskManager.resetInstance();
  });

  it('dry-runs restart checkpoint creation without registering background work', async () => {
    const result = await new RestartServerTool().execute({
      resumeMessage: '  continue native tool hardening  ',
      dry_run: true,
      delay_ms: 250,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Dry run');
    expect(BackgroundTaskManager.getInstance().activeCount).toBe(0);
    expect(result.structured).toMatchObject({
      status: 'dry_run',
      willRestart: false,
      electronRuntime: false,
      checkpoint: {
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        resumeMessage: 'continue native tool hardening',
        delayMs: 250,
      },
    });
  });

  it('refuses to restart outside Electron instead of exiting the process', async () => {
    const result = await new RestartServerTool().execute({
      resumeMessage: 'restart after server changes',
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('requires the Electron desktop runtime');
    expect(BackgroundTaskManager.getInstance().activeCount).toBe(0);
    expect(result.structured).toMatchObject({
      status: 'unsupported_runtime',
      willRestart: false,
      electronRuntime: false,
    });
  });

  it('rejects malformed direct parameters before side effects', async () => {
    const badDelay = await new RestartServerTool().execute({
      resumeMessage: 'restart later',
      delay_ms: 10001,
    }, ctx);

    expect(badDelay.success).toBe(false);
    expect(badDelay.errorMessage).toContain('delay_ms must be 10000 or less');
    expect(BackgroundTaskManager.getInstance().activeCount).toBe(0);

    const badDryRun = await new RestartServerTool().execute({
      resumeMessage: 'restart later',
      dry_run: 'yes',
    }, ctx);

    expect(badDryRun.success).toBe(false);
    expect(badDryRun.errorMessage).toContain('dry_run must be a boolean');
  });
});
