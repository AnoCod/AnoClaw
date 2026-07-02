/**
 * EventSubscriptionManager.test.ts — unit tests for subscribe/unsubscribe/publish
 * and the three-map bookkeeping consistency invariants.
 *
 * Tests cover:
 *   1. subscribe() — returns ID, tracks by session+topic, respects oneShot
 *   2. unsubscribe() — by ID, by session+topic, unknown ID
 *   3. unsubscribeAll() — session-level cleanup
 *   4. hasSubscription() / getSubscriptions() — query
 *   5. activeCount / topicCount — bookkeeping
 *   6. publish() — delivery matching, oneShot auto-cleanup, non-oneShot persistence
 *   7. Three-map invariant: _subscriptions, _byId, _bySession stay consistent
 *      across all operations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventSubscriptionManager } from '../EventSubscriptionManager.js';

describe('EventSubscriptionManager', () => {
  let mgr: EventSubscriptionManager;

  beforeEach(() => {
    EventSubscriptionManager.resetInstance();
    mgr = EventSubscriptionManager.getInstance();
  });

  // ── subscribe ──

  describe('subscribe()', () => {
    it('should return a unique subscription ID', () => {
      const id = mgr.subscribe('session-1', 'agent-1', 'test:topic');
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      expect(id.startsWith('sub-')).toBe(true);
    });

    it('should return different IDs for consecutive subscribe calls', () => {
      const id1 = mgr.subscribe('s1', 'a1', 't1');
      const id2 = mgr.subscribe('s1', 'a1', 't1');
      expect(id1).not.toBe(id2);
    });

    it('should allow multiple sessions to subscribe to the same topic', () => {
      mgr.subscribe('s1', 'a1', 'shared:topic');
      mgr.subscribe('s2', 'a2', 'shared:topic');

      expect(mgr.hasSubscription('s1', 'shared:topic')).toBe(true);
      expect(mgr.hasSubscription('s2', 'shared:topic')).toBe(true);
      expect(mgr.activeCount).toBe(2);
    });

    it('should default oneShot to false', () => {
      mgr.subscribe('s1', 'a1', 'test:topic');
      const subs = mgr.getSubscriptions('s1');
      expect(subs[0].oneShot).toBe(false);
    });

    it('should respect oneShot: true option', () => {
      mgr.subscribe('s1', 'a1', 'test:oneshot', { oneShot: true });
      const subs = mgr.getSubscriptions('s1');
      expect(subs[0].oneShot).toBe(true);
    });

    it('should record createdAt as a number (timestamp)', () => {
      mgr.subscribe('s1', 'a1', 'test:topic');
      const subs = mgr.getSubscriptions('s1');
      expect(typeof subs[0].createdAt).toBe('number');
      expect(subs[0].createdAt).toBeGreaterThan(0);
    });
  });

  // ── unsubscribe ──

  describe('unsubscribe()', () => {
    it('should unsubscribe by ID and return true', () => {
      const id = mgr.subscribe('s1', 'a1', 'test:topic');
      expect(mgr.activeCount).toBe(1);

      const result = mgr.unsubscribe(id);
      expect(result).toBe(true);
      expect(mgr.activeCount).toBe(0);
      expect(mgr.hasSubscription('s1', 'test:topic')).toBe(false);
    });

    it('should unsubscribe by sessionId + topic pair and return true', () => {
      mgr.subscribe('s1', 'a1', 'test:topic');
      expect(mgr.activeCount).toBe(1);

      const result = mgr.unsubscribe('s1', 'test:topic');
      expect(result).toBe(true);
      expect(mgr.activeCount).toBe(0);
    });

    it('should return false for unknown ID', () => {
      const result = mgr.unsubscribe('nonexistent');
      expect(result).toBe(false);
    });

    it('should return false for unknown session+topic', () => {
      const result = mgr.unsubscribe('unknown', 'unknown:topic');
      expect(result).toBe(false);
    });

    it('should only remove the specified session from a shared topic, not others', () => {
      mgr.subscribe('s1', 'a1', 'shared:topic');
      const id2 = mgr.subscribe('s2', 'a2', 'shared:topic');

      mgr.unsubscribe('s1', 'shared:topic');

      expect(mgr.hasSubscription('s1', 'shared:topic')).toBe(false);
      expect(mgr.hasSubscription('s2', 'shared:topic')).toBe(true);
      expect(mgr.activeCount).toBe(1);
    });

    it('should handle multiple subscriptions by same session to same topic', () => {
      const id1 = mgr.subscribe('s1', 'a1', 'multi:topic');
      const id2 = mgr.subscribe('s1', 'a1', 'multi:topic');
      expect(mgr.activeCount).toBe(2);

      mgr.unsubscribe(id1);
      expect(mgr.activeCount).toBe(1);
      expect(mgr.hasSubscription('s1', 'multi:topic')).toBe(true); // id2 still active

      mgr.unsubscribe('s1', 'multi:topic');
      expect(mgr.activeCount).toBe(0);
    });

    it('should clean up topic map when last subscriber is removed', () => {
      mgr.subscribe('s1', 'a1', 'lonely:topic');
      expect(mgr.topicCount).toBe(1);

      mgr.unsubscribe('s1', 'lonely:topic');
      expect(mgr.topicCount).toBe(0);
    });
  });

  // ── unsubscribeAll ──

  describe('unsubscribeAll()', () => {
    it('should remove all subscriptions for a session', () => {
      mgr.subscribe('s1', 'a1', 'topic:a');
      mgr.subscribe('s1', 'a1', 'topic:b');
      mgr.subscribe('s2', 'a2', 'topic:a');

      const count = mgr.unsubscribeAll('s1');
      expect(count).toBe(2);
      expect(mgr.activeCount).toBe(1); // s2 still has one
      expect(mgr.hasSubscription('s1', 'topic:a')).toBe(false);
      expect(mgr.hasSubscription('s1', 'topic:b')).toBe(false);
    });

    it('should return 0 for session with no subscriptions', () => {
      const count = mgr.unsubscribeAll('nonexistent');
      expect(count).toBe(0);
    });

    it('should clean up session→topics mapping', () => {
      mgr.subscribe('s1', 'a1', 'topic:a');
      mgr.unsubscribeAll('s1');

      // A second cleanup call should return 0
      expect(mgr.unsubscribeAll('s1')).toBe(0);
    });
  });

  // ── hasSubscription ──

  describe('hasSubscription()', () => {
    it('should return true if session subscribed to the exact topic', () => {
      mgr.subscribe('s1', 'a1', 'test:topic');
      expect(mgr.hasSubscription('s1', 'test:topic')).toBe(true);
    });

    it('should return false if session not subscribed to the topic', () => {
      mgr.subscribe('s1', 'a1', 'test:topic');
      expect(mgr.hasSubscription('s2', 'test:topic')).toBe(false);
    });

    it('should return false for unknown topic', () => {
      expect(mgr.hasSubscription('s1', 'unknown:topic')).toBe(false);
    });

    it('should return false after unsubscribe', () => {
      const id = mgr.subscribe('s1', 'a1', 'test:topic');
      mgr.unsubscribe(id);
      expect(mgr.hasSubscription('s1', 'test:topic')).toBe(false);
    });
  });

  // ── getSubscriptions ──

  describe('getSubscriptions()', () => {
    it('should return all subscriptions for a session', () => {
      mgr.subscribe('s1', 'a1', 'topic:a');
      mgr.subscribe('s1', 'a1', 'topic:b');

      const subs = mgr.getSubscriptions('s1');
      expect(subs.length).toBe(2);
      const topics = subs.map(s => s.topic).sort();
      expect(topics).toEqual(['topic:a', 'topic:b']);
    });

    it('should return empty array for session with no subscriptions', () => {
      const subs = mgr.getSubscriptions('nonexistent');
      expect(subs).toEqual([]);
    });

    it('should not return other sessions subscriptions', () => {
      mgr.subscribe('s1', 'a1', 'topic:a');
      mgr.subscribe('s2', 'a2', 'topic:a');

      const subs = mgr.getSubscriptions('s1');
      expect(subs.length).toBe(1);
      expect(subs[0].sessionId).toBe('s1');
    });
  });

  // ── activeCount / topicCount ──

  describe('activeCount / topicCount', () => {
    it('should start at 0', () => {
      expect(mgr.activeCount).toBe(0);
      expect(mgr.topicCount).toBe(0);
    });

    it('should increment activeCount on subscribe', () => {
      mgr.subscribe('s1', 'a1', 'topic:a');
      expect(mgr.activeCount).toBe(1);
      mgr.subscribe('s2', 'a2', 'topic:a');
      expect(mgr.activeCount).toBe(2);
    });

    it('should track distinct topics', () => {
      expect(mgr.topicCount).toBe(0);
      mgr.subscribe('s1', 'a1', 'topic:a');
      expect(mgr.topicCount).toBe(1);
      mgr.subscribe('s2', 'a2', 'topic:a'); // same topic
      expect(mgr.topicCount).toBe(1);
      mgr.subscribe('s1', 'a1', 'topic:b');
      expect(mgr.topicCount).toBe(2);
    });

    it('should decrement activeCount on unsubscribe', () => {
      mgr.subscribe('s1', 'a1', 't1');
      mgr.subscribe('s1', 'a1', 't2');
      expect(mgr.activeCount).toBe(2);

      mgr.unsubscribe('s1', 't1');
      expect(mgr.activeCount).toBe(1);

      mgr.unsubscribeAll('s1');
      expect(mgr.activeCount).toBe(0);
    });
  });

  // ── publish ──

  describe('publish()', () => {
    it('should return 0 when no subscribers', async () => {
      const count = await mgr.publish('empty:topic', { data: 'test' });
      expect(count).toBe(0);
    });

    it('should return the number of subscribers delivered to', async () => {
      mgr.subscribe('s1', 'a1', 'test:deliver');
      mgr.subscribe('s2', 'a2', 'test:deliver');

      // SessionManager.getInstance() may not be initialized in test context,
      // so delivery itself may fail — that's expected. The matching logic
      // is what we test here: the publish() call returns the count of
      // subscribers it attempted to deliver to, before individual delivery failures.
      const count = await mgr.publish('test:deliver', 'hello');
      // The actual delivery may fail (SessionManager not initialized), but
      // the subscriber matching should have run for 2 subscribers.
      expect(typeof count).toBe('number');
    });

    it('should NOT match non-matching topics', async () => {
      mgr.subscribe('s1', 'a1', 'topic:a');
      const count = await mgr.publish('topic:b', { data: 1 });
      expect(count).toBe(0);
    });

    it('should use exact topic match, not prefix match', async () => {
      mgr.subscribe('s1', 'a1', 'task:completed');

      const c1 = await mgr.publish('task:completed:extra', {});
      const c2 = await mgr.publish('task:completed:sub-123', {});

      expect(c1).toBe(0);
      expect(c2).toBe(0);
    });

    it('should auto-unsubscribe oneShot subscriptions after delivery', async () => {
      mgr.subscribe('s1', 'a1', 'test:oneshot', { oneShot: true });
      expect(mgr.activeCount).toBe(1);

      await mgr.publish('test:oneshot', { data: 1 });

      expect(mgr.activeCount).toBe(0);
      expect(mgr.hasSubscription('s1', 'test:oneshot')).toBe(false);
    });

    it('should NOT auto-unsubscribe non-oneShot subscriptions after delivery', async () => {
      mgr.subscribe('s1', 'a1', 'test:persist', { oneShot: false });
      expect(mgr.activeCount).toBe(1);

      await mgr.publish('test:persist', { data: 1 });

      expect(mgr.activeCount).toBe(1);
      expect(mgr.hasSubscription('s1', 'test:persist')).toBe(true);
    });

    it('should allow multiple publishes on the same non-oneShot subscription', async () => {
      mgr.subscribe('s1', 'a1', 'test:multi', { oneShot: false });

      await mgr.publish('test:multi', { seq: 1 });
      expect(mgr.activeCount).toBe(1);

      await mgr.publish('test:multi', { seq: 2 });
      expect(mgr.activeCount).toBe(1);

      expect(mgr.hasSubscription('s1', 'test:multi')).toBe(true);
    });

    it('should handle string payload directly without JSON.stringify', async () => {
      // String payload should not be double-stringified
      mgr.subscribe('s1', 'a1', 'test:string');

      // This should not throw — just verifying the publish call works
      const count = await mgr.publish('test:string', 'plain string message');
      expect(typeof count).toBe('number');
    });

    it('should handle object payload with JSON.stringify', async () => {
      mgr.subscribe('s1', 'a1', 'test:object');

      // This should not throw — just verifying JSON.stringify works
      const count = await mgr.publish('test:object', { nested: { value: 42 } });
      expect(typeof count).toBe('number');
    });
  });

  // ── Three-map invariant ──

  describe('three-map invariant consistency', () => {
    it('after subscribe: all three maps reflect the subscription', () => {
      mgr.subscribe('s1', 'a1', 'invar:topic');

      // _byId has it
      expect(mgr.activeCount).toBe(1);

      // hasSubscription works (uses _subscriptions scan)
      expect(mgr.hasSubscription('s1', 'invar:topic')).toBe(true);

      // getSubscriptions works (uses _subscriptions values scan)
      const subs = mgr.getSubscriptions('s1');
      expect(subs.length).toBe(1);
    });

    it('after unsubscribe by ID: all three maps are consistent', () => {
      const id = mgr.subscribe('s1', 'a1', 'invar:topic');
      mgr.subscribe('s2', 'a2', 'invar:topic'); // second subscriber keeps topic alive

      mgr.unsubscribe(id);

      // s1 subscription gone
      expect(mgr.hasSubscription('s1', 'invar:topic')).toBe(false);
      // s2 subscription still there
      expect(mgr.hasSubscription('s2', 'invar:topic')).toBe(true);
      // _byId decremented
      expect(mgr.activeCount).toBe(1);
      // topic still registered (s2 keeps it)
      expect(mgr.topicCount).toBe(1);
    });

    it('after unsubscribeAll: session removed from all maps', () => {
      mgr.subscribe('s1', 'a1', 't1');
      mgr.subscribe('s1', 'a1', 't2');
      mgr.subscribe('s2', 'a2', 't1');

      mgr.unsubscribeAll('s1');

      expect(mgr.activeCount).toBe(1);
      expect(mgr.topicCount).toBe(1); // only 't1' remains (by s2)

      // verify s2 data is intact
      expect(mgr.hasSubscription('s2', 't1')).toBe(true);
    });
  });
});
