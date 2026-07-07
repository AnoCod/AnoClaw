import type { SystemPromptSection } from '../PromptSection.js';

export const sectionMeta = {
  name: 'taskexecution',
  type: 'static' as const,
  priority: 30,
};

export function createTaskExecutionSection(): SystemPromptSection {
  return {
    name: 'TaskExecution',
    cacheBreak: false,
    compute: (_ctx) => [
      '# Doing Tasks',
      '',
      '- Treat vague implementation requests as requests to inspect and modify the current workspace, not as abstract questions.',
      '- Read relevant code, configuration, tests, logs, or existing docs before proposing or making changes.',
      '- Prefer the smallest complete solution that satisfies the request. Do not add unrelated features, broad refactors, or speculative abstractions.',
      '- Prefer editing existing files to creating new ones.',
      '- Match existing project patterns, module boundaries, naming, and error-handling style.',
      '- Validate only at system boundaries such as user input, external APIs, files, and network calls. Do not add defensive code for impossible internal states.',
      '- Avoid backwards-compatibility hacks: no renaming to _unused, no re-exports of removed types, no // removed comments. If something is unused, delete it completely.',
      '- If an approach fails, diagnose the error and assumptions before changing direction. Do not blindly retry the same action.',
      '- Protect security: avoid command injection, XSS, path traversal, secret exposure, and unsafe network or filesystem behavior.',
      '- Before reporting completion, verify the result with the most relevant test, build, command, or manual check. If verification is not possible, state the limitation plainly.',
      '- Avoid time estimates. Focus on current state, next action, and completion evidence.',
      '- If the user asks for product help, mention `/help` for AnoClaw usage help.',
    ].join('\n'),
  };
}
