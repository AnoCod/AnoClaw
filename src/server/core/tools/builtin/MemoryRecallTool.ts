// MemoryRecallTool.ts - fetch full memory content by index or ID
// Part of the progressive disclosure pattern: Section shows index, agent recalls details on demand.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope } from '../../memory/MemoryEntry.js';
import type { MemoryEntry } from '../../memory/MemoryEntry.js';
import {
  V3ScopedMemoryService,
  type V3MemoryEntry,
  type V3MemoryTarget,
} from '../../v3/memory/V3ScopedMemoryService.js';
import {
  assertNoModelSuppliedMemoryTarget,
  parseV3MemoryScope,
  resolveAllV3MemoryTargets,
  resolveV3MemoryTarget,
  v3MemoryContext,
  v3MemoryFailure,
} from '../v3/V3MemoryToolSupport.js';

const DEFAULT_CONTENT_LIMIT = 12000;
const MAX_CONTENT_LIMIT = 50000;
const DEFAULT_MATCH_LIMIT = 5;
const MAX_MATCH_LIMIT = 20;

export class MemoryRecallTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Fetch full content of a memory by its index number (from the Memory section) or by name.';

  constructor(private readonly v3Memory: V3ScopedMemoryService = V3ScopedMemoryService.getInstance()) {
    super();
  }

  name(): string { return 'memory_recall'; }

  description(): string {
    return 'Retrieve full content for a memory in the current company, team, agent, workspace, work, mission, or all accessible scopes.';
  }

  prompt(): string {
    return '## MemoryRecall\n'
      + 'Call this tool with the **index number** shown in the Memory system prompt section, '
      + 'or with a memory ID or **name** to retrieve a specific entry.\n'
      + 'The selected scope is bound to the current server-owned execution context.\n'
      + 'This avoids wasting context tokens on memory content you don\'t need.\n'
      + '**Tool name:** memory_recall\n';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, pattern: '\\S', description: 'Index number (e.g. "3") from the Memory section, or memory name to recall.' },
        scope: { type: 'string', enum: ['company', 'team', 'agent', 'workspace', 'work', 'mission', 'all'], description: 'Current-context scope to search. Default: all.' },
        max_content_chars: { type: 'integer', minimum: 200, maximum: MAX_CONTENT_LIMIT, description: `Maximum full content characters to return per memory. Default: ${DEFAULT_CONTENT_LIMIT}, max: ${MAX_CONTENT_LIMIT}.` },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MATCH_LIMIT, description: `Maximum named matches to return. Default: ${DEFAULT_MATCH_LIMIT}, max: ${MAX_MATCH_LIMIT}.` },
      },
      required: ['id'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const v3Context = v3MemoryContext(ctx.sessionId);
    const idResult = normalizeString(params.id, 'id');
    if (idResult.error) return this.makeError(idResult.error);
    const id = idResult.value!;

    const scopeResult = normalizeEnum(
      params.scope,
      'scope',
      v3Context
        ? ['company', 'team', 'agent', 'workspace', 'work', 'mission', 'all'] as const
        : ['agent', 'personal', 'team', 'session', 'all'] as const,
      'all',
    );
    if (scopeResult.error) return this.makeError(scopeResult.error);
    const scope = scopeResult.value!;

    const contentLimitResult = normalizeInteger(params.max_content_chars, 'max_content_chars', DEFAULT_CONTENT_LIMIT, 200, MAX_CONTENT_LIMIT);
    if (contentLimitResult.error) return this.makeError(contentLimitResult.error);
    const matchLimitResult = normalizeInteger(params.limit, 'limit', DEFAULT_MATCH_LIMIT, 1, MAX_MATCH_LIMIT);
    if (matchLimitResult.error) return this.makeError(matchLimitResult.error);
    const maxContentChars = contentLimitResult.value!;
    const limit = matchLimitResult.value!;

    try {
      if (v3Context) {
        assertNoModelSuppliedMemoryTarget(params);
        const targets = scope === 'all'
          ? resolveAllV3MemoryTargets(v3Context)
          : [resolveV3MemoryTarget(v3Context, parseV3MemoryScope(scope)!)];
        return await this.recallV3(
          targets,
          id,
          scope,
          maxContentChars,
          limit,
        );
      }

      const mm = MemoryManager.getInstance();
      const scopes: MemoryScope[] = (scope === 'agent' || scope === 'personal') ? [MemoryScope.Agent]
        : scope === 'team' ? [MemoryScope.Team]
        : scope === 'session' ? [MemoryScope.Session]
        : [MemoryScope.Agent, MemoryScope.Team, MemoryScope.Session];

      // Try numeric index first (from the MemorySection index table)
      const numIdx = parseInt(id, 10);
      if (!isNaN(numIdx) && String(numIdx) === id) {
        const allEntries = await loadEntries(mm, ctx.agentId, scopes, '', ctx.sessionId);
        if (numIdx <= 0 || numIdx > allEntries.length) {
          return this.makeResult(`No memory found for index "${id}". Available: ${allEntries.length} memories across ${scope} scope.`, {
            structured: { id, scope, status: 'not_found', available: allEntries.length, maxContentChars, limit },
          });
        }
        const entry = allEntries[numIdx - 1];
        const { content, wasTruncated } = truncate(entry.content, maxContentChars);
        return this.makeResult(
          `## ${entry.name}\nType: ${entry.type} | Scope: ${entry.scope}\n\n${content}\n\n---\n(Full content loaded. Token estimate: ~${Math.ceil(content.length / 4)}${wasTruncated ? '; truncated' : ''}.)`,
          { structured: { id, requestedScope: scope, status: 'found', name: entry.name, type: entry.type, scope: entry.scope, content, wasTruncated, maxContentChars, limit } },
        );
      }

      // Try name/content search without loading every memory into the prompt.
      const searchedEntries = await loadEntries(mm, ctx.agentId, scopes, id, ctx.sessionId);
      const needle = id.toLowerCase();
      const byName = searchedEntries.filter(e =>
        e.name.toLowerCase() === needle || e.name.toLowerCase().includes(needle));
      if (byName.length > 0) {
        const returnedEntries = byName.slice(0, limit);
        const lines = [
          `Found ${byName.length} matching memories` +
          (byName.length > returnedEntries.length ? ` (showing ${returnedEntries.length})` : '') +
          ':',
          '',
        ];
        const structuredEntries = [];
        for (const e of returnedEntries) {
          const { content, wasTruncated } = truncate(e.content, maxContentChars);
          lines.push(`### ${e.name} [${e.type}] (${e.scope})`);
          lines.push(content);
          lines.push('');
          structuredEntries.push({
            name: e.name,
            type: e.type,
            scope: e.scope,
            content,
            wasTruncated,
          });
        }
        return this.makeResult(lines.join('\n'), {
          structured: {
            id,
            scope,
            status: 'found',
            count: byName.length,
            returned: returnedEntries.length,
            maxContentChars,
            limit,
            entries: structuredEntries,
          },
        });
      }

      return this.makeResult(`No memory found for "${id}" across ${scope} scope.`, {
        structured: { id, scope, status: 'not_found', count: 0, maxContentChars, limit },
      });
    } catch (err) {
      if (v3Context) return v3MemoryFailure(err, (message) => this.makeError(message));
      return this.makeError(`Failed to recall memory: ${(err as Error).message}`);
    }
  }

  private async recallV3(
    targets: V3MemoryTarget[],
    id: string,
    requestedScope: string,
    maxContentChars: number,
    limit: number,
  ): Promise<ToolResult> {
    const numericIndex = parseInt(id, 10);
    if (!Number.isNaN(numericIndex) && String(numericIndex) === id) {
      const allEntries = (await Promise.all(targets.map((target) =>
        this.v3Memory.search({ ...target, query: '', limit: 100 }))))
        .flat()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      if (numericIndex <= 0 || numericIndex > allEntries.length) {
        return this.makeResult(
          `No memory found for index "${id}". Available: ${allEntries.length} memories across ${requestedScope} scope.`,
          {
            structured: {
              id,
              scope: requestedScope,
              status: 'not_found',
              available: allEntries.length,
              maxContentChars,
              limit,
            },
          },
        );
      }
      return this.foundSingleV3(
        allEntries[numericIndex - 1],
        id,
        requestedScope,
        maxContentChars,
        limit,
      );
    }

    const exact = (await Promise.all(targets.map((target) => this.v3Memory.get(target, id))))
      .filter((entry): entry is V3MemoryEntry => entry !== null);
    const candidates = exact.length > 0
      ? exact
      : (await Promise.all(targets.map((target) =>
        this.v3Memory.search({ ...target, query: id, limit: 100 }))))
        .flat()
        .filter((entry) => entry.name.toLocaleLowerCase().includes(id.toLocaleLowerCase()));

    if (candidates.length === 0) {
      return this.makeResult(`No memory found for "${id}" across ${requestedScope} scope.`, {
        structured: {
          id,
          scope: requestedScope,
          status: 'not_found',
          count: 0,
          maxContentChars,
          limit,
        },
      });
    }

    const returnedEntries = candidates.slice(0, limit);
    const lines = [
      `Found ${candidates.length} matching memories`
        + (candidates.length > returnedEntries.length ? ` (showing ${returnedEntries.length})` : '')
        + ':',
      '',
    ];
    const structuredEntries = returnedEntries.map((entry) => {
      const { content, wasTruncated } = truncate(entry.content, maxContentChars);
      lines.push(`### ${entry.name} [${entry.type}] (${entry.scope})`);
      lines.push(content, '');
      return {
        id: entry.id,
        name: entry.name,
        type: entry.type,
        scope: entry.scope,
        targetId: entry.targetId,
        content,
        wasTruncated,
      };
    });
    return this.makeResult(lines.join('\n'), {
      structured: {
        id,
        scope: requestedScope,
        status: 'found',
        count: candidates.length,
        returned: returnedEntries.length,
        maxContentChars,
        limit,
        entries: structuredEntries,
      },
    });
  }

  private foundSingleV3(
    entry: V3MemoryEntry,
    id: string,
    requestedScope: string,
    maxContentChars: number,
    limit: number,
  ): ToolResult {
    const { content, wasTruncated } = truncate(entry.content, maxContentChars);
    return this.makeResult(
      `## ${entry.name}\nType: ${entry.type} | Scope: ${entry.scope}\n\n${content}\n\n---\n(Full content loaded. Token estimate: ~${Math.ceil(content.length / 4)}${wasTruncated ? '; truncated' : ''}.)`,
      {
        structured: {
          id,
          requestedScope,
          status: 'found',
          memoryId: entry.id,
          name: entry.name,
          type: entry.type,
          scope: entry.scope,
          targetId: entry.targetId,
          content,
          wasTruncated,
          maxContentChars,
          limit,
        },
      },
    );
  }
}

async function loadEntries(
  mm: MemoryManager,
  agentId: string,
  scopes: MemoryScope[],
  query: string,
  sessionId: string,
): Promise<MemoryEntry[]> {
  const allEntries: MemoryEntry[] = [];
  for (const s of scopes) {
    const entries = await mm.search(agentId, s, query, sessionId);
    allEntries.push(...entries);
  }
  return allEntries;
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
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${field} must be a finite number` };
  if (!Number.isInteger(value)) return { error: `${field} must be an integer` };
  if (value < min || value > max) return { error: `${field} must be between ${min} and ${max}` };
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

function truncate(value: string, limit: number): { content: string; wasTruncated: boolean } {
  if (value.length <= limit) return { content: value, wasTruncated: false };
  const marker = '\n\n... [memory content truncated] ...';
  return { content: value.slice(0, Math.max(0, limit - marker.length)).trimEnd() + marker, wasTruncated: true };
}
