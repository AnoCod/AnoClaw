import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionLeaseManager } from '../SessionLeaseManager.js';

describe('SessionLeaseManager', () => {
  beforeEach(() => {
    SessionLeaseManager.getInstance().resetInstance();
  });

  it('acquires unlimited sessions (no global concurrency cap)', () => {
    const mgr = SessionLeaseManager.getInstance();
    // No global limit — per-session concurrency enforced by SessionManager._concurrentTurnGuard
    for (let i = 0; i < 20; i++) {
      expect(mgr.acquire(`sess_${i}`)).not.toBeNull();
    }
    expect(mgr.activeCount).toBe(20);
  });

  it('reacquiring an existing session refreshes it', () => {
    const mgr = SessionLeaseManager.getInstance();
    mgr.acquire('sess_1');
    const lease = mgr.acquire('sess_1');
    expect(lease).not.toBeNull();
    expect(lease!.sessionId).toBe('sess_1');
    expect(mgr.activeCount).toBe(1);
  });

  it('releases a slot and allows a new session', () => {
    const mgr = SessionLeaseManager.getInstance();
    expect(mgr.acquire('sess_1')).not.toBeNull();
    mgr.release('sess_1');
    expect(mgr.acquire('sess_2')).not.toBeNull();
    expect(mgr.activeCount).toBe(1);
  });

  it('releases all sessions on resetInstance', () => {
    const mgr = SessionLeaseManager.getInstance();
    mgr.acquire('sess_1');
    mgr.acquire('sess_2');
    expect(mgr.activeCount).toBe(2);
    mgr.resetInstance();
    expect(mgr.activeCount).toBe(0);
  });

  it('touch updates lastActivityAt', () => {
    const mgr = SessionLeaseManager.getInstance();
    const lease = mgr.acquire('sess_1')!;
    const before = lease.lastActivityAt;
    mgr.touch('sess_1');
    expect(lease.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it('reaps idle sessions after timeout', () => {
    vi.useFakeTimers();
    const mgr = SessionLeaseManager._createForTest(60, 30);
    mgr.start();
    mgr.acquire('sess_1');
    expect(mgr.activeCount).toBe(1);
    // Advance past idle timeout (60ms) + one reaper tick (30ms)
    vi.advanceTimersByTime(100);
    mgr.stop();
    expect(mgr.activeCount).toBe(0);
    vi.useRealTimers();
  });

  it('activeSessionIds returns list of leased session IDs', () => {
    const mgr = SessionLeaseManager.getInstance();
    mgr.acquire('sess_a');
    mgr.acquire('sess_b');
    const ids = mgr.activeSessionIds;
    expect(ids).toContain('sess_a');
    expect(ids).toContain('sess_b');
    expect(ids.length).toBe(2);
  });
});
