import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { SettingsManager } from '../../../infra/storage/SettingsManager.js';
import { SessionManager } from '../../session/index.js';
import { normalizePermissionMode } from '../../agent/PermissionModePolicy.js';

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
      const session = SessionManager.getInstance().session(ctx.sessionId);
      const isSubSession = session ? !session.isMain() : false;

      let mode = isSubSession ? 'Auto' : (ctx.permissionMode || settings.get<string>('ui.permissionMode', 'Auto'));
      let effort = isSubSession ? 'HIGH' : (ctx.effort || settings.get<string>('ui.effort', 'NORMAL'));

      mode = normalizePermissionMode(mode);
      effort = normalizeEffort(effort);

      const modePrompts: Record<string, string> = {
        Ask: 'You are in ASK mode. The system will pop up confirmation dialogs for non-read-only tools. Call tools directly — no need to ask for permission in text.',
        AutoEdit: 'You are in AUTO_EDIT mode. All tools are auto-approved. Call any tool without confirmation.',
        Plan: 'You are in PLAN mode. Explore first, present an implementation plan, and do not change files.',
        Auto: 'You are in SAFE_AUTO mode. Low/Medium risk tools (Edit, Write) are auto-approved. High-risk tools (Bash) will trigger a confirmation dialog. Call tools directly.',
      };

      const effortPrompts: Record<string, string> = {
        HIGH: 'Effort level: HIGH. Be thorough, verify edge cases, and prefer correctness over speed.',
        NORMAL: 'Effort level: NORMAL. Keep work efficient and avoid over-engineering.',
      };

      return [
        '# Permission Mode',
        modePrompts[mode] || modePrompts.Auto,
        effortPrompts[effort] || effortPrompts.NORMAL,
        '',
        'Respect this mode consistently for the current session.',
      ].join('\n');
    },
  };
}

function normalizeEffort(effort: string): string {
  return effort.toUpperCase() === 'HIGH' ? 'HIGH' : 'NORMAL';
}
