import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import { SSEEventType } from '../../../../shared/types/events.js';
import { MessageRole, type Message } from '../../../../shared/types/session.js';
import { Agent } from '../Agent.js';
import { AgentLoop } from '../AgentLoop.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { InterruptController } from '../supervision/InterruptController.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';

const llmHarness = vi.hoisted(() => ({
  calls: [] as Array<Array<{ role: string; content?: string }>>,
  duringFirstCall: undefined as (() => void) | undefined,
}));

vi.mock('../AgentLoopLLM.js', () => ({
  callLLMWithRetry: async function* (
    _config: unknown,
    messages: Array<{ role: string; content?: string }>,
  ) {
    const callIndex = llmHarness.calls.length;
    llmHarness.calls.push(messages.map((message) => ({ ...message })));
    if (callIndex === 0) {
      llmHarness.duringFirstCall?.();
      return {
        assistantMessage: {
          role: 'assistant',
          content: '',
          tool_calls: [],
        },
        hadThinkContent: true,
        fatalError: false,
      };
    }
    return {
      assistantMessage: {
        role: 'assistant',
        content: 'Handled the live steer.',
        tool_calls: [],
      },
      hadThinkContent: false,
      fatalError: false,
    };
  },
}));

beforeEach(() => {
  AgentRegistry.resetInstance();
  ToolRegistry.resetInstance();
  (InterruptController as unknown as { _instance: unknown })._instance = null;
  llmHarness.calls.length = 0;
  llmHarness.duringFirstCall = undefined;
});

describe('AgentLoop safe-turn-boundary messages', () => {
  it('injects a message queued during an active LLM turn at the next boundary', async () => {
    AgentRegistry.getInstance().registerAgent(runtimeAgent());
    const queued: Array<{ id: string; content: string }> = [];
    const providerContexts: Array<{
      agentId: string;
      sessionId: string;
      turn: number;
    }> = [];
    const interrupts = InterruptController.getInstance();
    const signal = interrupts.createController('session-1').signal;
    llmHarness.duringFirstCall = () => {
      queued.push({
        id: 'live-steer-1',
        content: '<coordination-event>live steer</coordination-event>',
      });
      interrupts.wakeOnly('session-1');
    };
    const loop = new AgentLoop({
      agentId: 'agent-1',
      sessionId: 'session-1',
      maxTurns: 3,
      temperature: 0,
      contextWindow: 64_000,
      systemPromptOverride: 'Test system prompt.',
      safeTurnBoundaryMessageProvider: async (context) => {
        providerContexts.push(context);
        return queued.splice(0);
      },
    });
    const events = [];

    for await (const event of loop.run(userMessage(), [], signal)) {
      events.push(event);
    }

    expect(providerContexts.map((context) => context.turn)).toEqual([1, 2]);
    expect(llmHarness.calls).toHaveLength(2);
    expect(llmHarness.calls[0]!.some((message) => (
      message.content?.includes('live steer')
    ))).toBe(false);
    const injected = llmHarness.calls[1]!.filter((message) => (
      message.content?.includes('live steer')
    ));
    expect(injected).toEqual([{
      role: 'user',
      content: '<coordination-event>live steer</coordination-event>',
      __msgId: 'live-steer-1',
    }]);
    expect(events.some((event) => event.type === SSEEventType.Done)).toBe(true);
  });
});

function runtimeAgent(): Agent {
  return new Agent({
    id: 'agent-1',
    name: 'Worker',
    role: AgentRole.Member,
    parentAgentId: null,
    level: 2,
    teamName: 'Team',
    provider: 'test',
    apiUrl: '',
    apiKey: '',
    model: 'test-model',
    contextWindow: 64_000,
    maxTurns: 3,
    temperature: 0,
    allowedTools: [],
    enabledSkills: [],
    mcpServers: [],
    agentPrompt: '',
    preferredLanguage: 'en',
    conversationLanguage: 'en',
    state: AgentState.Active,
    createdAt: '2026-07-25T00:00:00.000Z',
  });
}

function userMessage(): Message {
  return {
    id: 'user-1',
    sessionId: 'session-1',
    role: MessageRole.User,
    content: 'Start the task.',
    tokenCount: 0,
    compressed: false,
    timestamp: '2026-07-25T00:00:00.000Z',
  };
}
