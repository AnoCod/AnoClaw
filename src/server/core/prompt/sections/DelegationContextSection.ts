// DelegationContextSection — injects parent conversation context into sub-session prompts
// When a sub-agent is delegated a task, it needs to understand the broader goal from the
// parent session. This section extracts a rule-based summary (no LLM call) of the parent
// conversation and injects it into the sub-agent's system prompt.

import { SystemPromptSection, PromptContext } from '../PromptSection.js';
import { SessionManager } from '../../session/index.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import type { Message } from '../../../../shared/types/session.js';

const MAX_SUMMARY_CHARS = 3200; // ~800 tokens


export const sectionMeta = {
  name: 'delegationcontext',
  type: 'dynamic' as const,
  priority: 100,
};
export function createDelegationContextSection(): SystemPromptSection {
  return {
    name: 'DelegationContext',
    cacheBreak: false, // Parent context metadata is set once at delegation, never changes
    compute: (ctx: PromptContext) => {
      const sessionManager = SessionManager.getInstance();
      const session = sessionManager.session(ctx.sessionId);

      // Only inject for Sub sessions
      if (!session || session.type !== 'Sub') return '';
      const parentId = session.parentSessionId;
      if (!parentId) return '';

      // Read parent context stored in metadata by delegateTask()
      const storedContext = session.metadata?.parentContext;
      if (typeof storedContext === 'string' && storedContext.length > 0) {
        return storedContext;
      }

      return '';
    },
  };
}

/** Build a concise summary of the parent conversation for sub-agent context injection */
export function buildContextSummary(history: Message[]): string {
  const parts: string[] = [];
  let totalChars = 0;

  parts.push('# Parent Conversation Context (reference only)');
  parts.push('');
  parts.push('> The following is background from the parent session that delegated this task to you.');
  parts.push('> Your actual task is in the user message below. Use this context to understand the broader goal.');
  parts.push('');

  // Layer 1: Last user message (most important — the actual request)
  const userMessages = history.filter(m => m.role === 'user');
  const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
  if (lastUserMsg && lastUserMsg.content) {
    const truncated = lastUserMsg.content.slice(0, 200);
    parts.push('## User\'s Request to Parent Agent');
    parts.push(truncated + (lastUserMsg.content.length > 200 ? '...' : ''));
    parts.push('');
    totalChars += truncated.length + 50;
  }

  if (totalChars >= MAX_SUMMARY_CHARS) return parts.join('\n');

  // Layer 2: Recent conversation direction (last 5 messages, role + first 100 chars)
  const recent = history.slice(-5);
  if (recent.length > 0) {
    parts.push('## Recent Conversation Direction');
    for (const msg of recent) {
      if (totalChars >= MAX_SUMMARY_CHARS) break;
      let role = 'Unknown';
      if ((msg as any).agentId) {
        const senderAgent = AgentRegistry.getInstance().agent((msg as any).agentId);
        role = senderAgent?.name || (msg as any).agentId;
      } else if (msg.role === 'user') {
        role = 'User';
      } else {
        role = 'Agent';
      }
      const brief = (msg.content || '').slice(0, 100).replace(/\n/g, ' ');
      parts.push(`- **${role}**: ${brief}${(msg.content || '').length > 100 ? '...' : ''}`);
      totalChars += brief.length + 15;
    }
    parts.push('');
  }

  if (totalChars >= MAX_SUMMARY_CHARS) return parts.join('\n');

  // Layer 3: Tools used in parent conversation (gives sub-agent context about what's been tried)
  const toolNames = new Set<string>();
  for (const msg of history) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolNames.add(tc.toolName || '');
      }
    }
  }
  if (toolNames.size > 0) {
    parts.push('## Tools Used in Parent Session');
    parts.push(Array.from(toolNames).filter(Boolean).join(', '));
    parts.push('');
  }

  return parts.join('\n');
}
