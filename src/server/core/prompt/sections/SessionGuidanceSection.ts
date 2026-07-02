// SessionGuidanceSection — session type + level guidance from SessionManager
import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { SessionManager } from '../../session/index.js';


export const sectionMeta = {
  name: 'sessionguidance',
  type: 'dynamic' as const,
  priority: 90,
};
export function createSessionGuidanceSection(): SystemPromptSection {
  return {
    name: 'SessionGuidance',
    cacheBreak: false, // Session type/level doesn't change mid-session
    compute: (ctx: PromptContext) => {
      const session = SessionManager.getInstance().session(ctx.sessionId);
      const isMain = !session || session.type === 'Main';
      const level = session?.level ?? 0;
      const sessionType = session?.type || 'Main';
      const parentId = session?.parentSessionId || 'none';

      return [
        '# Session guidance',
        '',
        `You are currently in session "${ctx.sessionId}", which is a ${sessionType.toLowerCase()} session at level ${level}.`,
        `Parent session: ${parentId}`,
        '',
        isMain
          ? [
              '- This is a main session (level 0): You are speaking directly with the user.',
              '  Understand their intent and decide how best to deliver the outcome. You can',
              '  handle tasks directly, or decompose and delegate to your team via TaskAssign',
              '  or SubAgentSpawn when that produces a better result. Choose the approach that',
              '  fits the task — not every request needs delegation.',
            ].join('\n')
          : [
              '- This is a sub-session: You are communicating with another agent. Execute',
              '  the assigned task efficiently. Report results back through the session chain.',
            ].join('\n'),
        '',
        'You have access to HireEmployee/ListEmployees/UpdateOrg for managing your organizational',
        'chart, TaskAssign for assigning work to permanent team members, SubAgentSpawn for',
        'one-off helpers, AgentMessage (downward only) for real-time coordination with subordinates,',
        'TaskList/TaskOutput for tracking delegated work status, and TaskStop to cancel running tasks.',
      ].join('\n');
    },
  };
}
