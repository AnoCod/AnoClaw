// MemorySearchTool - search agent memories
// Searches personal and team memories using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope } from '../../memory/MemoryEntry.js';
import { V3ScopedMemoryService } from '../../v3/memory/V3ScopedMemoryService.js';
import {
  assertNoModelSuppliedMemoryTarget,
  parseV3MemoryScope,
  resolveAllV3MemoryTargets,
  resolveV3MemoryTarget,
  v3MemoryContext,
  v3MemoryFailure,
} from '../v3/V3MemoryToolSupport.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SNIPPET_CHARS = 200;
const MAX_SNIPPET_CHARS = 1000;

export class MemorySearchTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Searches durable scoped memory for relevant shared or execution knowledge.';

  constructor(private readonly v3Memory: V3ScopedMemoryService = V3ScopedMemoryService.getInstance()) {
    super();
  }

  name(): string { return 'memory_search'; }

  description(): string {
    return 'Search company, team, agent, workspace, work, mission, or all current-context memory scopes.';
  }

  prompt(): string {
    return [
      '## memory_search Usage',
      'Search memory when previous context could improve accuracy: workspace conventions, past bugs, user preferences, or prior decisions.',
      '',
      'Use all for broad discovery, team for shared knowledge, agent for private lessons, and work or mission for execution-specific decisions.',
      'Scope target IDs are bound by the server and cannot be supplied by the model.',
      'After finding a relevant entry, use memory_recall for full content only when the summary is insufficient.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, pattern: '\\S', description: 'Search query - keywords or phrases to find in memories. Supports fuzzy matching (typo-tolerant) and cross-language synonyms (e.g. "logging" matches "logging").' },
        scope: { type: 'string', enum: ['company', 'team', 'agent', 'workspace', 'work', 'mission', 'all'], description: 'Current-context scope to search. Default: all.' },
        fuzzy: { type: 'boolean', description: 'Enable fuzzy/semantic matching with typo tolerance. Default: true (always on).' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum memories to return. Default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT}.` },
        max_snippet_chars: { type: 'integer', minimum: 40, maximum: MAX_SNIPPET_CHARS, description: `Maximum content preview characters per memory. Default: ${DEFAULT_SNIPPET_CHARS}, max: ${MAX_SNIPPET_CHARS}.` },
      },
      required: ['query'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const v3Context = v3MemoryContext(ctx.sessionId);
    const queryResult = normalizeString(params.query, 'query');
    if (queryResult.error) return this.makeError(queryResult.error);
    const query = queryResult.value!;

    const scopeResult = normalizeEnum(
      params.scope,
      'scope',
      v3Context
        ? ['company', 'team', 'agent', 'workspace', 'work', 'mission', 'all'] as const
        : ['team', 'personal', 'session_personal', 'session_team', 'all'] as const,
      'all',
    );
    if (scopeResult.error) return this.makeError(scopeResult.error);
    const scope = scopeResult.value!;

    const fuzzyResult = normalizeBoolean(params.fuzzy, 'fuzzy', true);
    if (fuzzyResult.error) return this.makeError(fuzzyResult.error);
    const fuzzy = fuzzyResult.value!;

    const limitResult = normalizeInteger(params.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limitResult.error) return this.makeError(limitResult.error);
    const snippetResult = normalizeInteger(params.max_snippet_chars, 'max_snippet_chars', DEFAULT_SNIPPET_CHARS, 40, MAX_SNIPPET_CHARS);
    if (snippetResult.error) return this.makeError(snippetResult.error);
    const limit = limitResult.value!;
    const maxSnippetChars = snippetResult.value!;

    try {
      if (v3Context) {
        assertNoModelSuppliedMemoryTarget(params);
        const targets = scope === 'all'
          ? resolveAllV3MemoryTargets(v3Context)
          : [resolveV3MemoryTarget(v3Context, parseV3MemoryScope(scope)!)];
        const entries = (await Promise.all(targets.map((target) =>
          this.v3Memory.search({ ...target, query, limit: MAX_LIMIT }))))
          .flat()
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return searchResult(
          entries,
          query,
          scope,
          fuzzy,
          limit,
          maxSnippetChars,
          (content, options) => this.makeResult(content, options),
        );
      }

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

      return searchResult(
        entries,
        query,
        scope,
        fuzzy,
        limit,
        maxSnippetChars,
        (content, options) => this.makeResult(content, options),
      );
    } catch (err) {
      if (v3Context) return v3MemoryFailure(err, (message) => this.makeError(message));
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
  if (!Number.isInteger(value)) {
    return { error: `${field} must be an integer` };
  }
  if (value < min || value > max) {
    return { error: `${field} must be between ${min} and ${max}` };
  }
  return { value };
}

function normalizeBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): { value: boolean; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'boolean') return { error: `${field} must be a boolean` };
  return { value };
}

function normalizeEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  fallback: T[number],
): { value: T[number]; error?: undefined } | { value?: undefined; error: string } {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  if (!allowed.includes(value)) return { error: `${field} must be one of: ${allowed.join(', ')}` };
  return { value };
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 20)).trimEnd()}... [truncated]`;
}

interface SearchResultEntry {
  id?: string;
  name: string;
  type: string;
  scope: string;
  targetId?: string;
  description: string;
  content: string;
}

function searchResult(
  entries: SearchResultEntry[],
  query: string,
  scope: string,
  fuzzy: boolean,
  limit: number,
  maxSnippetChars: number,
  makeResult: (
    content: string,
    options: { structured: Record<string, unknown> },
  ) => ToolResult,
): ToolResult {
  if (entries.length === 0) {
    return makeResult(`No memories found for query "${query}" in ${scope} scope.`, {
      structured: { query, scope, fuzzy, count: 0, returned: 0, limit, entries: [] },
    });
  }

  const returnedEntries = entries.slice(0, limit);
  const lines = [
    `Found ${entries.length} memories for "${query}" in ${scope} scope`
      + (entries.length > returnedEntries.length ? ` (showing ${returnedEntries.length})` : '')
      + ':',
    '',
  ];
  for (const entry of returnedEntries) {
    const snippet = truncate(entry.content, maxSnippetChars);
    lines.push(`- [${entry.type}] **${entry.name}** (${entry.scope}): ${snippet}`);
  }
  return makeResult(lines.join('\n'), {
    structured: {
      query,
      scope,
      fuzzy,
      count: entries.length,
      returned: returnedEntries.length,
      limit,
      maxSnippetChars,
      entries: returnedEntries.map((entry) => ({
        ...(entry.id ? { id: entry.id } : {}),
        name: entry.name,
        type: entry.type,
        scope: entry.scope,
        ...(entry.targetId ? { targetId: entry.targetId } : {}),
        description: entry.description,
        snippet: truncate(entry.content, maxSnippetChars),
      })),
    },
  });
}
