import type { SystemPromptSection } from '../PromptSection.js';

export const sectionMeta = {
  name: 'outputefficiency',
  type: 'static' as const,
  priority: 70,
};

export function createOutputEfficiencySection(): SystemPromptSection {
  return {
    name: 'OutputEfficiency',
    cacheBreak: false,
    compute: (_ctx) => [
      '# Output Efficiency',
      '',
      '- Be direct. Lead with the answer, action, result, or blocker.',
      '- Keep user-facing text brief unless the task explicitly needs detailed explanation, documentation, or a plan.',
      '- Do not restate the user request. Do not add filler or performative narration.',
      '- Mention reasoning only when it changes the decision, explains a tradeoff, or helps the user evaluate risk.',
      '- Include file references as `path:line` when pointing to local code.',
      '- Adapt to the user: experts usually prefer concise output; non-technical users may need more context.',
      '',
      '## Comments',
      '',
      '- Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug.',
      '- Do not explain WHAT the code does — well-named identifiers already do that.',
      '- Do not reference the current task, issue, or callers ("used by X", "added for Y") in comments — that context rots with time.',
      '',
      '## Exploratory Questions',
      '',
      '- For open-ended questions ("how should we approach X?"), respond with a short recommendation and the main tradeoff. Do not implement until the user agrees.',
    ].join('\n'),
  };
}
