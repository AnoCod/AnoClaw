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

      try {
        TypedEventBus.emit('skill:loaded', {
          agentId: ctx.agentId,
          skillNames: skills.map(s => s.name()),
        });
      } catch {
        // Skill telemetry is non-critical.
      }

      const lines: string[] = ['# Available Skills', ''];

      if (skills.length === 0) {
        lines.push(
          'No skills are currently loaded for this agent.',
          'Use skills when a task matches a specialized workflow; do not invent skill behavior that is not loaded.',
        );
        return lines.join('\n');
      }

      lines.push(`Loaded skills: ${skills.length}. Invoke a skill when its when_to_use guidance matches the current task.`);
      lines.push('');

      for (const skill of skills) {
        const staleness = sm.isStale(skill.name()) ? ' [STALE]' : '';
        const triggers = skill.triggers().length > 0 ? ` triggers: ${skill.triggers().join(', ')}` : '';
        const when = skill.whenToUse() ? ` when: ${skill.whenToUse().slice(0, 100)}` : '';
        lines.push(`- ${skill.name()}${staleness}: ${skill.description().slice(0, 140)}${triggers ? ` (${triggers})` : ''}${when ? ` (${when})` : ''}`);

        const paths = skill.paths();
        if (paths.length > 0) lines.push(`  Auto-activates for paths: ${paths.join(', ')}`);
        if (skill.hasEmbeddedShell()) lines.push('  Contains embedded shell commands; inspect or invoke deliberately before relying on runtime context.');
      }

      lines.push(
        '',
        'For complex or unfamiliar tasks, use skill_matching with a short task description before starting.',
      );

      return lines.join('\n');
    },
  };
}
