// PermissionModeSection — current permission mode (Ask/AutoEdit/Plan/Auto)
// For sub-sessions (agent-to-agent), always forces Auto + HIGH effort.
// cacheBreak: true — recompute every turn so mode changes (Ask→Auto etc.) reflect immediately
import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { SettingsManager } from '../../../infra/storage/SettingsManager.js';
import { SessionManager } from '../../session/index.js';


export const sectionMeta = {
  name: 'permissionmode',
  type: 'dynamic' as const,
  priority: 190,
};
export function createPermissionModeSection(): SystemPromptSection {
  return {
    name: 'PermissionMode',
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const settings = SettingsManager.getInstance();

      // Sub-sessions force Auto + HIGH effort ──
      // Agent-to-agent communication must not be blocked by Ask/Plan mode.
      let mode: string;
      let effort: string;

      const sessionManager = SessionManager.getInstance();
      const session = sessionManager.session(ctx.sessionId);
      const isSubSession = session ? !session.isMain() : ctx.sessionId.includes('-');

      if (isSubSession) {
        mode = 'Auto';
        effort = 'HIGH';
      } else {
        mode = settings.get<string>('ui.permissionMode', 'Auto');
        effort = settings.get<string>('ui.effort', 'NORMAL');
      }

      const modePrompts: Record<string, string> = {
        Ask: 'You are in ASK mode. Ask the user for confirmation before making ANY edit. Do not write or modify files without explicit approval.',
        AutoEdit: 'You are in AUTO_EDIT mode. You may edit files directly without asking for confirmation. Defer to tool risk levels for other operations.',
        Plan: 'You are in PLAN mode. Before making any code changes, first explore the codebase and present a plan. Wait for the user to approve the plan before implementing.',
        Auto: 'You are in AUTO mode. Choose the best permission strategy for each task — ask for risky operations, auto-approve safe ones. Follow tool risk levels as guidance.',
      };

      const effortPrompts: Record<string, string> = {
        HIGH: 'Effort level: HIGH. Be thorough. Verify your work, test edge cases, don\'t cut corners. Prefer verified correctness over speed.',
        NORMAL: 'Effort level: NORMAL. Keep it efficient. Prefer simple solutions, don\'t over-engineer. Default to the most straightforward approach.',
      };

      return [
        '# Permission mode',
        modePrompts[mode] || modePrompts.Auto,
        effortPrompts[effort] || effortPrompts.NORMAL,
        '',
        'Your current permission mode determines how you handle file edits and',
        'tool execution. Respect it consistently throughout this session.',
      ].join('\n');
    },
  };
}
