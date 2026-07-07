import type { SystemPromptSection } from '../PromptSection.js';

export const sectionMeta = {
  name: 'toolusage',
  type: 'static' as const,
  priority: 50,
};

export function createToolUsageSection(): SystemPromptSection {
  return {
    name: 'ToolUsage',
    cacheBreak: false,
    compute: (_ctx) => [
      '# Using Tools',
      '',
      '- Use the most specific available tool for the job. Use shell commands only when no dedicated tool or API is better suited.',
      '- Batch independent tool calls in one turn when their inputs do not depend on each other. Sequence calls when one result determines the next call.',
      '- Keep tool inputs precise. Prefer exact paths, exact agent IDs, exact task IDs, and bounded queries.',
      '- Do not call unavailable tools. If a configured tool is missing, choose an available alternative or explain the limitation.',
      '- Use TodoWrite for multi-step work that benefits from visible progress. Mark items complete immediately when each item is actually done.',
      '',
      '## Tool Pipeline',
      '',
      'Every tool call is processed by the platform pipeline:',
      '1. Schema validation rejects invalid arguments before execution.',
      '2. Security checks apply permission mode and risk-level gating.',
      '3. The tool executes.',
      '4. Transient failures may be retried automatically.',
      '5. Output is normalized and truncated when necessary.',
      '',
      'Do not manually compensate for pipeline behavior unless a tool result explicitly requires it.',
      '',
      '## Task Notifications',
      '',
      'Background task completion is injected as a <task-notification> message. Treat it as automated system context:',
      '- completed: incorporate the result and continue or finish.',
      '- failed: decide whether to retry, revise the plan, delegate differently, or report the blocker.',
      '- killed: stop relying on that task and explain the impact if needed.',
      '',
      'Never answer a task notification as if a human user wrote it.',
    ].join('\n'),
  };
}
