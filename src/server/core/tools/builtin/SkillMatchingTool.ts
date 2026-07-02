// SkillMatchingTool.ts — find skills matching a task description using semantic similarity
// Calls SkillManager.matchingSkills() which uses hybrid embedding+keyword scoring.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { SkillManager } from '../../skills/SkillManager.js';

export class SkillMatchingTool extends Tool {

  static category = 'Memory & Skills';
  static toolDescription = 'Find skills relevant to a task using semantic matching.';

  name(): string { return 'skill_matching'; }

  description(): string {
    return 'Find skills that match a description of your current task. Uses semantic similarity (embedding) when available, falling back to keyword matching. Returns ranked results with scores.';
  }

  prompt(): string {
    return '## Skill Matching\n'
      + 'Call this with a **short description of your current task** to find relevant skills. '
      + 'Describe what you are about to do — e.g. "debug a WebSocket connection issue" or "add a new REST API endpoint". '
      + 'The system returns ranked skill names with match scores. High scores (>0.5) indicate strong relevance.\n\n'
      + '**Tool name:** skill_matching\n';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Short description of your current task — what you need to do.' },
      },
      required: ['task'],
    };
  }

  riskLevel(): RiskLevel { return RiskLevel.Safe; }

  async execute(params: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const task = String(params.task || '').trim();
    if (!task) return this.makeError('Missing "task" parameter. Describe what you need to do.');

    try {
      const sm = SkillManager.getInstance();
      const skills = await sm.matchingSkills(task);

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
