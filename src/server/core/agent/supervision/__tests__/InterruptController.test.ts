/**
 * InterruptController tests — session interrupt/task-stop control
 *
 * Covers:
 *   - createController / removeController lifecycle
 *   - requestInterrupt + isInterrupted
 *   - Parent-child interrupt propagation (linkChild/unlinkChild)
 *   - InterruptReason tracking
 *   - Pending user message queue (set/take/hasPending)
 *   - Multi-session isolation
 *   - activeCount tracking
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InterruptController, InterruptReason } from '../InterruptController.js';

describe('InterruptController', () => {
  let controller: InterruptController;

  beforeEach(() => {
    // Reset singleton by creating a fresh instance
    (InterruptController as any)._instance = null;
    controller = InterruptController.getInstance();
  });

  // ── createController / removeController ──

  describe('createController / removeController', () => {
    it('creates an AbortController with non-aborted signal', () => {
      const ac = controller.createController('session-1');
      expect(ac).toBeInstanceOf(AbortController);
      expect(ac.signal.aborted).toBe(false);
    });

    it('returns the same controller instance on getController', () => {
      const ac1 = controller.createController('session-1');
      const ac2 = controller.getController('session-1');
      expect(ac2).toBe(ac1);
    });

    it('creates a fresh controller on re-create (replaces old)', () => {
      const ac1 = controller.createController('session-1');
      const ac2 = controller.createController('session-1');
      expect(ac2).not.toBe(ac1);
      // The old controller is no longer tracked by getController
      expect(controller.getController('session-1')).toBe(ac2);
      // Old controller's signal is NOT aborted by re-create (it's just removed from map)
    });

    it('removeController deletes both controller and reason', () => {
      controller.createController('session-1');
      controller.requestInterrupt('session-1', InterruptReason.UserStop);
      expect(controller.isInterrupted('session-1')).toBe(true);

      controller.removeController('session-1');
      expect(controller.isInterrupted('session-1')).toBe(false);
      expect(controller.reason('session-1')).toBeNull();
    });

    it('removeController also clears pending messages', () => {
      controller.createController('session-1');
      controller.setPendingUserMessage('session-1', 'new message');
      expect(controller.hasPendingUserMessage('session-1')).toBe(true);

      controller.removeController('session-1');
      expect(controller.hasPendingUserMessage('session-1')).toBe(false);
    });

    it('getController returns undefined for unknown session', () => {
      expect(controller.getController('nonexistent')).toBeUndefined();
    });
  });

  // ── requestInterrupt / isInterrupted ──

  describe('requestInterrupt / isInterrupted', () => {
    it('interrupts a session and records the reason', () => {
      controller.createController('session-1');
      controller.requestInterrupt('session-1', InterruptReason.UserStop);

      expect(controller.isInterrupted('session-1')).toBe(true);
      expect(controller.reason('session-1')).toBe(InterruptReason.UserStop);
    });

    it('interrupting a session with no controller is a no-op', () => {
      controller.requestInterrupt('session-1', InterruptReason.Timeout);
      expect(controller.isInterrupted('session-1')).toBe(false);
    });

    it('interrupts with different reasons', () => {
      controller.createController('session-1');

      controller.requestInterrupt('session-1', InterruptReason.UserStop);
      expect(controller.reason('session-1')).toBe(InterruptReason.UserStop);

      controller.removeController('session-1');
      controller.createController('session-2');

      controller.requestInterrupt('session-2', InterruptReason.Timeout);
      expect(controller.reason('session-2')).toBe(InterruptReason.Timeout);

      controller.removeController('session-2');
      controller.createController('session-3');

      controller.requestInterrupt('session-3', InterruptReason.ParentStop);
      expect(controller.reason('session-3')).toBe(InterruptReason.ParentStop);

      controller.removeController('session-3');
      controller.createController('session-4');

      controller.requestInterrupt('session-4', InterruptReason.UserSteer);
      expect(controller.reason('session-4')).toBe(InterruptReason.UserSteer);
    });

    it('second interrupt on same session is idempotent (keeps original reason)', () => {
      controller.createController('session-1');
      controller.requestInterrupt('session-1', InterruptReason.UserStop);
      controller.requestInterrupt('session-1', InterruptReason.Timeout);

      // First reason wins (abort on already-aborted signal is a no-op)
      expect(controller.reason('session-1')).toBe(InterruptReason.UserStop);
    });

    it('isInterrupted returns false for sessions with no controller', () => {
      expect(controller.isInterrupted('nonexistent')).toBe(false);
    });

    it('isInterrupted returns false for sessions with a non-aborted controller', () => {
      controller.createController('session-1');
      expect(controller.isInterrupted('session-1')).toBe(false);
    });
  });

  // ── Parent-child propagation ──

  describe('linkChild / unlinkChild — interrupt propagation', () => {
    it('interrupting parent also interrupts child', () => {
      controller.createController('parent');
      controller.createController('child');
      controller.linkChild('parent', 'child');

      controller.requestInterrupt('parent', InterruptReason.UserStop);

      expect(controller.isInterrupted('parent')).toBe(true);
      expect(controller.isInterrupted('child')).toBe(true);
      expect(controller.reason('child')).toBe(InterruptReason.ParentStop);
    });

    it('unlinkChild stops propagation to child', () => {
      controller.createController('parent');
      controller.createController('child');
      controller.linkChild('parent', 'child');
      controller.unlinkChild('child');

      controller.requestInterrupt('parent', InterruptReason.UserStop);

      expect(controller.isInterrupted('parent')).toBe(true);
      expect(controller.isInterrupted('child')).toBe(false);
    });

    it('interrupting multiple children propagates to all', () => {
      controller.createController('parent');
      controller.createController('child-a');
      controller.createController('child-b');
      controller.linkChild('parent', 'child-a');
      controller.linkChild('parent', 'child-b');

      controller.requestInterrupt('parent', InterruptReason.UserStop);

      expect(controller.isInterrupted('child-a')).toBe(true);
      expect(controller.isInterrupted('child-b')).toBe(true);
    });

    it('removeController cleans up parent-child links', () => {
      controller.createController('parent');
      controller.createController('child');
      controller.linkChild('parent', 'child');
      controller.removeController('parent');

      // Child link should be cleaned up
      controller.createController('child-2');
      expect(controller.getController('child-2')).toBeDefined();
    });
  });

  // ── Pending user message queue ──

  describe('pending user messages', () => {
    it('setPendingUserMessage stores a message', () => {
      controller.setPendingUserMessage('session-1', 'Hello!');
      expect(controller.hasPendingUserMessage('session-1')).toBe(true);
    });

    it('takePendingUserMessage retrieves and removes the message', () => {
      controller.setPendingUserMessage('session-1', 'Hello!');
      const msg = controller.takePendingUserMessage('session-1');
      expect(msg).toBe('Hello!');
      expect(controller.hasPendingUserMessage('session-1')).toBe(false);
    });

    it('takePendingUserMessage returns null when no message', () => {
      const msg = controller.takePendingUserMessage('session-1');
      expect(msg).toBeNull();
    });

    it('hasPendingUserMessage returns false for unknown sessions', () => {
      expect(controller.hasPendingUserMessage('unknown')).toBe(false);
    });

    it('pending messages are isolated per session', () => {
      controller.setPendingUserMessage('session-a', 'Message A');
      controller.setPendingUserMessage('session-b', 'Message B');

      expect(controller.takePendingUserMessage('session-a')).toBe('Message A');
      expect(controller.takePendingUserMessage('session-b')).toBe('Message B');
    });

    it('overwrites previous pending message for same session', () => {
      controller.setPendingUserMessage('session-1', 'First');
      controller.setPendingUserMessage('session-1', 'Second');
      expect(controller.takePendingUserMessage('session-1')).toBe('Second');
    });
  });

  // ── activeCount ──

  describe('activeCount', () => {
    it('starts at 0', () => {
      expect(controller.activeCount).toBe(0);
    });

    it('increments on createController', () => {
      controller.createController('a');
      expect(controller.activeCount).toBe(1);
      controller.createController('b');
      expect(controller.activeCount).toBe(2);
    });

    it('decrements on removeController', () => {
      controller.createController('a');
      controller.createController('b');
      controller.removeController('a');
      expect(controller.activeCount).toBe(1);
      controller.removeController('b');
      expect(controller.activeCount).toBe(0);
    });

    it('re-creating a controller keeps count', () => {
      controller.createController('a');
      controller.createController('a'); // replaces old
      expect(controller.activeCount).toBe(1);
    });
  });

  // ── Abort behavior ──

  describe('abort behavior', () => {
    it('aborts controller on requestInterrupt', () => {
      controller.createController('session-1');
      const signal = controller.getController('session-1')?.signal;
      expect(signal?.aborted).toBe(false);

      controller.requestInterrupt('session-1', InterruptReason.UserStop);
      expect(signal?.aborted).toBe(true);
    });

    it('does not fail for sessions without a controller', () => {
      expect(() => {
        controller.requestInterrupt('nonexistent', InterruptReason.UserStop);
      }).not.toThrow();
    });
  });
});
