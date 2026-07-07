import type { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { AgentRole } from '../../../../shared/types/agent.js';

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

      const lines: string[] = ['# Organization Context', ''];

      if (agent.role === AgentRole.MainAgent) {
        lines.push('Role: MainAgent / CEO.');
        lines.push('Superior: the human user.');
        lines.push('Responsibility: own the final user outcome and coordinate the organization when useful.');

        const directReports = registry.agentsByParent(agent.id);
        lines.push('');
        lines.push(`Direct reports: ${directReports.length}`);
        for (const report of directReports) {
          const members = registry.agentsByParent(report.id);
          const memberNames = members.map(m => m.name).join(', ') || 'no members';
          lines.push(`- ${report.name} (${report.teamName || 'No team'} Manager): ${memberNames}`);
        }
        if (directReports.length === 0) {
          lines.push('- None. Hire Managers only when a durable domain owner would improve future work.');
        }
      } else if (agent.role === AgentRole.Manager) {
        const parent = agent.parentAgentId ? registry.agent(agent.parentAgentId) : null;
        const members = registry.agentsByParent(agent.id);
        lines.push(`Role: Manager for ${agent.teamName || 'an unnamed'} department.`);
        lines.push(`Superior: ${parent?.name || 'MainAgent'}.`);
        lines.push('Responsibility: own domain quality, delegate to Members when useful, and review their work before reporting upward.');
        lines.push('');
        lines.push(`Team members: ${members.length}`);
        for (const member of members) {
          lines.push(`- ${member.name}: ${member.teamName || 'specialist'}`);
        }
        if (members.length === 0) {
          lines.push('- None. Hire Members only for durable specialist capacity.');
        }
      } else {
        const parent = agent.parentAgentId ? registry.agent(agent.parentAgentId) : null;
        lines.push(`Role: Member specialist in ${agent.teamName || 'an unnamed'} department.`);
        lines.push(`Superior: ${parent?.name || 'your Manager'}.`);
        lines.push('Responsibility: execute assigned work, verify it, and report concise results through the session chain.');
        lines.push('Authority: use standard tools and temporary SubAgents; do not manage permanent org structure.');
      }

      lines.push('');
      lines.push('Respect the reporting chain. Escalate only when blocked, when scope changes, or when quality/risk requires a higher-level decision.');
      return lines.join('\n');
    },
  };
}
