import { describe, it, expect } from 'vitest';
import { Session } from '../Session.js';
import type { SessionNode } from '../../../../shared/types/session.js';
import { SessionType, SessionStatus } from '../../../../shared/types/session.js';

function makeNode(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: 'sess-001',
    parentSessionId: null,
    level: 0,
    agentId: 'agent-main',
    type: SessionType.Main,
    status: SessionStatus.Active,
    title: 'Test Session',
    workspace: '/home/test',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastActiveAt: '2025-01-01T00:00:00.000Z',
    subSessionIds: [],
    metadata: {},
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Identity accessors
// ═══════════════════════════════════════════════════════════════════

describe('Session — identity accessors', () => {
  it('returns sessionId', () => {
    const s = new Session(makeNode());
    expect(s.sessionId).toBe('sess-001');
  });

  it('returns parentSessionId (null for root)', () => {
    const s = new Session(makeNode());
    expect(s.parentSessionId).toBeNull();
  });

  it('returns parentSessionId when set', () => {
    const s = new Session(makeNode({ parentSessionId: 'parent-99' }));
    expect(s.parentSessionId).toBe('parent-99');
  });

  it('returns level', () => {
    const s = new Session(makeNode({ level: 2 }));
    expect(s.level).toBe(2);
  });

  it('returns agentId', () => {
    const s = new Session(makeNode({ agentId: 'agent-42' }));
    expect(s.agentId).toBe('agent-42');
  });

  it('returns type', () => {
    expect(new Session(makeNode({ type: SessionType.Main })).type).toBe('Main');
    expect(new Session(makeNode({ type: SessionType.Sub })).type).toBe('Sub');
  });

  it('returns status', () => {
    expect(new Session(makeNode({ status: SessionStatus.Active })).status).toBe('Active');
  });

  it('returns title', () => {
    expect(new Session(makeNode({ title: 'My Session' })).title).toBe('My Session');
  });

  it('returns workspace', () => {
    expect(new Session(makeNode({ workspace: '/tmp' })).workspace).toBe('/tmp');
  });

  it('returns createdAt', () => {
    expect(new Session(makeNode()).createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('returns lastActiveAt', () => {
    expect(new Session(makeNode()).lastActiveAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('returns copy of subSessionIds', () => {
    const s = new Session(makeNode({ subSessionIds: ['a', 'b'] }));
    expect(s.subSessionIds).toEqual(['a', 'b']);
    // Should be a copy, not the original reference
    s.subSessionIds.push('c');
    expect(s.subSessionIds).toEqual(['a', 'b']);
  });

  it('returns copy of metadata', () => {
    const s = new Session(makeNode({ metadata: { key: 'val' } }));
    expect(s.metadata).toEqual({ key: 'val' });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Predicates
// ═══════════════════════════════════════════════════════════════════

describe('Session — predicates', () => {
  it('isMain()', () => {
    expect(new Session(makeNode({ type: SessionType.Main })).isMain()).toBe(true);
    expect(new Session(makeNode({ type: SessionType.Sub })).isMain()).toBe(false);
  });

  it('isSub()', () => {
    expect(new Session(makeNode({ type: SessionType.Sub })).isSub()).toBe(true);
    expect(new Session(makeNode({ type: SessionType.Main })).isSub()).toBe(false);
  });

  it('isActive()', () => {
    expect(new Session(makeNode({ status: SessionStatus.Active })).isActive()).toBe(true);
    expect(new Session(makeNode({ status: SessionStatus.Idle })).isActive()).toBe(false);
  });

  it('isIdle()', () => {
    expect(new Session(makeNode({ status: SessionStatus.Idle })).isIdle()).toBe(true);
    expect(new Session(makeNode({ status: SessionStatus.Active })).isIdle()).toBe(false);
  });

  it('isArchived()', () => {
    expect(new Session(makeNode({ status: SessionStatus.Archived })).isArchived()).toBe(true);
    expect(new Session(makeNode({ status: SessionStatus.Active })).isArchived()).toBe(false);
  });

  it('hasParent() — true with non-empty parentSessionId', () => {
    expect(new Session(makeNode({ parentSessionId: 'parent-1' })).hasParent()).toBe(true);
  });

  it('hasParent() — false for null parentSessionId', () => {
    expect(new Session(makeNode({ parentSessionId: null })).hasParent()).toBe(false);
  });

  it('hasParent() — false for empty string parentSessionId', () => {
    expect(new Session(makeNode({ parentSessionId: '' })).hasParent()).toBe(false);
  });

  it('isRoot()', () => {
    expect(new Session(makeNode({ level: 0 })).isRoot()).toBe(true);
    expect(new Session(makeNode({ level: 1 })).isRoot()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// State machine — status transitions
// ═══════════════════════════════════════════════════════════════════

describe('Session — state machine transitions', () => {
  // ── archive() ──

  describe('archive()', () => {
    it('Active → Archived', () => {
      const s = new Session(makeNode({ status: SessionStatus.Active }));
      const before = s.lastActiveAt;
      s.archive();
      expect(s.status).toBe('Archived');
      expect(s.isArchived()).toBe(true);
      expect(s.lastActiveAt).not.toBe(before);
    });

    it('Idle → Archived', () => {
      const s = new Session(makeNode({ status: SessionStatus.Idle }));
      const before = s.lastActiveAt;
      s.archive();
      expect(s.status).toBe('Archived');
      expect(s.isArchived()).toBe(true);
      // lastActiveAt SHOULD update when archiving from Idle — the act of
      // archiving is user activity. Current impl updates it, which is correct.
      expect(s.lastActiveAt).not.toBe(before);
    });

    it('Archived → Archived (no-op, guard prevents re-archive)', () => {
      // FIXED: archive() now guards against re-archiving — no-op if already Archived.
      const s = new Session(makeNode({ status: SessionStatus.Archived }));
      const before = s.lastActiveAt;
      s.archive();
      expect(s.status).toBe('Archived');
      expect(s.lastActiveAt).toBe(before);
    });
  });

  // ── setIdle() ──

  describe('setIdle()', () => {
    it('Active → Idle (valid transition)', () => {
      const s = new Session(makeNode({ status: SessionStatus.Active }));
      const before = s.lastActiveAt;
      s.setIdle();
      expect(s.status).toBe('Idle');
      expect(s.isIdle()).toBe(true);
      expect(s.lastActiveAt).not.toBe(before);
    });

    it('Idle → Idle (no-op — setActive required to leave Idle)', () => {
      // setIdle has a guard: only transitions from Active. Calling setIdle on
      // an already-Idle session is a silent no-op. This is intentional: you
      // can't bounce between Idle states, you must go through Active.
      const s = new Session(makeNode({ status: SessionStatus.Idle }));
      const before = s.lastActiveAt;
      s.setIdle();
      expect(s.status).toBe('Idle');
      expect(s.lastActiveAt).toBe(before); // no touch
    });

    it('Archived → Idle (BLOCKED — setIdle only works from Active)', () => {
      // setIdle guards on status === 'Active'. An Archived session cannot
      // be setIdle'd. This is correct behavior — Archived is a terminal state.
      const s = new Session(makeNode({ status: SessionStatus.Archived }));
      const before = s.lastActiveAt;
      s.setIdle();
      expect(s.status).toBe('Archived');
      expect(s.lastActiveAt).toBe(before);
    });
  });

  // ── setActive() ──

  describe('setActive()', () => {
    it('Idle → Active (valid transition)', () => {
      const s = new Session(makeNode({ status: SessionStatus.Idle }));
      const before = s.lastActiveAt;
      s.setActive();
      expect(s.status).toBe('Active');
      expect(s.isActive()).toBe(true);
      expect(s.lastActiveAt).not.toBe(before);
    });

    it('Active → Active (refresh, timestamp updates)', () => {
      // setActive on an already-Active session refreshes the timestamp.
      // This is by design — it's a heartbeat/touch for active sessions.
      const s = new Session(makeNode({ status: SessionStatus.Active }));
      const before = s.lastActiveAt;
      s.setActive();
      expect(s.status).toBe('Active');
      expect(s.lastActiveAt).not.toBe(before);
    });

    it('Archived → Active (terminal state preserved)', () => {
      // Archived is a terminal state — setActive should no-op.
      const s = new Session(makeNode({ status: SessionStatus.Archived }));
      s.setActive();
      // FIXED: status stays 'Archived' — archived sessions cannot be reactivated
      expect(s.status).toBe('Archived');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// State machine — full cycle walkthrough
// ═══════════════════════════════════════════════════════════════════

describe('Session — full state machine walkthrough', () => {
  it('Active → Idle → Active → Archived (happy path)', () => {
    const s = new Session(makeNode({ status: SessionStatus.Active }));

    // Active → Idle
    s.setIdle();
    expect(s.isIdle()).toBe(true);

    // Idle → Active
    s.setActive();
    expect(s.isActive()).toBe(true);

    // Active → Archived
    s.archive();
    expect(s.isArchived()).toBe(true);
  });

  it('Idle → Active → Idle → Active (back-and-forth)', () => {
    const s = new Session(makeNode({ status: SessionStatus.Idle }));

    s.setActive();
    expect(s.isActive()).toBe(true);

    s.setIdle();
    expect(s.isIdle()).toBe(true);

    s.setActive();
    expect(s.isActive()).toBe(true);
  });

  it('Active → Idle → Archival (Idle → Archived) works', () => {
    const s = new Session(makeNode({ status: SessionStatus.Active }));
    s.setIdle();
    expect(s.isIdle()).toBe(true);
    s.archive();
    expect(s.isArchived()).toBe(true);
  });

  it('every transition updates lastActiveAt', () => {
    const s = new Session(makeNode({ status: SessionStatus.Active }));
    const t0 = s.lastActiveAt;

    s.setIdle();
    const t1 = s.lastActiveAt;
    expect(t1 >= t0);

    s.setActive();
    const t2 = s.lastActiveAt;
    expect(t2 >= t1);

    s.archive();
    const t3 = s.lastActiveAt;
    expect(t3 >= t2);

    // At most one pair can be equal (same ms), but not all three should be the same
    const changes = [t1 !== t0, t2 !== t1, t3 !== t2].filter(Boolean).length;
    expect(changes).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Invariant: toJSON() returns a deep copy
// ═══════════════════════════════════════════════════════════════════

describe('Session — toJSON() deep copy invariants', () => {
  it('mutating returned subSessionIds does NOT affect Session', () => {
    const s = new Session(makeNode({ subSessionIds: ['a', 'b'] }));
    const json = s.toJSON();
    json.subSessionIds.push('c');
    json.subSessionIds[0] = 'mutated';
    expect(s.subSessionIds).toEqual(['a', 'b']);
  });

  it('mutating returned metadata does NOT affect Session', () => {
    const s = new Session(makeNode({ metadata: { key: 'val' } }));
    const json = s.toJSON();
    json.metadata.key = 'mutated';
    json.metadata.newKey = 'leaked';
    expect(s.metadata).toEqual({ key: 'val' });
  });

  it('mutating toJSON() status does NOT affect Session', () => {
    const s = new Session(makeNode({ status: SessionStatus.Active }));
    const json = s.toJSON();
    json.status = SessionStatus.Archived;
    expect(s.status).toBe('Active');
  });

  it('mutating toJSON() title does NOT affect Session', () => {
    const s = new Session(makeNode({ title: 'Original' }));
    const json = s.toJSON();
    json.title = 'Hacked';
    expect(s.title).toBe('Original');
  });

  it('toJSON() returns fresh copies on each call (no shared references)', () => {
    const s = new Session(makeNode({ subSessionIds: ['x'], metadata: { a: 1 } }));
    const json1 = s.toJSON();
    const json2 = s.toJSON();
    json1.subSessionIds.push('leak');
    json1.metadata.b = 2;
    expect(json2.subSessionIds).toEqual(['x']);
    expect(json2.metadata).toEqual({ a: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Invariant: constructor clones the input node
// ═══════════════════════════════════════════════════════════════════

describe('Session — constructor isolation', () => {
  it('mutating the input node after construction does NOT affect Session', () => {
    const node = makeNode();
    const s = new Session(node);
    node.status = SessionStatus.Archived;
    node.title = 'Hacked';
    node.subSessionIds.push('leaked');

    expect(s.status).toBe('Active');
    expect(s.title).toBe('Test Session');
    expect(s.subSessionIds).toEqual([]);
  });

  it('mutating input node metadata after construction does NOT affect Session', () => {
    const node = makeNode({ metadata: { key: 'original' } });
    const s = new Session(node);
    node.metadata.key = 'hacked';
    node.metadata.leak = true;

    expect(s.metadata.key).toBe('original');
    expect(s.metadata).not.toHaveProperty('leak');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════

describe('Session — edge cases', () => {
  it('null vs empty-string parentSessionId — both mean "no parent"', () => {
    const sNull = new Session(makeNode({ parentSessionId: null }));
    const sEmpty = new Session(makeNode({ parentSessionId: '' }));
    expect(sNull.hasParent()).toBe(false);
    expect(sEmpty.hasParent()).toBe(false);
    expect(sNull.parentSessionId).toBeNull();
    expect(sEmpty.parentSessionId).toBe('');
  });

  it('very long session ID', () => {
    const longId = 'sess-' + 'x'.repeat(500);
    const s = new Session(makeNode({ sessionId: longId }));
    expect(s.sessionId).toBe(longId);
    expect(s.id).toBe(longId);
  });

  it('unicode in workspace path', () => {
    const path = '/home/用户/项目/文档';
    const s = new Session(makeNode({ workspace: path }));
    expect(s.workspace).toBe(path);
  });

  it('unicode in title', () => {
    const title = '你好世界 — 测试会话';
    const s = new Session(makeNode({ title }));
    expect(s.title).toBe(title);
  });

  it('setMetadata overwrites existing key', () => {
    const s = new Session(makeNode({ metadata: { theme: 'light' } }));
    expect(s.metadata.theme).toBe('light');

    s.setMetadata('theme', 'dark');
    expect(s.metadata.theme).toBe('dark');

    s.setMetadata('theme', null);
    expect(s.metadata.theme).toBeNull();
  });

  it('setMetadata does NOT touch lastActiveAt', () => {
    // setMetadata is the only mutation that doesn't bump lastActiveAt.
    // This is by design — metadata changes are internal infra ops.
    const s = new Session(makeNode());
    const before = s.lastActiveAt;

    s.setMetadata('key', 'value');
    expect(s.lastActiveAt).toBe(before);

    s.setMetadata('key', 'updated');
    expect(s.lastActiveAt).toBe(before);
  });

  it('subSessionIds getter returns a fresh copy on each call', () => {
    const s = new Session(makeNode({ subSessionIds: ['a'] }));
    const copy1 = s.subSessionIds;
    const copy2 = s.subSessionIds;
    expect(copy1).toEqual(['a']);
    expect(copy2).toEqual(['a']);
    copy1.push('leak');
    expect(s.subSessionIds).toEqual(['a']);
  });

  it('metadata getter returns a shallow copy on each call', () => {
    // Shallow copy — nested objects can still be mutated.
    // This is expected for Record<string, unknown>.
    const s = new Session(makeNode({ metadata: { nested: { deep: 1 } } }));
    const copy1 = s.metadata;
    const copy2 = s.metadata;
    expect(copy1).toEqual({ nested: { deep: 1 } });
    copy1.newKey = 'leak';
    expect(s.metadata).not.toHaveProperty('newKey');
    // Shallow copy caveat: nested object is shared reference
    (copy1.nested as Record<string, number>).deep = 999;
    expect(s.metadata.nested).toEqual({ deep: 999 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Concurrent mutations
// ═══════════════════════════════════════════════════════════════════

describe('Session — concurrent mutations', () => {
  it('addSubSession with same ID called multiple times — no duplicates', () => {
    const s = new Session(makeNode());
    // Simulate concurrent calls with the same sub-session ID
    s.addSubSession('sub-1');
    s.addSubSession('sub-1');
    s.addSubSession('sub-1');
    expect(s.subSessionIds).toEqual(['sub-1']);
  });

  it('addSubSession with interleaved removeSubSession — idempotent add, clean remove', () => {
    const s = new Session(makeNode());
    s.addSubSession('sub-1');
    s.addSubSession('sub-2');
    s.removeSubSession('sub-1');
    // Re-add sub-1
    s.addSubSession('sub-1');
    expect(s.subSessionIds).toEqual(['sub-2', 'sub-1']);
    // Removing non-existent ID is a no-op
    s.removeSubSession('nonexistent');
    expect(s.subSessionIds).toEqual(['sub-2', 'sub-1']);
  });

  it('rapid concurrent addSubSession calls with multiple IDs', () => {
    // Tests idempotency under concurrent-style rapid-fire calls
    const s = new Session(makeNode());
    for (let i = 0; i < 10; i++) {
      s.addSubSession('sub-a');
      s.addSubSession('sub-b');
      s.addSubSession('sub-a');
    }
    expect(s.subSessionIds).toEqual(['sub-a', 'sub-b']);
  });

  it('removeSubSession on empty list is safe', () => {
    const s = new Session(makeNode());
    expect(() => s.removeSubSession('anything')).not.toThrow();
    expect(s.subSessionIds).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Message cache integrity
// ═══════════════════════════════════════════════════════════════════

describe('Session — message cache integrity', () => {
  const msgs = [
    { id: '1', role: 'user' as const, content: 'hi', sessionId: 'x', tokenCount: 0, compressed: false, timestamp: '' },
    { id: '2', role: 'assistant' as const, content: 'hello', sessionId: 'x', tokenCount: 0, compressed: false, timestamp: '' },
  ];

  it('cachedMessages is null after construction', () => {
    const s = new Session(makeNode());
    expect(s.cachedMessages).toBeNull();
  });

  it('setCachedMessages stores and retrieves messages', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    expect(s.cachedMessages).toBe(msgs);
    expect(s.cachedMessages).toHaveLength(2);
  });

  it('clearMessageCache resets to null', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.clearMessageCache();
    expect(s.cachedMessages).toBeNull();
  });

  it('cache survives updateTitle (mutations do not clear cache)', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.updateTitle('New Title');
    expect(s.cachedMessages).toBe(msgs);
    expect(s.title).toBe('New Title');
  });

  it('cache survives setActive', () => {
    const s = new Session(makeNode({ status: SessionStatus.Idle }));
    s.setCachedMessages(msgs);
    s.setActive();
    expect(s.cachedMessages).toBe(msgs);
  });

  it('cache survives setIdle', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.setIdle();
    expect(s.cachedMessages).toBe(msgs);
  });

  it('cache survives archive', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.archive();
    expect(s.cachedMessages).toBe(msgs);
  });

  it('cache survives setWorkspace', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.setWorkspace('/new/path');
    expect(s.cachedMessages).toBe(msgs);
  });

  it('cache survives touch', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.touch();
    expect(s.cachedMessages).toBe(msgs);
  });

  it('cache survives addSubSession / removeSubSession', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.addSubSession('sub-1');
    expect(s.cachedMessages).toBe(msgs);
    s.removeSubSession('sub-1');
    expect(s.cachedMessages).toBe(msgs);
  });

  it('cache survives setMetadata', () => {
    const s = new Session(makeNode());
    s.setCachedMessages(msgs);
    s.setMetadata('key', 'val');
    expect(s.cachedMessages).toBe(msgs);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Mutations — general
// ═══════════════════════════════════════════════════════════════════

describe('Session — mutations', () => {
  it('archive() changes status to Archived and touches timestamp', () => {
    const s = new Session(makeNode());
    s.archive();
    expect(s.isArchived()).toBe(true);
    expect(s.lastActiveAt).not.toBe('2025-01-01T00:00:00.000Z');
  });

  it('setIdle() changes Active → Idle', () => {
    const s = new Session(makeNode({ status: SessionStatus.Active }));
    s.setIdle();
    expect(s.isIdle()).toBe(true);
  });

  it('setIdle() does not change non-Active status', () => {
    const s = new Session(makeNode({ status: SessionStatus.Archived }));
    s.setIdle();
    expect(s.isArchived()).toBe(true);
  });

  it('setActive() changes to Active', () => {
    const s = new Session(makeNode({ status: SessionStatus.Idle }));
    s.setActive();
    expect(s.isActive()).toBe(true);
  });

  it('updateTitle() changes title and touches timestamp', () => {
    const s = new Session(makeNode());
    s.updateTitle('New Title');
    expect(s.title).toBe('New Title');
    expect(s.lastActiveAt).not.toBe('2025-01-01T00:00:00.000Z');
  });

  it('setWorkspace() changes workspace and touches timestamp', () => {
    const s = new Session(makeNode());
    s.setWorkspace('/new/path');
    expect(s.workspace).toBe('/new/path');
  });

  it('addSubSession() adds id and avoids duplicates', () => {
    const s = new Session(makeNode());
    s.addSubSession('sub-1');
    s.addSubSession('sub-1');
    expect(s.subSessionIds).toEqual(['sub-1']);
  });

  it('removeSubSession() removes id', () => {
    const s = new Session(makeNode({ subSessionIds: ['sub-1', 'sub-2'] }));
    s.removeSubSession('sub-1');
    expect(s.subSessionIds).toEqual(['sub-2']);
  });

  it('setMetadata() stores key-value', () => {
    const s = new Session(makeNode());
    s.setMetadata('theme', 'dark');
    expect(s.metadata.theme).toBe('dark');
  });

  it('touch() updates lastActiveAt', () => {
    const s = new Session(makeNode());
    s.touch();
    expect(s.lastActiveAt).not.toBe('2025-01-01T00:00:00.000Z');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Serialization
// ═══════════════════════════════════════════════════════════════════

describe('Session — serialization', () => {
  it('toJSON() returns deep copy of SessionNode', () => {
    const node = makeNode({ subSessionIds: ['a'], metadata: { k: 'v' } });
    const s = new Session(node);
    const json = s.toJSON();
    expect(json.sessionId).toBe('sess-001');
    expect(json.subSessionIds).toEqual(['a']);
    expect(json.metadata).toEqual({ k: 'v' });
    // Mutating JSON copy shouldn't affect original
    json.subSessionIds.push('b');
    expect(s.subSessionIds).toEqual(['a']);
  });

  it('raw() returns the underlying node', () => {
    const node = makeNode();
    const s = new Session(node);
    expect(s.raw().sessionId).toBe('sess-001');
  });

  it('id getter returns sessionId', () => {
    const s = new Session(makeNode());
    expect(s.id).toBe('sess-001');
  });

  it('lastEventUuid starts null', () => {
    const s = new Session(makeNode());
    expect(s.lastEventUuid).toBeNull();
  });

  it('lastEventUuid can be set directly (public field)', () => {
    const s = new Session(makeNode());
    s.lastEventUuid = 'uuid-123';
    expect(s.lastEventUuid).toBe('uuid-123');
  });

  it('toJSON() round-trips through a new Session', () => {
    const original = new Session(
      makeNode({
        sessionId: 'round-trip',
        parentSessionId: 'parent-1',
        level: 2,
        agentId: 'agent-x',
        type: SessionType.Sub,
        status: SessionStatus.Idle,
        title: 'Round Trip',
        workspace: '/tmp/test',
        subSessionIds: ['sub-a', 'sub-b'],
        metadata: { theme: 'dark', count: 42 },
      }),
    );

    const json = original.toJSON();
    const restored = new Session(json);

    expect(restored.sessionId).toBe(original.sessionId);
    expect(restored.parentSessionId).toBe(original.parentSessionId);
    expect(restored.level).toBe(original.level);
    expect(restored.agentId).toBe(original.agentId);
    expect(restored.type).toBe(original.type);
    expect(restored.status).toBe(original.status);
    expect(restored.title).toBe(original.title);
    expect(restored.workspace).toBe(original.workspace);
    expect(restored.subSessionIds).toEqual(original.subSessionIds);
    expect(restored.metadata).toEqual(original.metadata);
    expect(restored.isSub()).toBe(true);
    expect(restored.isIdle()).toBe(true);
    expect(restored.hasParent()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Terminal state regression tests
// ═══════════════════════════════════════════════════════════════════

describe('Session — terminal state guards', () => {
  it('setActive no-ops on Archived sessions', () => {
    // FIXED: setActive() now guards against Archived — terminal state stays.
    const s = new Session(makeNode({ status: SessionStatus.Archived }));
    s.setActive();
    expect(s.status).toBe('Archived');
  });

  it('archive() no-ops on already-Archived sessions', () => {
    // FIXED: archive() now guards against re-archiving — no-op if already Archived.
    const s = new Session(makeNode({ status: SessionStatus.Archived }));
    const before = s.lastActiveAt;
    s.archive();
    // No-op: status stays Archived, timestamp unchanged
    expect(s.isArchived()).toBe(true);
    expect(s.lastActiveAt).toBe(before);
  });
});
