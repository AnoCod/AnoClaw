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

      let mode = isSubSession ? 'AutoEdit' : (ctx.permissionMode || settings.get<string>('ui.permissionMode', 'Auto'));
      let effort = isSubSession ? 'HIGH' : (ctx.effort || settings.get<string>('ui.effort', 'NORMAL'));

      mode = normalizePermissionMode(mode);
      effort = normalizeEffort(effort);

      const modePrompts: Record<string, string> = {
        Ask: 'You are in ASK mode. Read-only tools run directly; every tool with side effects triggers a confirmation dialog. Call tools directly — do not ask for approval in text.',
        AutoEdit: 'You are in AUTO_EDIT mode. The user has pre-authorized every allowed tool, including high-risk, critical, destructive Bash, and external side effects. Call tools directly without confirmation or a text approval request.',
        Plan: 'You are in PLAN mode. Explore first, present an implementation plan, and do not change files.',
        Auto: 'You are in SAFE_AUTO mode. Safe, low, and medium risk tools are auto-approved. High-risk and critical tools trigger a confirmation dialog. Call tools directly.',
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
