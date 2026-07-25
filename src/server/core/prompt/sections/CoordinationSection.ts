import type { PromptContext, SystemPromptSection } from '../PromptSection.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { SessionManager } from '../../session/SessionManager.js';
import { SettingsManager } from '../../../infra/storage/SettingsManager.js';

export const sectionMeta = {
  name: 'coordination',
  type: 'dynamic' as const,
  priority: 82,
};

export function createCoordinationSection(): SystemPromptSection {
  return {
    name: 'Coordination',
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const service = CoordinationService.getInstance();
      if (!service.isInitialized()) return '';
      const sessionManager = SessionManager.getInstance();
      const rootSessionId = safeRootSessionId(sessionManager, ctx.sessionId);
      const team = service.getActiveTeam(rootSessionId);
      const currentTask = service.findTaskBySession(ctx.sessionId);
      if (!team && !currentTask) {
        return autoSwarmGuidance(ctx.agentId);
      }

      const registry = AgentRegistry.getInstance();
      const lines = [
        '# Coordination Protocol',
        '',
        `Root session: ${rootSessionId}`,
      ];

      if (team) {
        lines.push(
          `Active team: ${team.name} (${team.id})`,
          `Purpose: ${team.purpose}`,
          `Leader: ${formatAgent(team.leaderAgentId)}`,
          'Roster:',
          ...team.memberAgentIds.map((id) => `- ${formatAgent(id)}`),
          '',
        );
      }

      if (team?.leaderAgentId === ctx.agentId) {
        lines.push(
          'You are the Team Coordinator for this root session.',
          '- Create durable tasks before work starts. Give each task explicit acceptance criteria, dependencies, readOnly mode, and the narrowest practical writeScope.',
          '- Call TaskCreate, then TaskAssign when choosing a member. Do not treat assignment as completion.',
          '- Prefer independent parallel tasks; keep yourself available for coordination unless no eligible member can execute.',
          '- Watch coordination events for completion, failure, blockage, workspace conflicts, shutdown, and member availability.',
          '- Use AgentMessage for notes, live steering, or team broadcast. Do not use it as a substitute for a durable task.',
          '- When all work is terminal, review evidence and report the integrated result.',
          '',
        );
      } else if (team?.memberAgentIds.includes(ctx.agentId)) {
        lines.push(
          'You are a Team Member for this root session.',
          '- Work only on your current durable task and its acceptance criteria.',
          '- Respect dependencies, allowed tools, readOnly mode, and writeScope. Never bypass workspace leases.',
          '- Send a task update when blocked. Use AgentMessage for concise peer coordination.',
          '- Complete a task only after verifying its acceptance criteria and attaching evidence.',
          '',
        );
      }

      if (currentTask) {
        lines.push(
          `Current task: ${currentTask.subject} (${currentTask.id})`,
          `Mode/status: ${currentTask.mode} / ${currentTask.status}`,
          `Description: ${currentTask.description}`,
          `Acceptance criteria: ${currentTask.acceptanceCriteria.join(' | ')}`,
          `Dependencies: ${currentTask.dependsOn.join(', ') || 'none'}`,
          `Workspace policy: ${currentTask.readOnly ? 'read-only' : `write ${currentTask.writeScope.join(', ')}`}`,
          `Attempt: ${currentTask.attempt}/${currentTask.maxAttempts}`,
        );
      }

      return lines.join('\n');

      function formatAgent(agentId: string): string {
        const agent = registry.findAgent(agentId);
        return agent ? `${agent.name} (${agent.id}, ${agent.role})` : agentId;
      }
    },
  };
}

function safeRootSessionId(sessionManager: SessionManager, sessionId: string): string {
  try {
    return sessionManager.getRootSession(sessionId).id;
  } catch {
    return sessionId;
  }
}

function autoSwarmGuidance(agentId: string): string {
  if (!SettingsManager.getInstance().get<boolean>('coordination.autoSwarm.enabled', true)) return '';
  const agent = AgentRegistry.getInstance().findAgent(agentId);
  if (!agent?.isManagerRole()) return '';
  const minTasks = SettingsManager.getInstance().get<number>(
    'coordination.autoSwarm.minParallelTasks',
    2,
  );
  return [
    '# Automatic Team Coordination',
    '',
    `When the request contains at least ${minTasks} genuinely independent tasks, create or reuse a temporary Team and represent the work on the durable task board.`,
    'Call ListEmployees to inspect the durable roster. Use existing active employees; HireEmployee is only for missing long-term capacity.',
    'Team membership never changes the persistent organization tree.',
    'If work is sequential, tiny, or must modify one shared area, continue normally without creating a Team.',
  ].join('\n');
}
