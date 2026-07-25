import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';

export const sectionMeta = {
  name: 'orgcontext',
  type: 'dynamic' as const,
  priority: 80,
};

export function createOrgContextSection(): SystemPromptSection {
  return {
    name: 'OrgContext',
    cacheBreak: false,
    compute: (ctx: PromptContext) => {
      const registry = AgentRegistry.getInstance();
      const agent = registry.agent(ctx.agentId);
      if (!agent) return '';

      const lines: string[] = [
        '# Persistent Agent Context',
        '',
        `Agent: ${agent.name} (${agent.id}).`,
        `Configured Team label: ${agent.teamName || 'none'}.`,
        'Responsibility: own assigned outcomes, collaborate through persistent Teams, verify work, and report concise results.',
        '',
        'Company organization is Team-only. Legacy runtime role, level, and parent metadata do not create organization authority.',
        'Use AgentList and TeamStatus for persistent v3 organization state. Use TeamMemberAdd, TeamMemberUpdate, and TeamMemberRemove for membership changes.',
      ];
      return lines.join('\n');
    },
  };
}
