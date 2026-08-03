import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmationRegistry } from '../ConfirmationRegistry.js';
import { toolConfirmHandler } from '../../../infra/network/handlers/ToolConfirmHandler.js';

afterEach(() => {
  ConfirmationRegistry.resetInstance();
});

describe('ConfirmationRegistry', () => {
  it('rejects a duplicate pending ID without resolving or approving the original', async () => {
    const registry = ConfirmationRegistry.getInstance();
    const original = registry.waitForConfirmation('session-a', 'tool-call-1', 5000);

    await expect(
      registry.waitForConfirmation('session-a', 'tool-call-1', 5000),
    ).resolves.toBe(false);
    expect(registry.resolve('session-a', 'tool-call-1', true)).toBe(true);
    await expect(original).resolves.toBe(true);
  });

  it('isolates identical provider tool-call IDs by session', async () => {
    const registry = ConfirmationRegistry.getInstance();
    const first = registry.waitForConfirmation('session-a', 'shared-id', 5000);
    const second = registry.waitForConfirmation('session-b', 'shared-id', 5000);

    expect(registry.resolve('session-a', 'shared-id', true)).toBe(true);
    await expect(first).resolves.toBe(true);
    expect(registry.resolve('session-a', 'shared-id', false)).toBe(false);

    expect(registry.resolve('session-b', 'shared-id', false)).toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('routes a WebSocket response through its explicit session', async () => {
    const pending = ConfirmationRegistry.getInstance()
      .waitForConfirmation('session-a', 'tool-call-1', 5000);

    await toolConfirmHandler({
      sessionId: 'session-a',
      type: 'tool_confirm_response',
      data: { toolCallId: 'tool-call-1', approved: true },
      ws: {} as never,
    });

    await expect(pending).resolves.toBe(true);
  });
});
