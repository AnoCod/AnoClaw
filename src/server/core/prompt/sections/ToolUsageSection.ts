// Tool Usage Section — universal tool-usage rules that apply regardless of tool list.
// NEVER mention specific tools here. Tool-specific usage guidance comes from each
// tool's prompt() method, injected dynamically by ToolPromptSection.
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
      '# Using your tools',
      '',
      '- Do NOT use the Bash to run commands when a relevant dedicated tool is provided:',
      '  - Read files with Read, not cat/head/tail/sed',
      '  - Edit files with Edit, not sed/awk',
      '  - Create files with Write, not cat with heredoc or echo redirection',
      '  - Find files with Glob, not find/ls',
      '  - Search content with Grep, not grep/rg',
      '  - Use Bash only for system commands that genuinely need a shell',
      '',
      '- Use TodoWrite to plan and track your work. Mark tasks complete immediately when done — do not batch.',
      '',
      '- Call multiple tools in a single response when they have no dependencies on each other. This increases efficiency. When one tool\'s output feeds another, call them sequentially instead.',
      '',
      '# Tool Pipeline (automatic)',
      '',
      'Every tool call goes through 5 stages automatically:',
      '',
      '1. **Schema Validation** — Parameters checked against JSON Schema. Invalid calls rejected before execution.',
      '2. **Security Check** — Risk-level gating and read-only mode enforcement. Critical tools require user confirmation.',
      '3. **Execute** — The tool runs.',
      '4. **Auto-Retry** — Transient errors (ECONNRESET, ETIMEDOUT, 5xx, rate limits) retried up to 3x with exponential backoff. Do NOT manually retry — the pipeline handles it.',
      '5. **Output Normalization** — All output auto-truncated with "[N chars truncated]" markers. You do not need to ask for smaller output.',
      '',
      '# Task Completion Notifications',
      '',
      'When a background task completes or fails, the system injects a <task-notification> XML block as a user-role message. This is NOT the user speaking — it is automated system notification.',
      '',
      '```xml',
      '<task-notification>',
      '<task-id>bt-xxx</task-id>',
      '<status>completed|failed|killed</status>',
      '<type>subagent|bash|command</type>',
      '<summary>one-line task description</summary>',
      '<result>task output or error (truncated to 2000 chars)...</result>',
      '</task-notification>',
      '```',
      '',
      '- <status> completed? Incorporate the result into your work.',
      '- <status> failed? Decide whether to retry, report to user, or find an alternative.',
      '- Never reply to the notification as if a human wrote it.',
    ].join('\n'),
  };
}
