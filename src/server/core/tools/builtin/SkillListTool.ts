// SkillListTool - list all available skills for the current agent
// Queries SkillManager for skills available to the agent.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SkillManager } from '../../skills/SkillManager.js';

export class SkillListTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Lists all available skills with their descriptions.';
  name(): string { return 'SkillList'; }

  description(): string {
    return 'List all skills available to the current agent. Shows skill names and descriptions. Skills provide specialized capabilities that can be invoked with the Skill tool.';
  }

  prompt(): string {
    return '## Skill Discovery Pipeline\n' +
      'Skills extend your capabilities with specialized workflows and domain knowledge. The discovery pipeline is:\n\n' +
      '1. **SkillList** (this tool) - See what skills are available with their descriptions and triggers.\n' +
      '2. **SkillInspect** - Read a skill\'s full body and metadata before deciding to invoke it.\n' +
      '3. **Skill** - Invoke the skill to load its instructions into your context.\n\n' +
      'Always SkillList first. Never invoke a skill blindly - SkillInspect it first to understand what it does and whether it fits your task.\n\n' +
      'Skills can also auto-trigger based on keywords in user messages. When a skill triggers, you\'ll see `<command-name>` in the conversation.';
  }

  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, required: [], additionalProperties: false };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(_params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    try {
      const sm = SkillManager.getInstance();
      const skills = sm.skillsForAgent(ctx.agentId);

      if (skills.length === 0) {
        return this.makeResult(
          'No skills are currently available. Skills can be loaded from the `skills/` directory ' +
          'or enabled via agent configuration (enabledSkills field).'
        );
      }

      const lines: string[] = [`Available skills (${skills.length}):`, ''];
      for (const s of skills) {
        const triggers = s.triggers().length > 0 ? ` [triggers: ${s.triggers().join(', ')}]` : '';
        lines.push(`- **${s.name()}**: ${s.description()}${triggers}`);
      }
      lines.push('', 'Use the Skill tool with a skill name to invoke it.');

      return this.makeResult(lines.join('\n'));
    } catch (err) {
      return this.makeError(`Failed to list skills: ${(err as Error).message}`);
    }
  }
}
