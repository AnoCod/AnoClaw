// TokenBudgetSection — current token budget information from TokenCounter
// cacheBreak: true — token count changes every turn
import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { TokenCounter } from '../../context/TokenCounter.js';
import { SessionManager } from '../../session/index.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  COMPRESSION_TRIGGER_RATIO,
} from '../../../../shared/constants.js';


export const sectionMeta = {
  name: 'tokenbudget',
  type: 'dynamic' as const,
  priority: 150,
};
export function createTokenBudgetSection(): SystemPromptSection {
  return {
    name: 'TokenBudget',
    cacheBreak: true,
    compute: (ctx: PromptContext) => {
      const session = SessionManager.getInstance().session(ctx.sessionId);
      const agent = AgentRegistry.getInstance().agent(ctx.agentId);
      const contextWindow = agent?.contextWindow || DEFAULT_CONTEXT_WINDOW;
      const currentTokens = session?.metadata?.tokenCount
        ? (session.metadata.tokenCount as number)
        : 0;
      const percent = currentTokens > 0
        ? ((currentTokens / contextWindow) * 100).toFixed(1)
        : '0.0';

      return [
        '# Token budget',
        '',
        `Your context window is ${contextWindow.toLocaleString()} tokens.`,
        `Currently using approximately ${currentTokens.toLocaleString()} tokens (${percent}%).`,
        `Compression threshold: ${COMPRESSION_TRIGGER_RATIO * 100}%. Token counting uses real BPE encoding (gpt-tokenizer) for accuracy.`,
        '',
        'Compression rechecks every 8 turns and triggers when token usage exceeds 70% of the',
        'context window AND has grown more than 50% since the last compaction. The system',
        'handles this automatically — you do not need to manually compact or truncate.',
        '',
        'When the user specifies a token target, your output token count will be shown',
        'each turn. Keep working until you approach the target.',
      ].join('\n');
    },
  };
}
