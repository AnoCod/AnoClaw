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
    cacheBreak: false,
    compute: (ctx: PromptContext) => {
      const session = SessionManager.getInstance().session(ctx.sessionId);
      const isMain = !session || session.type === 'Main';
      const level = session?.level ?? 0;
      const sessionType = session?.type || 'Main';
      const parentId = session?.parentSessionId || 'none';

      const lines = [
        '# Session Guidance',
        '',
        `Session: ${ctx.sessionId}`,
        `Type: ${sessionType}`,
        `Level: ${level}`,
        `Parent session: ${parentId}`,
        '',
      ];

      if (isMain) {
        lines.push(
          'You are speaking directly with the human user.',
          'Own intent clarification, final answer quality, and integration of delegated work.',
          'Delegate only when it improves quality, parallelism, specialist depth, or context separation.',
        );
      } else {
        lines.push(
          'You are in an agent-to-agent sub-session.',
          'The immediate user message is your assignment from your parent agent.',
          'Execute efficiently, verify, and report results back through this session.',
        );
      }

      lines.push(
        '',
        'Organization actions list, hire, and reassign manage the durable roster. Team actions create, update, status, and delete manage only current-root-session collaboration. AgentMessage handles hierarchy, Team, and MainAgent organization-wide communication.',
        'Task actions create, assign, claim, update, list, output, stop, and spawn cover durable work and temporary helpers.',
      );

      return lines.join('\n');
    },
  };
}
