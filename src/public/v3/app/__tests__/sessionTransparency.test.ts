import { afterEach, describe, expect, it, vi } from 'vitest';
import { V3ApiClient } from '../../api/V3ApiClient.js';
import type { Session } from '../../model.js';
import { buildSessionTree, findPrimarySession } from '../sessionTransparency.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function session(
  id: string,
  kind: Session['kind'],
  createdAt: string,
  parentSessionId?: string,
): Session {
  return {
    id,
    workId: 'work-1',
    kind,
    ...(parentSessionId ? { parentSessionId } : {}),
    agentId: kind === 'primary' ? 'main-agent' : `agent-${id}`,
    actorSnapshot: {
      agentId: kind === 'primary' ? 'main-agent' : `agent-${id}`,
      name: kind === 'primary' ? 'MainAgent' : id,
      capabilities: [],
      enabledSkills: [],
      allowedTools: [],
    },
    status: 'idle',
    transcriptRevision: 0,
    createdAt,
  };
}

describe('session transparency', () => {
  it('keeps the Work primary Session selected even when a Run is newer', () => {
    const primary = session('primary', 'primary', '2026-01-01T00:00:00.000Z');
    const newestRun = session(
      'run-newest',
      'run',
      '2026-01-02T00:00:00.000Z',
      primary.id,
    );

    expect(findPrimarySession(
      { primarySessionId: primary.id },
      [newestRun, primary],
    )).toBe(primary);
  });

  it('loads the editable transcript from primarySessionId, not the newest Run', async () => {
    const primary = session('primary', 'primary', '2026-01-01T00:00:00.000Z');
    const newestRun = session(
      'run-newest',
      'run',
      '2026-01-02T00:00:00.000Z',
      primary.id,
    );
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/sessions')) return json([newestRun, primary], 4);
      if (url.includes('/sessions/primary/messages')) {
        return json([{ kind: 'message', id: 'm1', role: 'assistant', content: 'Primary' }], 7);
      }
      return json([], 3);
    }));

    const detail = await new V3ApiClient('/api/v3').loadWork({
      id: 'work-1',
      companyId: 'company-1',
      primarySessionId: primary.id,
      title: 'Work',
      objective: 'Verify session selection',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(detail.transcript).toEqual([
      { kind: 'message', id: 'm1', role: 'assistant', content: 'Primary' },
    ]);
    expect(requested).toContain('/api/v3/sessions/primary/messages?afterSequence=0');
    expect(requested).not.toContain('/api/v3/sessions/run-newest/messages?afterSequence=0');
  });

  it('places orphan Run Sessions under the primary transparency root', () => {
    const primary = session('primary', 'primary', '2026-01-01T00:00:00.000Z');
    const child = session('child', 'run', '2026-01-02T00:00:00.000Z', primary.id);
    const orphan = session('orphan', 'run', '2026-01-03T00:00:00.000Z', 'missing');

    const tree = buildSessionTree([orphan, child, primary], primary.id);

    expect(tree).toHaveLength(1);
    expect(tree[0].session).toBe(primary);
    expect(tree[0].children.map((node) => node.session.id)).toEqual(['child', 'orphan']);
  });
});

function json(data: unknown, revision: number): Response {
  return new Response(JSON.stringify({ data, revision }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
