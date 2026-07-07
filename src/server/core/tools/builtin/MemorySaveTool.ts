// MemorySaveTool - save a memory entry
// Writes to the appropriate MEMORY.md file using MemoryManager.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';

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
        name: { type: 'string', description: 'Short descriptive name for the memory entry.' },
        content: { type: 'string', description: 'Full content of the memory entry to save.' },
      },
      required: ['scope', 'type', 'name', 'content'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const scope = params.scope as string;
    const type = params.type as string;
    const name = params.name as string;
    const content = params.content as string;

    try {
      const mm = MemoryManager.getInstance();
      const effectiveScope = scopeParam(scope, ctx.sessionId);
      const entry = await mm.saveFromParams(ctx.agentId, { scope: effectiveScope, type, name, content });
      return this.makeResult(
        `Memory saved: "${entry.name}" (${entry.type}) in ${scope} scope.`,
        { structured: { scope: effectiveScope, type, name: entry.name, agentId: ctx.agentId, status: 'saved', sessionId: ctx.sessionId } },
      );
    } catch (err) {
      return this.makeError(`Failed to save memory: ${(err as Error).message}`);
    }
  }
}
