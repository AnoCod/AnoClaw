// MemorySaveTool - save a memory entry
// Writes to the appropriate MEMORY.md file using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { V3ScopedMemoryService } from '../../v3/memory/V3ScopedMemoryService.js';
import {
  assertNoModelSuppliedMemoryTarget,
  parseV3MemoryScope,
  resolveV3MemoryTarget,
  v3MemoryContext,
  v3MemoryFailure,
} from '../v3/V3MemoryToolSupport.js';

const MAX_MEMORY_CONTENT_CHARS = 50000;

function scopeParam(s: string, sessionId?: string): string {
  if (s === 'session_personal' && sessionId) return `session:personal:${sessionId}`;
  if (s === 'session_team' && sessionId) return `session:team:${sessionId}`;
  return s;
}

export class MemorySaveTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Saves durable facts, preferences, decisions, or lessons to memory.';

  constructor(private readonly v3Memory: V3ScopedMemoryService = V3ScopedMemoryService.getInstance()) {
    super();
  }

  name(): string { return 'memory_save'; }

  description(): string {
    return 'Save a durable memory entry. Use selectively for information future agents or sessions should reuse.';
  }

  prompt(): string {
    return [
      '## memory_save Usage',
      'Save only information with future value: user preferences, workspace conventions, architecture decisions, recurring bug patterns, or lessons from feedback.',
      '',
      'Do not save temporary task state, obvious facts already in code, single-use paths, or full conversation transcripts.',
      '',
      'Choose company, team, agent, workspace, work, or mission scope. The server binds that scope to the current execution context; target IDs are never model-supplied.',
      'Use descriptive kebab-case names and concise content with enough context to be useful later.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['company', 'team', 'agent', 'workspace', 'work', 'mission'], description: 'Durable scope within the current server-owned execution context.' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Type of memory entry.' },
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S', description: 'Short descriptive name for the memory entry.' },
        content: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_CONTENT_CHARS, pattern: '\\S', description: 'Full content of the memory entry to save.' },
        description: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S', description: 'Optional one-line summary used in memory indexes.' },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S', description: 'Optional stable key for safe retry of the same save.' },
      },
      required: ['scope', 'type', 'name', 'content'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const v3Context = v3MemoryContext(ctx.sessionId);
    const scopeResult = normalizeEnum(
      params.scope,
      'scope',
      v3Context
        ? ['company', 'team', 'agent', 'workspace', 'work', 'mission']
        : ['personal', 'team', 'project', 'session_personal', 'session_team'],
    );
    if (scopeResult.error) return this.makeError(scopeResult.error);
    const typeResult = normalizeEnum(params.type, 'type', ['user', 'feedback', 'project', 'reference']);
    if (typeResult.error) return this.makeError(typeResult.error);
    const nameResult = normalizeString(params.name, 'name');
    if (nameResult.error) return this.makeError(nameResult.error);
    const contentResult = normalizeString(params.content, 'content', MAX_MEMORY_CONTENT_CHARS);
    if (contentResult.error) return this.makeError(contentResult.error);
    let description: string | undefined;
    if (params.description !== undefined && params.description !== null) {
      const descriptionResult = normalizeString(params.description, 'description', 500);
      if (descriptionResult.error) return this.makeError(descriptionResult.error);
      description = descriptionResult.value;
    }
    let idempotencyKey: string | undefined;
    if (params.idempotency_key !== undefined && params.idempotency_key !== null) {
      const idempotencyResult = normalizeString(params.idempotency_key, 'idempotency_key', 200);
      if (idempotencyResult.error) return this.makeError(idempotencyResult.error);
      idempotencyKey = idempotencyResult.value;
    }

    const scope = scopeResult.value!;
    const type = typeResult.value!;
    const name = nameResult.value!;
    const content = contentResult.value!;

    try {
      if (v3Context) {
        assertNoModelSuppliedMemoryTarget(params);
        const v3Scope = parseV3MemoryScope(scope);
        if (!v3Scope) return this.makeError(`scope must be a v3 memory scope`);
        const target = resolveV3MemoryTarget(v3Context, v3Scope);
        const entry = await this.v3Memory.save({
          ...target,
          type: type as 'user' | 'feedback' | 'project' | 'reference',
          name,
          content,
          ...(description ? { description } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        return this.makeResult(
          `Memory saved: "${entry.name}" (${entry.type}) in ${entry.scope} scope.`,
          {
            structured: {
              id: entry.id,
              scope: entry.scope,
              targetId: entry.targetId,
              type: entry.type,
              name: entry.name,
              description: entry.description,
              status: 'saved',
              contentChars: entry.content.length,
            },
          },
        );
      }

      const mm = MemoryManager.getInstance();
      const effectiveScope = scopeParam(scope, ctx.sessionId);
      const entry = await mm.saveFromParams(ctx.agentId, { scope: effectiveScope, type, name, content, description });
      return this.makeResult(
        `Memory saved: "${entry.name}" (${entry.type}) in ${scope} scope.`,
        {
          structured: {
            scope: effectiveScope,
            requestedScope: scope,
            type,
            name: entry.name,
            description: entry.description,
            agentId: ctx.agentId,
            status: 'saved',
            sessionId: ctx.sessionId,
            contentChars: content.length,
          },
        },
      );
    } catch (err) {
      if (v3Context) return v3MemoryFailure(err, (message) => this.makeError(message));
      return this.makeError(`Failed to save memory: ${(err as Error).message}`);
    }
  }
}

function normalizeString(
  value: unknown,
  field: string,
  maxLength = 200,
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${field} must not be empty` };
  if (trimmed.length > maxLength) return { error: `${field} must be ${maxLength} characters or less` };
  return { value: trimmed };
}

function normalizeEnum(
  value: unknown,
  field: string,
  allowed: string[],
): { value: string; error?: undefined } | { value?: undefined; error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  if (!allowed.includes(value)) return { error: `${field} must be one of: ${allowed.join(', ')}` };
  return { value };
}
