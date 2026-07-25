// MemorySaveTool - save a memory entry
// Writes to the appropriate MEMORY.md file using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';

const MAX_MEMORY_CONTENT_CHARS = 50000;

function scopeParam(s: string, sessionId?: string): string {
  if (s === 'session_personal' && sessionId) return `session:personal:${sessionId}`;
  if (s === 'session_team' && sessionId) return `session:team:${sessionId}`;
  return s;
}

export class MemorySaveTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Saves durable facts, preferences, decisions, or lessons to memory.';
  name(): string { return 'memory_save'; }

  description(): string {
    return 'Save a durable memory entry. Use selectively for information future agents or sessions should reuse.';
  }

  prompt(): string {
    return [
      '## memory_save Usage',
      'Save only information with future value: user preferences, project conventions, architecture decisions, recurring bug patterns, or lessons from feedback.',
      '',
      'Do not save temporary task state, obvious facts already in code, single-use paths, or full conversation transcripts.',
      '',
      'Use team scope for shared project knowledge, personal scope for agent-specific lessons, and session scopes for temporary collaboration state.',
      'Use descriptive kebab-case names and concise content with enough context to be useful later.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['personal', 'team', 'project', 'session_personal', 'session_team'], description: 'Scope of the memory. Use session_personal or session_team for session-scoped memories.' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'], description: 'Type of memory entry.' },
        name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S', description: 'Short descriptive name for the memory entry.' },
        content: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_CONTENT_CHARS, pattern: '\\S', description: 'Full content of the memory entry to save.' },
        description: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S', description: 'Optional one-line summary used in memory indexes.' },
      },
      required: ['scope', 'type', 'name', 'content'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const scopeResult = normalizeEnum(params.scope, 'scope', ['personal', 'team', 'project', 'session_personal', 'session_team']);
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

    const scope = scopeResult.value!;
    const type = typeResult.value!;
    const name = nameResult.value!;
    const content = contentResult.value!;

    try {
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
