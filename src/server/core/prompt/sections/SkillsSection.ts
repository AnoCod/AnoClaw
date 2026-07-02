// SkillsSection — available skills list from SkillManager, with staleness indicators
import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { SkillManager } from '../../skills/SkillManager.js';
import { TypedEventBus } from '../../events/TypedEventBus.js';

export const sectionMeta = {
  name: 'skills',
  type: 'dynamic' as const,
  priority: 170,
};
export function createSkillsSection(): SystemPromptSection {
  return {
    name: 'Skills',
    cacheBreak: false,
    compute: (ctx: PromptContext) => {
      const sm = SkillManager.getInstance();
      const skills = sm.skillsForAgent(ctx.agentId);

      // Track skill loads for evolution stats
      try {
        TypedEventBus.emit('skill:loaded', {
          agentId: ctx.agentId,
          skillNames: skills.map(s => s.name()),
        });
      } catch { /* non-critical */ }

      const lines: string[] = [
        '# Available skills',
        '',
      ];

      if (skills.length === 0) {
        lines.push(
          'No skills are currently loaded for this agent.',
          'Skills can be loaded from the `skills/` directory, `~/.anoclaw/skills/`, or enabled via agent configuration.',
          'Use `memory_search` to look up the skill-creator workflow for creating new skills.',
        );
      } else {
        lines.push(
          `The following ${skills.length} skills are loaded. Invoke via the Skill tool:`,
          '',
        );
        for (const s of skills) {
          const staleness = sm.isStale(s.name()) ? ' [STALE]' : '';
          const triggers = s.triggers().length > 0 ? ` [triggers: ${s.triggers().join(', ')}]` : '';
          const when = s.whenToUse() ? ` (when: ${s.whenToUse().slice(0, 80)})` : '';
          lines.push(`- **${s.name()}**${staleness}: ${s.description().slice(0, 120)}${triggers}${when}`);
          const paths = s.paths();
          if (paths.length > 0) lines.push(`  → Auto-activates on file changes matching: ${paths.join(', ')}`);
          const hasShell = s.hasEmbeddedShell();
          if (hasShell) lines.push(`  → Contains embedded shell commands (executed on invocation)`);
        }
        lines.push(
          '',
          'Skills with `when_to_use` matching your current task context SHOULD be invoked.',
          'Skills with embedded shell (`!`cmd``) provide real-time system context — invoke before acting.',
          '[STALE] skills have not been used recently and may be less relevant.',
          '',
          '**Before starting a complex task**, use `skill_matching` with a brief task description',
          'to find the most relevant skills via semantic matching.',
        );
      }

      return lines.join('\n');
    },
  };
}
