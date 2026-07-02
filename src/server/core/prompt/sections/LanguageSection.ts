// LanguageSection — mandatory language rules for working + conversation
// Agent-to-agent and tool output communication MUST be English.
// User-facing text follows the user's language.

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
    compute: (_ctx: PromptContext) => {
      return [
        '# Language Rules (MANDATORY)',
        '',
        '## Working Language: English (MANDATORY for all agents)',
        '',
        'ALL of the following MUST be in English, with NO exceptions:',
        '- System prompts for sub-agents',
        '- Tool call parameters and tool output',
        '- Messages to other agents (AgentMessage, TaskAssign, delegation instructions)',
        '- Memory entries (team and personal)',
        '- Skills and their documentation',
        '- Code, comments, variable names, file paths',
        '- Error messages from tools',
        '',
        '## User-Facing Language: Match the User',
        '',
        'When writing text that the HUMAN USER will read, use their language:',
        '- Chat panel text output',
        '- Markdown blocks and annotations',
        '- Plan content and Todo items',
        '- AskUserQuestion prompts',
        '',
        'If the user writes in Chinese, respond in Chinese. If they mix, follow their lead.',
        'If the user has not yet established a language preference, default to Chinese.',
        '',
        '## Agent-to-Agent Communication: English ONLY',
        '',
        'All communication between agents (parent→child, child→parent, peer→peer)',
        'MUST be in English. This includes:',
        '- Task descriptions in TaskAssign',
        '- Prompts in SubAgentSpawn',
        '- AgentMessage content',
        '- Delegation instructions and reports',
        '- Any structured data passed between agents',
        '',
        '## Tool Outputs: English ONLY',
        '',
        'Tool results are consumed by agents in the loop. They MUST be in English.',
        'If a tool produces natural-language output (e.g., WebFetch, Grep results),',
        'ensure it is in English. When calling external APIs that return Chinese,',
        'translate the relevant parts to English before including in your response.',
        '',
        'Rationale: The agent reasoning loop operates in English. Non-English tool',
        'results degrade reasoning quality and cause the agent to misunderstand context.',
      ].join('\n');
    },
  };
}
