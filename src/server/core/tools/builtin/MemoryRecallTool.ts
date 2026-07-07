// MemoryRecallTool.ts - fetch full memory content by index or ID
// Part of the progressive disclosure pattern: Section shows index, agent recalls details on demand.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { MemoryManager } from '../../memory/MemoryManager.js';
import { MemoryScope } from '../../memory/MemoryEntry.js';

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
        scope: { type: 'string', enum: ['agent', 'team', 'session', 'all'], description: 'Scope to search. Default: all.' },
      },
      required: ['id'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const id = String(params.id || '');
    const scope = (params.scope as string) || 'all';

    try {
      const mm = MemoryManager.getInstance();
      const scopes: MemoryScope[] = scope === 'agent' ? [MemoryScope.Agent]
        : scope === 'team' ? [MemoryScope.Team]
        : scope === 'session' ? [MemoryScope.Session]
        : [MemoryScope.Agent, MemoryScope.Team, MemoryScope.Session];

      let allEntries: any[] = [];
      for (const s of scopes) {
        const entries = await mm.search(ctx.agentId, s, '', ctx.sessionId);
        allEntries.push(...entries);
      }

      // Try numeric index first (from the MemorySection index table)
      const numIdx = parseInt(id, 10);
      if (!isNaN(numIdx) && numIdx > 0 && numIdx <= allEntries.length) {
        const entry = allEntries[numIdx - 1];
        return this.makeResult(
          `## ${entry.name}\nType: ${entry.type} | Scope: ${entry.scope}\n\n${entry.content}\n\n---\n(Full content loaded. Token estimate: ~${Math.ceil(entry.content.length / 4)}.)`,
          { structured: { name: entry.name, type: entry.type, scope: entry.scope, content: entry.content } },
        );
      }

      // Try exact name match
      const byName = allEntries.filter(e =>
        e.name.toLowerCase() === id.toLowerCase() || e.name.toLowerCase().includes(id.toLowerCase()));
      if (byName.length > 0) {
        const lines = [`Found ${byName.length} matching memories:`, ''];
        for (const e of byName) {
          lines.push(`### ${e.name} [${e.type}] (${e.scope})`);
          lines.push(e.content);
          lines.push('');
        }
        return this.makeResult(lines.join('\n'));
      }

      return this.makeResult(`No memory found for "${id}". Available: ${allEntries.length} memories across ${scope} scope.`);
    } catch (err) {
      return this.makeError(`Failed to recall memory: ${(err as Error).message}`);
    }
  }
}
