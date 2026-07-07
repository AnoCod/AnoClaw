import { afterEach, describe, expect, it } from 'vitest';
import { MemorySaveTool } from '../builtin/MemorySaveTool.js';
import { MemorySearchTool } from '../builtin/MemorySearchTool.js';
import { MemoryRecallTool } from '../builtin/MemoryRecallTool.js';
import { MemoryDeleteTool } from '../builtin/MemoryDeleteTool.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope, MemoryType } from '../../memory/MemoryEntry.js';
import type { MemoryEntry } from '../../memory/MemoryEntry.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';

const ctx: ExecutionContext = {
  sessionId: 'memory-session',
  agentId: 'memory-agent',
  workspace: process.cwd(),
  userConfirmed: true,
};

function entry(name: string, content: string, scope = MemoryScope.Agent): MemoryEntry {
  return {
    name,
    content,
    scope,
    type: MemoryType.Reference,
    description: `${name} description`,
  };
}

function setMemoryManager(fake: Record<string, unknown>): void {
  (MemoryManager as unknown as { _instance: unknown })._instance = fake;
}

afterEach(() => {
  (MemoryManager as unknown as { _instance: unknown })._instance = null;
});

describe('Memory tools', () => {
  it('memory_search validates empty queries', async () => {
    setMemoryManager({});

    const result = await new MemorySearchTool().execute({ query: '   ' }, ctx);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('query must not be empty');
  });

  it('memory_search limits and truncates returned entries', async () => {
    const longContent = 'A'.repeat(300);
    setMemoryManager({
      searchAllScopes: async () => [
        entry('first-memory', longContent),
        entry('second-memory', 'short content'),
      ],
    });

    const result = await new MemorySearchTool().execute({
      query: 'memory',
      limit: 1,
      max_snippet_chars: 80,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('showing 1');
    expect(result.content).toContain('truncated');
    const structured = result.structured as {
      count: number;
      returned: number;
      entries: Array<{ name: string; snippet: string }>;
    };
    expect(structured.count).toBe(2);
    expect(structured.returned).toBe(1);
    expect(structured.entries).toEqual([
      expect.objectContaining({ name: 'first-memory' }),
    ]);
    expect(structured.entries[0].snippet.length).toBeLessThanOrEqual(80);
  });

  it('memory_recall searches by name without loading all memories first', async () => {
    const calls: Array<{ scope: MemoryScope; query: string }> = [];
    setMemoryManager({
      search: async (_agentId: string, scope: MemoryScope, query: string) => {
        calls.push({ scope, query });
        return query
          ? [entry('build-policy', 'Use npm test before commit.')]
          : [entry('unrelated', 'This should not be loaded for name search.')];
      },
    });

    const result = await new MemoryRecallTool().execute({
      id: 'build',
      scope: 'personal',
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('build-policy');
    expect(result.content).toContain('Use npm test');
    expect(calls).toEqual([{ scope: MemoryScope.Agent, query: 'build' }]);
    expect(result.structured).toMatchObject({
      id: 'build',
      status: 'found',
      count: 1,
      returned: 1,
    });
  });

  it('memory_recall supports numeric index lookup with truncation metadata', async () => {
    setMemoryManager({
      search: async () => [
        entry('alpha', 'short'),
        entry('beta', 'B'.repeat(1000), MemoryScope.Team),
      ],
    });

    const result = await new MemoryRecallTool().execute({
      id: '2',
      scope: 'team',
      max_content_chars: 300,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('beta');
    expect(result.content).toContain('truncated');
    expect(result.structured).toMatchObject({
      id: '2',
      status: 'found',
      name: 'beta',
      wasTruncated: true,
    });
  });

  it('memory_save validates and forwards description plus effective session scope', async () => {
    const calls: Array<{ agentId: string; params: Record<string, unknown> }> = [];
    setMemoryManager({
      saveFromParams: async (agentId: string, params: Record<string, unknown>) => {
        calls.push({ agentId, params });
        return entry('release-rule', String(params.content), MemoryScope.Session);
      },
    });

    const result = await new MemorySaveTool().execute({
      scope: 'session_team',
      type: 'project',
      name: ' Release Rule ',
      content: ' Run the installer smoke test. ',
      description: 'Release verification rule',
    }, ctx);

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      {
        agentId: ctx.agentId,
        params: expect.objectContaining({
          scope: `session:team:${ctx.sessionId}`,
          type: 'project',
          name: 'Release Rule',
          content: 'Run the installer smoke test.',
          description: 'Release verification rule',
        }),
      },
    ]);
    expect(result.structured).toMatchObject({
      requestedScope: 'session_team',
      scope: `session:team:${ctx.sessionId}`,
      status: 'saved',
    });
  });

  it('memory_delete dry_run checks exact matches without deleting', async () => {
    let removeCalled = false;
    setMemoryManager({
      search: async () => [
        entry('build-policy', 'Use npm test before commit.'),
      ],
      remove: async () => {
        removeCalled = true;
        return true;
      },
    });

    const result = await new MemoryDeleteTool().execute({
      scope: 'personal',
      name: 'build-policy',
      dry_run: true,
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('exists');
    expect(removeCalled).toBe(false);
    expect(result.structured).toMatchObject({
      name: 'build-policy',
      status: 'found',
      dryRun: true,
    });
  });
});
