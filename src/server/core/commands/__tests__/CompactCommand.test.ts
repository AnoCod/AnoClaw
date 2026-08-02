import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageRole, type ExecutionContext, type Message } from '../../../../shared/types/session.js';
import { SessionManager } from '../../session/index.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { ContextCompressor } from '../../context/index.js';
import * as summarizerModule from '../../agent/AgentLoopSummarizer.js';
import { CompactCommand } from '../builtin/CompactCommand.js';

function message(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
  };
}

describe('CompactCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the agent summarizer and rewrites history exactly once', async () => {
    const history = [
      message('user-1', MessageRole.User, 'Original task '.repeat(100)),
      message('assistant-1', MessageRole.Assistant, 'Earlier work '.repeat(100)),
    ];
    const compacted = [
      message('compact-summary-1', MessageRole.System, 'Persisted summary'),
      message('user-2', MessageRole.User, 'Latest request'),
    ];
    const rewriteHistory = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(SessionManager, 'getInstance').mockReturnValue({
      session: () => ({ agentId: 'agent-1' }),
      getHistory: vi.fn().mockResolvedValue(history),
      rewriteHistory,
    } as unknown as SessionManager);
    const agent = {
      provider: 'openai-compatible',
      modelName: 'model-1',
      contextWindow: 100,
      apiUrl: 'https://example.test',
      apiKey: 'secret',
    };
    vi.spyOn(AgentRegistry, 'getInstance').mockReturnValue({
      agent: () => agent,
    } as unknown as AgentRegistry);
    const summarizer = vi.fn().mockResolvedValue('summary');
    vi.spyOn(summarizerModule, 'createAgentLoopSummarizer').mockReturnValue(summarizer);
    const compact = vi.fn().mockResolvedValue({
      messages: compacted,
      summary: 'summary',
      wasCompacted: true,
      prunedCount: 1,
    });
    vi.spyOn(ContextCompressor, 'getInstance').mockReturnValue({
      compact,
    } as unknown as ContextCompressor);

    const ctx: ExecutionContext = {
      sessionId: 'session-1',
      agentId: 'agent-1',
      workspace: 'F:\\QoderSoft\\AnoClaw',
      userConfirmed: true,
    };
    const result = await new CompactCommand().execute({}, ctx);

    expect(summarizerModule.createAgentLoopSummarizer).toHaveBeenCalledWith({
      provider: agent.provider,
      modelName: agent.modelName,
      contextWindow: agent.contextWindow,
      apiUrl: agent.apiUrl,
      apiKey: agent.apiKey,
    });
    expect(compact).toHaveBeenCalledWith(history, 100, undefined, summarizer);
    expect(rewriteHistory).toHaveBeenCalledTimes(1);
    expect(rewriteHistory).toHaveBeenCalledWith('session-1', compacted);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Older detailed turns were replaced');
  });
});
