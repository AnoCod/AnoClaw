// ToolsSection — available tools listing from ToolRegistry
import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';


export const sectionMeta = {
  name: 'tools',
  type: 'dynamic' as const,
  priority: 160,
};
export function createToolsSection(): SystemPromptSection {
  return {
    name: 'Tools',
    cacheBreak: true, // Plugin tool registration has no cache invalidation hook — must recompute
    compute: (ctx: PromptContext) => {
      const agent = AgentRegistry.getInstance().agent(ctx.agentId);
      if (!agent) {
        return '# Available tools\n\nNo agent configured.';
      }

      const toolRegistry = ToolRegistry.getInstance();
      const allowedNames = mergeAllowedToolNames(agent.allowedTools(), ctx.extraAllowedTools);
      const agentTools = toolRegistry.toolsForAgent(allowedNames, {
        hideUserInteractionTools: ctx.hideUserInteractionTools,
      });
      const allTools = toolRegistry.allTools();
      const missingTools = toolRegistry.missingToolNames(allowedNames);

      // Categorize by each tool's own static category metadata
      const categories: Record<string, typeof agentTools> = {};

      for (const t of agentTools) {
        const cat = (t.constructor as { category?: string }).category || 'Other';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(t);
      }

      const lines: string[] = [
        '# Available tools',
        '',
        `You have access to ${agentTools.length} tools (from ${allTools.length} total).`,
        '',
      ];

      if (ctx.hideUserInteractionTools) {
        lines.push('User-interaction tools are hidden for this turn because the current mode is hands-off.');
        lines.push('');
      }

      if (missingTools.length > 0) {
        lines.push(`Configured but unavailable tools: ${missingTools.join(', ')}.`);
        lines.push('Do not call unavailable tools; choose one from the available list instead.');
        lines.push('');
      }

      for (const [cat, tools] of Object.entries(categories)) {
        if (tools.length === 0) continue;
        lines.push(`## ${cat}`);
        lines.push('');
        for (const t of tools) {
          const desc = t.description();
          const params = t.parametersSchema();
          const props = params?.properties as Record<string, Record<string, unknown>> | undefined;
          const required = (params?.required as string[]) || [];
          if (props) {
            const paramParts: string[] = [];
            for (const [key, schema] of Object.entries(props)) {
              const req = required.includes(key) ? '*' : '';
              const type = (schema.type as string) || 'string';
              const desc2 = (schema.description as string) || '';
              paramParts.push(`${key}${req} (${type})` + (desc2 ? `: ${desc2.slice(0, 60)}` : ''));
            }
            lines.push(`- **${t.name()}**: ${desc}`);
            lines.push(`  Params: ${paramParts.join(', ')}`);
          } else {
            lines.push(`- **${t.name()}**: ${desc}`);
          }
        }
        lines.push('');
      }

      lines.push('* = required parameter');

      return lines.join('\n');
    },
  };
}

function mergeAllowedToolNames(base: string[], extra: string[] | undefined): string[] {
  return Array.from(new Set([
    ...(base || []),
    ...(extra || []),
  ].filter(Boolean)));
}
