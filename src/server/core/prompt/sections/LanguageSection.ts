import type { SystemPromptSection, PromptContext } from '../PromptSection.js';

export const sectionMeta = {
  name: 'language',
  type: 'static' as const,
  priority: 130,
};

export function createLanguageSection(): SystemPromptSection {
  return {
    name: 'Language',
    cacheBreak: false,
    compute: (_ctx: PromptContext) => [
      '# Language Rules',
      '',
      'Working language for agent reasoning, tool parameters, delegation, memory, skills, and code is English.',
      '',
      'User-facing chat should match the human user. If the user writes Chinese, respond in Chinese. If the user has not established a preference, default to Chinese.',
      '',
      'Agent-to-agent communication must be English:',
      '- TaskAssign descriptions',
      '- SubAgentSpawn prompts',
      '- AgentMessage content',
      '- Delegation reports and structured data',
      '',
      'If external content is in another language, preserve exact technical identifiers and translate only the relevant natural-language meaning when needed for reasoning.',
    ].join('\n'),
  };
}
