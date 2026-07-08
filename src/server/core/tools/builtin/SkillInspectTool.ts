// SkillInspectTool - inspect a named skill's full documentation
// Returns metadata + body for a specific skill. Complements SkillList (summary)
// and Skill (invocation) as the third tool in the skill discovery pipeline.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SkillManager } from '../../skills/SkillManager.js';

export class SkillInspectTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Returns full documentation for a named skill including instructions, triggers, and tools.';
  name(): string { return 'SkillInspect'; }

  description(): string {
    return 'Get complete details of a skill including its full instructions (body), triggers, required tools, model preference, priority, and source. Use this when you need to understand what a skill does before deciding to invoke it, or when you need to see its full documentation.';
  }

  prompt(): string {
    return '## SkillInspect Usage\n' +
      'Use SkillInspect to read a skill\'s full documentation BEFORE invoking it. Skills can be large - inspecting first lets you decide if the skill is right for your task without loading its entire body into context.\n\n' +
      '**When to SkillInspect:**\n' +
      '- You\'re curious about a skill listed by SkillList.\n' +
      '- The user\'s request matches a skill\'s trigger keywords.\n' +
      '- Before invoking a skill with Skill - always inspect first.\n\n' +
      'SkillInspect returns: the skill\'s full body, required tools, model preference, triggers, and its file path on disk.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Name of the skill to inspect (e.g., "code-review", "test-driven-development").',
        },
      },
      required: ['skill'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const skillName = (params.skill as string || '').trim();
    if (!skillName) {
      return this.makeError('Skill name is required. Use SkillList to see available skills.');
    }

    try {
      const sm = SkillManager.getInstance();
      const skill = sm.getSkill(skillName);
      if (!skill) {
        const available = sm.skillsForAgent(ctx.agentId).map(s => s.name()).join(', ');
        return this.makeError(`Skill "${skillName}" not found. Available skills: ${available || '(none)'}`);
      }

      const lines: string[] = [
        `## Skill: ${skill.name()}`,
        '',
        skill.description(),
        '',
        '---',
        '',
        `**Model**: ${skill.model() || '(none)'}`,
        `**Priority**: ${skill.priority()}`,
        `**Source**: ${skill.source()}`,
        `**File**: ${skill.filePath()}`,
      ];

      const triggers = skill.triggers();
      if (triggers.length > 0) {
        lines.push(`**Triggers** (${triggers.length}): ${triggers.map(t => `"${t}"`).join(', ')}`);
      } else {
        lines.push('**Triggers**: (none)');
      }

      const tools = skill.requiredTools();
      if (tools.length > 0) {
        lines.push(`**Required Tools** (${tools.length}): ${tools.join(', ')}`);
      } else {
        lines.push('**Required Tools**: (none)');
      }

      lines.push('', '### Body', '', skill.body(), '');

      lines.push('---', '', `Use the Skill tool with argument \`skill: "${skill.name()}"\` to invoke this skill.`);

      return this.makeResult(lines.join('\n'), {
        structured: {
          skill: skillName,
          agentId: ctx.agentId,
          metadata: {
            name: skill.name(),
            description: skill.description(),
            model: skill.model(),
            priority: skill.priority(),
            source: skill.source(),
            filePath: skill.filePath(),
            triggers: triggers,
            requiredTools: tools,
          },
          bodyLineCount: skill.body().split('\n').length,
        },
      });
    } catch (err) {
      return this.makeError(`Failed to inspect skill: ${(err as Error).message}`);
    }
  }
}
