// SkillTool — invoke a named skill
// Loads skill prompt from SkillManager and returns it for injection.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SkillManager } from '../../skills/SkillManager.js';

export class SkillTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Invokes a named skill to load specialized instructions.';
  name(): string { return 'Skill'; }

  description(): string {
    return 'Invoke a named skill. Skills provide specialized instructions and domain knowledge for specific tasks.';
  }

  prompt(): string {
    return '## Skill Usage\n' +
      'Invoke a skill after you\'ve inspected it and confirmed it fits your task.\n\n' +
      '**Pipeline: SkillList → SkillInspect → Skill**\n' +
      '- SkillList first to see what\'s available.\n' +
      '- SkillInspect the relevant one to read its full body.\n' +
      '- Skill to invoke it and load its instructions into your context.\n\n' +
      'Do NOT skip SkillInspect. Skills can be large, and loading the wrong one wastes context.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Name of the skill to invoke (e.g., "code-review", "test-driven-development").' },
        args: { type: 'string', description: 'Optional arguments to pass to the skill invocation.' },
      },
      required: ['skill'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

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
