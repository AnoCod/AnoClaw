import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { MemoryManager } from '../../memory/MemoryManager.js';

export const sectionMeta = {
  name: 'memory',
  type: 'dynamic' as const,
  priority: 110,
};

export function createMemorySection(): SystemPromptSection {
  return {
    name: 'Memory',
    cacheBreak: false,
    compute: (ctx: PromptContext) => {
      const mm = MemoryManager.getInstance();
      const recent = [
        ...mm.getRecentMemories('team', 'team', 3),
        ...mm.getRecentMemories('agent', ctx.agentId, 5),
        ...mm.getRecentMemories('session', ctx.sessionId, 5),
      ];

      const lines: string[] = [
        '# Memory Index',
        '',
        'Memories are shown as a compact index. Recall full content only when it is relevant to the current task.',
        '',
      ];

      if (recent.length === 0) {
        lines.push('No recent memories are available. Save durable facts, decisions, or lessons with memory_save when they will help future work.');
        return lines.join('\n');
      }

      let totalEstimate = 0;
      lines.push('| # | Scope | Type | Summary | Est. tokens |');
      lines.push('|---|---|---|---|---|');
      for (let i = 0; i < recent.length; i++) {
        const memory = recent[i];
        const estimate = Math.ceil(memory.content.length / 4);
        totalEstimate += estimate;
        lines.push(`| ${i + 1} | ${memory.scope || 'agent'} | ${memory.type} | ${memory.description.slice(0, 80)} | ~${estimate} |`);
      }

      lines.push('');
      lines.push(`Total if fully loaded: ~${totalEstimate} tokens. Use memory_recall with the index number or name when details are needed.`);
      return lines.join('\n');
    },
  };
}
