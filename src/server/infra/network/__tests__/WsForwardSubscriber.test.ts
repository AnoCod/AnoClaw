import { describe, expect, it } from 'vitest';
import { TypedEventBus } from '../../../core/events/TypedEventBus.js';
import { installWsForwarding } from '../WsForwardSubscriber.js';

describe('WsForwardSubscriber lifecycle', () => {
  it('installs domain-event forwarding only once', () => {
    installWsForwarding();
    const firstCount = TypedEventBus.handlerCount;
    installWsForwarding();
    expect(firstCount).toBeGreaterThan(0);
    expect(TypedEventBus.handlerCount).toBe(firstCount);
  });
});
