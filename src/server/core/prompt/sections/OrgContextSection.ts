// OrgContextSection — dynamically injects organizational hierarchy context
// Based on the agent's role, level, and team relationships in AgentRegistry.
// CEO knows user is their only boss. Managers know CEO is their boss + their team.
// Members know their Manager is their boss.
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
    cacheBreak: false, // org structure changes rarely; bust via register/unregister events
    compute: (ctx: PromptContext) => {
      const registry = AgentRegistry.getInstance();
      const agent = registry.agent(ctx.agentId);
      if (!agent) return '';

      const lines: string[] = [];
      lines.push('# Your Position in the Organization');
      lines.push('');

      // ── CEO (Level 0) ──
      if (agent.role === AgentRole.MainAgent) {
        lines.push('You are the **CEO** and top-level orchestrator of this organization.');
        lines.push('');
        lines.push('**Your superior**: The user (human). You report directly to them and only them.');
        lines.push('**Your authority**: You have full authority over all agents and decisions. No other agent can override your instructions.');

        const directReports = registry.agentsByParent(agent.id);
        if (directReports.length > 0) {
          lines.push('');
          lines.push(`**Your direct reports** (${directReports.length} department directors):`);
          for (const dr of directReports) {
            const team = registry.agentsByParent(dr.id);
            const teamStr = team.length > 0
              ? ` — leads ${team.length} team member${team.length > 1 ? 's' : ''} (${team.map(t => t.name).join(', ')})`
              : ' — no team members yet';
            lines.push(`- **${dr.name}** (${dr.teamName} Department)${teamStr}`);
          }
        } else {
          lines.push('');
          lines.push('**Your direct reports**: None yet. You may hire department directors as needed.');
        }
      }

      // ── Manager (Level 1) ──
      else if (agent.role === AgentRole.Manager) {
        const parent = agent.parentAgentId ? registry.agent(agent.parentAgentId) : null;
        const parentName = parent?.name || 'the CEO';

        lines.push(`You are a **Manager** — the **${agent.name}** of the ${agent.teamName} Department.`);
        lines.push('');
        lines.push(`**Your superior**: **${parentName}**. You report to them and receive assignments from them.`);
        lines.push('**Your authority**: You manage your department team. You can hire Members (HireEmployee), assign tasks (TaskAssign), restructure your team (UpdateOrg), and review outputs.');
        lines.push('');
        lines.push('**Key responsibilities**:');
        lines.push('- Break complex tasks into subtasks your Members can execute independently');
        lines.push('- Match tasks to Member strengths — know who is good at what');
        lines.push('- Verify Member outputs before reporting upstream — you are the quality gate');
        lines.push('- Handle simple work yourself — don\'t delegate trivia');

        const directReports = registry.agentsByParent(agent.id);
        if (directReports.length > 0) {
          lines.push('');
          lines.push(`**Your team** (${directReports.length} member${directReports.length > 1 ? 's' : ''}):`);
          for (const dr of directReports) {
            lines.push(`- **${dr.name}** — ${dr.teamName} specialist`);
          }
        } else {
          lines.push('');
          lines.push('**Your team**: No members yet. Use HireEmployee to recruit specialists as needed.');
        }
      }

      // ── Member (Level 2) ──
      else {
        const parent = agent.parentAgentId ? registry.agent(agent.parentAgentId) : null;
        const parentName = parent?.name || 'your Manager';

        lines.push(`You are a **Member** — the **${agent.name}** in the ${agent.teamName} Department.`);
        lines.push('');
        lines.push(`**Your superior**: **${parentName}**. You receive assignments from them and report your results back.`);
        lines.push('**Your role**: Specialist executor. Focus on delivering high-quality work in your domain of expertise.');
        lines.push('');
        lines.push('**Key responsibilities**:');
        lines.push('- Execute assigned tasks with precision — read before you write, verify before you report');
        lines.push('- Use SubAgentSpawn for complex subtasks that need research or parallel execution');
        lines.push('- Keep TaskList status updated — your Manager tracks your progress. If stuck, flag it in the task output.');
        lines.push('- If a task is unclear, make a reasonable assumption and flag it — don\'t stay blocked silently');
        lines.push('**Your authority**: You can spawn helper SubAgents and use all standard development tools. You cannot manage other permanent agents or modify the org structure — report needs for team changes to your Manager.');
      }

      lines.push('');
      lines.push('Always keep your position and reporting chain in mind when making decisions. Escalate appropriately — do not go above your direct superior without justification.');

      return lines.join('\n');
    },
  };
}
