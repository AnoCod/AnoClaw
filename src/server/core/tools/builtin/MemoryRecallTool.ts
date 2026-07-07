// MemoryRecallTool.ts - fetch full memory content by index or ID
// Part of the progressive disclosure pattern: Section shows index, agent recalls details on demand.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope } from '../../memory/MemoryEntry.js';
import type { MemoryEntry } from '../../memory/MemoryEntry.js';

const DEFAULT_CONTENT_LIMIT = 12000;
const MAX_CONTENT_LIMIT = 50000;
const DEFAULT_MATCH_LIMIT = 5;
const MAX_MATCH_LIMIT = 20;

export class MemoryRecallTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Fetch full content of a memory by its index number (from the Memory section) or by name.';

  name(): string { return 'memory_recall'; }

  description(): string {
    return 'Retrieve the full content of a specific memory entry, identified by index number or name. Use this instead of MemorySearch when you already know which entry you want and just need its details. The Memory section in the system prompt shows an indexed list - call this with the index number to get the full content.';
  }

  prompt(): string {
    return '## MemoryRecall\n'
      + 'Call this tool with the **index number** shown in the Memory system prompt section, '
      + 'or with a **name** to retrieve a specific memory by its identifier.\n'
      + 'This avoids wasting context tokens on memory content you don\'t need.\n'
      + '**Tool name:** memory_recall\n';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Index number (e.g. "3") from the Memory section, or memory name to recall.' },
        scope: { type: 'string', enum: ['agent', 'personal', 'team', 'session', 'all'], description: 'Scope to search. Default: all.' },
        max_content_chars: { type: 'number', description: `Maximum full content characters to return per memory. Default: ${DEFAULT_CONTENT_LIMIT}, max: ${MAX_CONTENT_LIMIT}.` },
        limit: { type: 'number', description: `Maximum named matches to return. Default: ${DEFAULT_MATCH_LIMIT}, max: ${MAX_MATCH_LIMIT}.` },
      },
      required: ['id'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const idResult = normalizeString(params.id, 'id');
    if (idResult.error) return this.makeError(idResult.error);
    const id = idResult.value!;
    const scope = (params.scope as string) || 'all';
    const contentLimitResult = normalizeInteger(params.max_content_chars, 'max_content_chars', DEFAULT_CONTENT_LIMIT, 200, MAX_CONTENT_LIMIT);
    if (contentLimitResult.error) return this.makeError(contentLimitResult.error);
    const matchLimitResult = normalizeInteger(params.limit, 'limit', DEFAULT_MATCH_LIMIT, 1, MAX_MATCH_LIMIT);
    if (matchLimitResult.error) return this.makeError(matchLimitResult.error);
    const maxContentChars = contentLimitResult.value!;
    const limit = matchLimitResult.value!;

    try {
      const mm = MemoryManager.getInstance();
      const scopes: MemoryScope[] = (scope === 'agent' || scope === 'personal') ? [MemoryScope.Agent]
        : scope === 'team' ? [MemoryScope.Team]
        : scope === 'session' ? [MemoryScope.Session]
        : scope === 'all' ? [MemoryScope.Agent, MemoryScope.Team, MemoryScope.Session]
        : [];
      if (scopes.length === 0) {
        return this.makeError(`Invalid memory scope "${scope}". Expected one of: agent, personal, team, session, all.`);
      }

      // Try numeric index first (from the MemorySection index table)
      const numIdx = parseInt(id, 10);
      if (!isNaN(numIdx) && String(numIdx) === id) {
        const allEntries = await loadEntries(mm, ctx.agentId, scopes, '', ctx.sessionId);
        if (numIdx <= 0 || numIdx > allEntries.length) {
          return this.makeResult(`No memory found for index "${id}". Available: ${allEntries.length} memories across ${scope} scope.`, {
            structured: { id, scope, status: 'not_found', available: allEntries.length },
          });
        }
        const entry = allEntries[numIdx - 1];
        const { content, wasTruncated } = truncate(entry.content, maxContentChars);
        return this.makeResult(
          `## ${entry.name}\nType: ${entry.type} | Scope: ${entry.scope}\n\n${content}\n\n---\n(Full content loaded. Token estimate: ~${Math.ceil(content.length / 4)}${wasTruncated ? '; truncated' : ''}.)`,
          { structured: { id, status: 'found', name: entry.name, type: entry.type, scope: entry.scope, content, wasTruncated } },
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
            entries: structuredEntries,
          },
        });
      }

      return this.makeResult(`No memory found for "${id}" across ${scope} scope.`, {
        structured: { id, scope, status: 'not_found', count: 0 },
      });
    } catch (err) {
      return this.makeError(`Failed to recall memory: ${(err as Error).message}`);
    }
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
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) return { error: `${field} must be between ${min} and ${max}` };
  return { value: normalized };
}

function truncate(value: string, limit: number): { content: string; wasTruncated: boolean } {
  if (value.length <= limit) return { content: value, wasTruncated: false };
  const marker = '\n\n... [memory content truncated] ...';
  return { content: value.slice(0, Math.max(0, limit - marker.length)).trimEnd() + marker, wasTruncated: true };
}
