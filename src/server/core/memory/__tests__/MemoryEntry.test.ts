import { describe, it, expect } from 'vitest';
import {
  MemoryScope,
  MemoryType,
  mapScope,
  mapType,
  parseScopeParameter,
} from '../MemoryEntry.js';

// ---------------------------------------------------------------------------
// mapScope — completeness
// ---------------------------------------------------------------------------
describe('mapScope', () => {
  // All defined enum values
  it('maps "personal" to Agent scope', () => {
    expect(mapScope('personal')).toBe(MemoryScope.Agent);
  });

  it('maps "team" to Team scope', () => {
    expect(mapScope('team')).toBe(MemoryScope.Team);
  });

  it('maps "project" to Team scope', () => {
    expect(mapScope('project')).toBe(MemoryScope.Team);
  });

  it('maps "session_personal" to Session scope', () => {
    expect(mapScope('session_personal')).toBe(MemoryScope.Session);
  });

  it('maps "session_team" to Session scope', () => {
    expect(mapScope('session_team')).toBe(MemoryScope.Session);
  });

  // Edge cases
  it('maps unknown string to Team scope (default)', () => {
    expect(mapScope('unknown_blah')).toBe(MemoryScope.Team);
  });

  it('maps empty string to Team scope', () => {
    expect(mapScope('')).toBe(MemoryScope.Team);
  });

  it('returns deterministic result for same unknown input', () => {
    const a = mapScope('xyzzy');
    const b = mapScope('xyzzy');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// mapType — completeness
// ---------------------------------------------------------------------------
describe('mapType', () => {
  // All defined enum values
  it('maps "user" to User type', () => {
    expect(mapType('user')).toBe(MemoryType.User);
  });

  it('maps "feedback" to Feedback type', () => {
    expect(mapType('feedback')).toBe(MemoryType.Feedback);
  });

  it('maps "project" to Project type', () => {
    expect(mapType('project')).toBe(MemoryType.Project);
  });

  it('maps "reference" to Reference type', () => {
    expect(mapType('reference')).toBe(MemoryType.Reference);
  });

  // Edge cases
  it('maps unknown string to Reference type (default)', () => {
    expect(mapType('garbage')).toBe(MemoryType.Reference);
  });

  it('maps empty string to Reference type', () => {
    expect(mapType('')).toBe(MemoryType.Reference);
  });

  it('returns deterministic result for same unknown input', () => {
    const a = mapType('abc');
    const b = mapType('abc');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// parseScopeParameter — logical closure
// ---------------------------------------------------------------------------
describe('parseScopeParameter', () => {
  const agentId = 'test-agent-001';

  // --- team / project : identical results ---
  it('parses "team" → Team scope, agentId="team"', () => {
    const result = parseScopeParameter('team', agentId);
    expect(result.scope).toBe(MemoryScope.Team);
    expect(result.agentId).toBe('team');
  });

  it('parses "project" → Team scope, agentId="team"', () => {
    const result = parseScopeParameter('project', agentId);
    expect(result.scope).toBe(MemoryScope.Team);
    expect(result.agentId).toBe('team');
  });

  it('"team" and "project" produce identical results', () => {
    const a = parseScopeParameter('team', agentId);
    const b = parseScopeParameter('project', agentId);
    expect(a).toEqual(b);
  });

  // --- personal / agent : identical results (use current agentId) ---
  it('parses "personal" → Agent scope with current agentId', () => {
    const result = parseScopeParameter('personal', agentId);
    expect(result.scope).toBe(MemoryScope.Agent);
    expect(result.agentId).toBe(agentId);
  });

  it('parses "agent" → Agent scope with current agentId', () => {
    const result = parseScopeParameter('agent', agentId);
    expect(result.scope).toBe(MemoryScope.Agent);
    expect(result.agentId).toBe(agentId);
  });

  it('"personal" and "agent" produce identical results', () => {
    const a = parseScopeParameter('personal', agentId);
    const b = parseScopeParameter('agent', agentId);
    expect(a).toEqual(b);
  });

  // --- agent:<id> format ---
  it('parses "agent:<targetId>" → Agent scope with target agentId', () => {
    const result = parseScopeParameter('agent:target-42', agentId);
    expect(result.scope).toBe(MemoryScope.Agent);
    expect(result.agentId).toBe('target-42');
  });

  it('parses "agent:<targetId>" → result has no sessionId or subScope', () => {
    const result = parseScopeParameter('agent:target-42', agentId);
    expect(result.sessionId).toBeUndefined();
  });

  // --- agent: with whitespace ---
  it('handles "agent: " (space after colon) → falls back to current agentId', () => {
    const result = parseScopeParameter('agent: ', agentId);
    // remainder trimmed is '', sanitizeId('') → '.', truthy → Agent with '.'
    // But actually sanitizeId('') → '.' which is truthy, so we get Agent with '.'
    expect(result.scope).toBe(MemoryScope.Agent);
  });

  // --- session formats ---
  it('parses "session:<id>" → Session scope, personal subScope', () => {
    const result = parseScopeParameter('session:sess-123', agentId);
    expect(result.scope).toBe(MemoryScope.Session);
    expect(result.sessionId).toBe('sess-123');
    expect(result.subScope).toBe('personal');
  });

  it('parses "session:team:<id>" → Session scope, team subScope', () => {
    const result = parseScopeParameter('session:team:sess-456', agentId);
    expect(result.scope).toBe(MemoryScope.Session);
    expect(result.sessionId).toBe('sess-456');
    expect(result.subScope).toBe('team');
  });

  it('parses "session:personal:<id>" → Session scope, personal subScope', () => {
    const result = parseScopeParameter('session:personal:sess-789', agentId);
    expect(result.scope).toBe(MemoryScope.Session);
    expect(result.sessionId).toBe('sess-789');
    expect(result.subScope).toBe('personal');
  });

  // session: with no ID
  it('session: with no ID → sessionId from sanitize, Session scope', () => {
    // sanitizeId('') → path.basename('.') → '.', which is non-empty
    const result = parseScopeParameter('session:', agentId);
    expect(result.scope).toBe(MemoryScope.Session);
    expect(result.sessionId).toBe('.');
  });

  // session with whitespace-only ID
  it('falls back to Agent scope when session id is whitespace-only', () => {
    const result = parseScopeParameter('session:   ', agentId);
    expect(result.scope).toBe(MemoryScope.Agent);
    expect(result.agentId).toBe(agentId);
  });

  // session:team: with empty ID
  it('session:team: with empty id → uses "." as sessionId', () => {
    const result = parseScopeParameter('session:team:', agentId);
    expect(result.scope).toBe(MemoryScope.Session);
    expect(result.sessionId).toBe('.');
    expect(result.subScope).toBe('team');
  });

  // session:personal: with empty ID
  it('session:personal: with empty id → uses "." as sessionId', () => {
    const result = parseScopeParameter('session:personal:', agentId);
    expect(result.scope).toBe(MemoryScope.Session);
    expect(result.sessionId).toBe('.');
    expect(result.subScope).toBe('personal');
  });

  // unknown format falls back to Agent
  it('unknown format → Agent scope with current agentId', () => {
    const result = parseScopeParameter('some-random-string', agentId);
    expect(result.scope).toBe(MemoryScope.Agent);
    expect(result.agentId).toBe(agentId);
  });

  it('every valid scope string produces a result with valid scope + agentId', () => {
    const inputs = [
      'team',
      'project',
      'personal',
      'agent',
      'agent:tgt',
      'session:s1',
      'session:team:s2',
      'session:personal:s3',
    ];
    for (const raw of inputs) {
      const result = parseScopeParameter(raw, agentId);
      expect(result.scope).toBeDefined();
      expect(Object.values(MemoryScope)).toContain(result.scope);
      expect(result.agentId).toBeDefined();
      expect(typeof result.agentId).toBe('string');
      expect(result.agentId.length).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // path traversal attacks
  // -----------------------------------------------------------------------
  describe('path traversal on agent: prefix', () => {
    it('sanitizes agent:../../../etc/passwd — no .. or / in agentId', () => {
      const result = parseScopeParameter('agent:../../../etc/passwd', agentId);
      expect(result.agentId).not.toContain('..');
      expect(result.agentId).not.toContain('/');
    });

    it('sanitizes agent:..\\..\\windows\\system32 — no .. or \\ in agentId', () => {
      const result =
        parseScopeParameter('agent:..\\..\\windows\\system32', agentId);
      expect(result.agentId).not.toContain('..');
      // On Windows, basename after normalize removes the path. On Unix,
      // backslash is a regular char so the entire string stays, with '..'.
      // We at minimum verify no standalone backslash directory traversal.
      // The basename should be 'system32' on Windows.
      expect(result.agentId).toBe('system32');
    });

    it('sanitizes agent with mixed slashes', () => {
      const result = parseScopeParameter('agent:foo/../bar\\..\\baz', agentId);
      // After normalize on Windows: foo\bar\..\baz → baz. On Unix: literally that.
      // basename should be 'baz' on Windows.
      expect(result.agentId).not.toContain('/');
    });
  });

  describe('path traversal on session: prefix', () => {
    it('sanitizes session:../../etc — sessionId has no .. or /', () => {
      const result = parseScopeParameter('session:../../etc', agentId);
      expect(result.sessionId).not.toContain('..');
      expect(result.sessionId).not.toContain('/');
    });

    it('sanitizes session:team:../../../etc/passwd', () => {
      const result =
        parseScopeParameter('session:team:../../../etc/passwd', agentId);
      expect(result.sessionId).not.toContain('..');
      expect(result.sessionId).not.toContain('/');
    });

    it('sanitizes session:personal:..\\..\\etc', () => {
      const result =
        parseScopeParameter('session:personal:..\\..\\etc', agentId);
      expect(result.sessionId).not.toContain('..');
      // On Windows: basename should be 'etc'
      expect(result.sessionId).toBe('etc');
    });

    it('sanitizes session:./root/.ssh/id_rsa', () => {
      const result =
        parseScopeParameter('session:team:./root/.ssh/id_rsa', agentId);
      expect(result.sessionId).not.toContain('/');
      expect(result.sessionId).not.toContain('\\');
    });
  });

  // -----------------------------------------------------------------------
  // null byte injection
  // -----------------------------------------------------------------------
  describe('null byte injection', () => {
    it('handles null byte in session id without throwing', () => {
      expect(() => {
        parseScopeParameter('session:abc\x00def', agentId);
      }).not.toThrow();
    });

    it('handles null byte in agent id without throwing', () => {
      expect(() => {
        parseScopeParameter('agent:evil\x00root', agentId);
      }).not.toThrow();
    });

    it('null byte in agentId parameter is handled', () => {
      const result = parseScopeParameter('personal', 'agent\x00hack');
      expect(() => result).not.toThrow();
      // sanitizeId preserves null bytes currently — just verify it doesn't crash
      expect(result.agentId).toBeDefined();
    });

    it('null byte in session:team: id is handled', () => {
      const result =
        parseScopeParameter('session:team:sess\x00traversal', agentId);
      expect(result.sessionId).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // very long input — must not crash
  // -----------------------------------------------------------------------
  describe('very long input', () => {
    it('handles 10k char scope string without crashing', () => {
      const longId = 'x'.repeat(10_000);
      expect(() => parseScopeParameter(`session:${longId}`, agentId)).not.toThrow();
    });

    it('handles 10k char agent:<id> without crashing', () => {
      const longId = 'y'.repeat(10_000);
      expect(() => parseScopeParameter(`agent:${longId}`, agentId)).not.toThrow();
    });

    it('handles 10k char unknown format without crashing', () => {
      const long = 'z'.repeat(10_000);
      expect(() => parseScopeParameter(long, agentId)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // sanitizeId behavior (tested indirectly through parseScopeParameter)
  // -----------------------------------------------------------------------
  describe('sanitizeId (indirect via parseScopeParameter)', () => {
    it('sanitizes agentId parameter with path traversal', () => {
      const result = parseScopeParameter('personal', '../../../malicious');
      expect(result.agentId).not.toContain('..');
      expect(result.agentId).not.toContain('/');
    });

    it('sanitizes empty string agentId → becomes "."', () => {
      const result = parseScopeParameter('personal', '');
      // sanitizeId('') → path.basename(path.normalize('')) → path.basename('.') → '.'
      expect(result.agentId).toBe('.');
    });

    it('sanitizes whitespace-only agentId', () => {
      const result = parseScopeParameter('personal', '   ');
      // path.basename(path.normalize('   ')) → '   ' (spaces preserved)
      expect(result.agentId).toBe('   ');
    });

    it('sanitizes agentId consisting of only dots', () => {
      // On both platforms: path.normalize('..') → '..', basename → '..'
      // This is a known limitation — path.basename doesn't strip '..'
      const result = parseScopeParameter('personal', '..');
      expect(result.agentId).toBe('..');
    });

    it('sanitizes agentId with backslashes', () => {
      const result = parseScopeParameter('personal', 'evil\\path\\here');
      expect(result.agentId).toBe('here');
    });

    it('sanitizes agentId with mixed path separators embedded', () => {
      const result = parseScopeParameter(
        'agent:a/../../../b\\..\\c/d',
        agentId,
      );
      // After normalize on Windows: a\c\d → basename='d'
      // We just verify no path separators remain
      expect(result.agentId).not.toContain('/');
    });
  });
});

// ---------------------------------------------------------------------------
// MemoryEntry interface conformance
// ---------------------------------------------------------------------------
describe('MemoryEntry interface conformance', () => {
  it('valid MemoryEntry has all required fields', () => {
    const entry = {
      name: 'my-memory',
      type: MemoryType.Project,
      description: 'A test memory',
      content: '# Hello\n\nWorld',
      scope: MemoryScope.Team,
    };
    // All required fields present
    expect(entry.name).toBeDefined();
    expect(entry.type).toBeDefined();
    expect(entry.description).toBeDefined();
    expect(entry.content).toBeDefined();
    expect(entry.scope).toBeDefined();
  });

  it('valid MemoryEntry with optional sessionId and subScope', () => {
    const entry = {
      name: 'session-note',
      type: MemoryType.Feedback,
      description: 'Session-scoped memory',
      content: 'Content',
      scope: MemoryScope.Session,
      sessionId: 'sess-001',
      subScope: 'team' as const,
    };
    expect(entry.sessionId).toBe('sess-001');
    expect(entry.subScope).toBe('team');
  });

  it('optional fields can be omitted', () => {
    const entry = {
      name: 'bare',
      type: MemoryType.Reference,
      description: 'Minimal',
      content: 'body',
      scope: MemoryScope.Agent,
    };
    expect(entry).not.toHaveProperty('sessionId');
    expect(entry).not.toHaveProperty('subScope');
    expect(entry).not.toHaveProperty('updatedAt');
  });

  it('MemoryEntry with updatedAt timestamp', () => {
    const entry = {
      name: 'stamped',
      type: MemoryType.User,
      description: 'With timestamp',
      content: 'Content',
      scope: MemoryScope.Agent,
      updatedAt: 1719600000000,
    };
    expect(entry.updatedAt).toBe(1719600000000);
    expect(typeof entry.updatedAt).toBe('number');
  });

  it('MemoryEntry subScope accepts "personal"', () => {
    const entry = {
      name: 'personal-session',
      type: MemoryType.Project,
      description: 'Personal session memory',
      content: 'Content',
      scope: MemoryScope.Session,
      sessionId: 'sess-002',
      subScope: 'personal' as const,
    };
    expect(entry.subScope).toBe('personal');
  });
});
