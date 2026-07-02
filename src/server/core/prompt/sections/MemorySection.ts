// MemorySection — lightweight memory index with progressive disclosure
// Shows indexed memory list (~150-200 tokens). Agent calls memory_recall() for full details.

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
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const mm = MemoryManager.getInstance();
      const agentMemories = mm.getRecentMemories('agent', ctx.agentId, 5);
      const teamMemories = mm.getRecentMemories('team', 'team', 3);
      const sessionMemories = mm.getRecentMemories('session', ctx.sessionId, 5);
      const recent = [...teamMemories, ...agentMemories, ...sessionMemories];

      const lines: string[] = [
        '# Memory System (Lightweight Index)',
        '',
        'Available memories are shown below as a SHORT INDEX. Each entry is a summary line with estimated token cost.',
        'Use `memory_recall(id)` to fetch the full content of any entry when you need details.',
        'This saves context — injecting full memory content for all entries would waste precious tokens.',
        '',
      ];

      if (recent.length > 0) {
        let totalEstimate = 0;
        lines.push(`| # | Scope | Type | Summary | Tokens |`);
        lines.push(`|---|---|---|---|---|`);
        for (let i = 0; i < recent.length; i++) {
          const m = recent[i];
          const estimate = Math.ceil(m.content.length / 4); // rough token estimate
          totalEstimate += estimate;
          const summary = m.description.slice(0, 80);
          lines.push(`| ${i + 1} | ${m.scope || 'agent'} | ${m.type} | ${summary} | ~${estimate} |`);
        }
        lines.push('');
        lines.push(`**Total**: ${recent.length} memories, ~${totalEstimate} tokens if fully loaded. Index cost: ~${lines.join('').length / 4} tokens.`);
        lines.push('Use `memory_recall(<number>)` to expand any entry by its index number.');
      } else {
        lines.push('No recent memories available. New session — use `memory_save` to persist important information.');
      }

      return lines.join('\n');
    },
  };
}
