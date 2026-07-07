// MemorySearchTool - search agent memories
// Searches personal and team memories using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope } from '../../memory/MemoryEntry.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SNIPPET_CHARS = 200;
const MAX_SNIPPET_CHARS = 1000;

export class MemorySearchTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Searches durable memory for relevant project, user, team, or session knowledge.';
  name(): string { return 'memory_search'; }

  description(): string {
    return 'Search memory across personal, team, session, or all scopes. Use before unfamiliar work or when past decisions may matter.';
  }

  prompt(): string {
    return [
      '## memory_search Usage',
      'Search memory when previous context could improve accuracy: project conventions, past bugs, user preferences, or prior decisions.',
      '',
      'Use broad all-scope search for unfamiliar work, team scope for shared project rules, and personal scope for your own lessons.',
      'After finding a relevant entry, use memory_recall for full content only when the summary is insufficient.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query - keywords or phrases to find in memories. Supports fuzzy matching (typo-tolerant) and cross-language synonyms (e.g. "logging" matches "logging").' },
        scope: { type: 'string', enum: ['team', 'personal', 'session_personal', 'session_team', 'all'], description: 'Scope to search. Default: "all". session_personal/session_team search session-scoped.' },
        fuzzy: { type: 'boolean', description: 'Enable fuzzy/semantic matching with typo tolerance. Default: true (always on).' },
        limit: { type: 'number', description: `Maximum memories to return. Default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT}.` },
        max_snippet_chars: { type: 'number', description: `Maximum content preview characters per memory. Default: ${DEFAULT_SNIPPET_CHARS}, max: ${MAX_SNIPPET_CHARS}.` },
      },
      required: ['query'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const queryResult = normalizeString(params.query, 'query');
    if (queryResult.error) return this.makeError(queryResult.error);
    const query = queryResult.value!;
    const scope = (params.scope as string) || 'all';
    const fuzzy = params.fuzzy !== false; // default true
    const limitResult = normalizeInteger(params.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limitResult.error) return this.makeError(limitResult.error);
    const snippetResult = normalizeInteger(params.max_snippet_chars, 'max_snippet_chars', DEFAULT_SNIPPET_CHARS, 40, MAX_SNIPPET_CHARS);
    if (snippetResult.error) return this.makeError(snippetResult.error);
    const limit = limitResult.value!;
    const maxSnippetChars = snippetResult.value!;

    if (!['team', 'personal', 'session_personal', 'session_team', 'all'].includes(scope)) {
      return this.makeError(`Invalid memory scope "${scope}". Expected one of: team, personal, session_personal, session_team, all.`);
    }

    try {
      const mm = MemoryManager.getInstance();
      let entries;
      if (scope === 'personal') {
        entries = await mm.search(ctx.agentId, MemoryScope.Agent, query, undefined, undefined, fuzzy);
      } else if (scope === 'team') {
        entries = await mm.search(ctx.agentId, MemoryScope.Team, query, undefined, undefined, fuzzy);
      } else if (scope === 'session_personal') {
        entries = await mm.search(ctx.agentId, MemoryScope.Session, query, ctx.sessionId, 'personal', fuzzy);
      } else if (scope === 'session_team') {
        entries = await mm.search(ctx.agentId, MemoryScope.Session, query, ctx.sessionId, 'team', fuzzy);
      } else {
        entries = await mm.searchAllScopes(ctx.agentId, query, ctx.sessionId);
      }

      if (entries.length === 0) {
        return this.makeResult(`No memories found for query "${query}" in ${scope} scope.`, {
          structured: { query, scope, count: 0, returned: 0, limit, entries: [] },
        });
      }

      const returnedEntries = entries.slice(0, limit);
      const lines = [
        `Found ${entries.length} memories for "${query}" in ${scope} scope` +
        (entries.length > returnedEntries.length ? ` (showing ${returnedEntries.length})` : '') +
        ':',
        '',
      ];
      for (const e of returnedEntries) {
        const snippet = truncate(e.content, maxSnippetChars);
        lines.push(`- [${e.type}] **${e.name}** (${e.scope}): ${snippet}`);
      }
      return this.makeResult(lines.join('\n'), {
        structured: {
          query,
          scope,
          count: entries.length,
          returned: returnedEntries.length,
          limit,
          maxSnippetChars,
          entries: returnedEntries.map(e => ({
            name: e.name,
            type: e.type,
            scope: e.scope,
            description: e.description,
            snippet: truncate(e.content, maxSnippetChars),
          })),
        },
      });
    } catch (err) {
      return this.makeError(`Failed to search memories: ${(err as Error).message}`);
    }
  }
}

function normalizeString(value: unknown, field: string): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  return { value: trimmed };
}

function normalizeInteger(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${field} must be a finite number` };
  }
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) {
    return { error: `${field} must be between ${min} and ${max}` };
  }
  return { value: normalized };
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 20)).trimEnd()}... [truncated]`;
}
