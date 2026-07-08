// SkillMatchingTool.ts - find skills matching a task description using semantic similarity
// Calls SkillManager.matchingSkills() which uses hybrid embedding+keyword scoring.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SkillManager } from '../../skills/SkillManager.js';

export class SkillMatchingTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Finds loaded skills relevant to the current task.';

  name(): string { return 'skill_matching'; }

  description(): string {
    return 'Find skills matching a short task description. Use before complex or unfamiliar work to discover specialized workflows.';
  }

  prompt(): string {
    return [
      '## skill_matching Usage',
      'Call with a short description of the task you are about to perform.',
      'Use the ranked results to decide whether to inspect and invoke a skill.',
      'Do not invoke low-relevance skills just because they exist.',
    ].join('\n');
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S', description: 'Short description of your current task - what you need to do.' },
      },
      required: ['task'],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  isReadOnly(): boolean { return true; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const task = String(params.task || '').trim();
    if (!task) return this.makeError('Missing "task" parameter. Describe what you need to do.');

    try {
      const sm = SkillManager.getInstance();
      const skills = await sm.matchAndTrack(task);

      if (skills.length === 0) {
        return this.makeResult(`No matching skills found for: "${task}"`);
      }

      const lines = [`Skills matching "${task}" (best first):`, ''];
      for (const s of skills) {
        lines.push(`- **${s.name()}**: ${s.description().slice(0, 120)}`);
      }
      return this.makeResult(lines.join('\n'), {
        structured: { task, count: skills.length, skills: skills.map(s => s.name()) },
      });
    } catch (err) {
      return this.makeError(`Skill matching failed: ${(err as Error).message}`);
    }
  }
}
