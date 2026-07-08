// SkillTool - invoke a named skill
// Loads skill prompt from SkillManager and returns it for injection.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SkillManager } from '../../skills/SkillManager.js';

export class SkillTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Loads a named skill into the current reasoning context.';
  name(): string { return 'Skill'; }

  description(): string {
    return 'Invoke a named skill after confirming it matches the task. The skill body is returned for use as specialized instructions.';
  }

  prompt(): string {
    return [
      '## Skill Usage',
      'Use skills for specialized workflows, not as decoration.',
      'Preferred flow: skill_matching for discovery, SkillInspect for full instructions, then Skill to activate the chosen skill.',
      'Avoid loading unrelated skills because they consume context and may conflict with the current task.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        skill: { type: 'string', minLength: 1, pattern: '\\S', description: 'Name of the skill to invoke (e.g., "code-review", "test-driven-development").' },
        args: { type: 'string', maxLength: 2000, description: 'Optional arguments to pass to the skill invocation.' },
      },
      required: ['skill'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  shouldDefer(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const skillName = params.skill as string;
    const args = (params.args as string) || '';

    try {
      const sm = SkillManager.getInstance();
      const skill = sm.getSkill(skillName);
      if (!skill) {
        const available = sm.skillsForAgent(ctx.agentId).map(s => s.name()).join(', ');
        return this.makeError(`Skill "${skillName}" not found. Available skills: ${available || '(none)'}`);
      }

      // Track usage
      sm.recordUsage(skillName);

      const promptLines: string[] = [
        `[Skill activated: ${skill.name()}]`,
        '',
        skill.body(),
      ];
      if (args) {
        promptLines.push('', `Skill arguments: ${args}`);
      }

      return this.makeResult(promptLines.join('\n'), {
        structured: { skill: skillName, agentId: ctx.agentId, status: 'loaded' },
      });
    } catch (err) {
      return this.makeError(`Failed to load skill: ${(err as Error).message}`);
    }
  }
}
