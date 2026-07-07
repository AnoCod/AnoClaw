// ToolPromptSection — collects per-tool usage guidance (prompt() method)
// and injects it into the system prompt. Separated from ToolsSection so
// API tool schemas remain unaffected.

import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';

export const sectionMeta = {
  name: 'toolprompt',
  type: 'dynamic' as const,
  priority: 155,
};
export function createToolPromptSection(): SystemPromptSection {
  return {
    name: 'ToolPrompt',
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const agent = AgentRegistry.getInstance().agent(ctx.agentId);
      if (!agent) return '';

      const toolRegistry = ToolRegistry.getInstance();
      const allowedNames = mergeAllowedToolNames(agent.allowedTools(), ctx.extraAllowedTools);
      const agentTools = toolRegistry.toolsForAgent(allowedNames, {
        hideUserInteractionTools: ctx.hideUserInteractionTools,
      });

      const prompts: string[] = [];
      for (const t of agentTools) {
        const p = t.prompt();
        if (p) prompts.push(p.trim());
      }

      if (prompts.length === 0) return '';
      return '\n## Tool Usage Guidelines\n\n' + prompts.join('\n\n');
    },
  };
}

function mergeAllowedToolNames(base: string[], extra: string[] | undefined): string[] {
  return Array.from(new Set([
    ...(base || []),
    ...(extra || []),
  ].filter(Boolean)));
}
