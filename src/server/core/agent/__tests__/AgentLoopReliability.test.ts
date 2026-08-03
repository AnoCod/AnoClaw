import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMOptions, LLMStreamEvent } from '../../../../shared/types/llm.js';
import type { Message } from '../../../../shared/types/session.js';
import { AgentRole, AgentState, AgentStatus } from '../../../../shared/types/agent.js';
import { SSEEventType } from '../../../../shared/types/events.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import { APIScheduler } from '../../../infra/llm/APIScheduler.js';
import { Agent } from '../Agent.js';
import type { AgentConfigWithKey } from '../AgentConfig.js';
import { AgentLoop } from '../AgentLoop.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { extensionPoints } from '../../plugin-host/ExtensionPoints.js';
import { SessionManager } from '../../session/SessionManager.js';
import { SessionStore } from '../../session/SessionStore.js';
import { RiskLevel, Tool, type ExecutionContext } from '../../tools/Tool.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';

const OWNER = 'agent-loop-reliability-test';

class ContinueTool extends Tool {
  name(): string { return 'ContinueTool'; }
  description(): string { return 'Continue to a second model turn'; }
  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, additionalProperties: false };
  }
  riskLevel(): RiskLevel { return RiskLevel.Safe; }
  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('continued');
  }
}

function makeAgentConfig(overrides: Partial<AgentConfigWithKey> = {}): AgentConfigWithKey {
  return {
    id: 'agent-1',
    name: 'Reliability Agent',
    role: AgentRole.Member,
    parentAgentId: null,
    level: 2,
    teamName: '',
    provider: 'test',
    apiUrl: '',
    apiKey: 'old-key',
    model: 'old-model',
    contextWindow: 8000,
    maxTurns: 2,
    temperature: 0,
    agentPrompt: '',
    preferredLanguage: 'en',
    conversationLanguage: 'en',
    allowedTools: [],
    enabledSkills: [],
    mcpServers: [],
    state: AgentState.Active,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeUserMessage(sessionId = 'session-1', id = 'message-1'): Message {
  return {
    id,
    sessionId,
    role: 'user',
    content: 'Continue the task',
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
  };
}

afterEach(() => {
  extensionPoints.unregisterAll(OWNER);
  AgentRegistry.resetInstance();
  ToolRegistry.resetInstance();
  APIScheduler.resetInstance();
  CoordinationService.resetInstance();
  SessionManager.resetInstance();
  SessionStore.resetInstance();
  vi.restoreAllMocks();
});

describe('AgentLoop reliability regressions', () => {
  it('updates a live Agent in place without losing active-session state', () => {
    const agent = new Agent(makeAgentConfig());
    agent.adjustSessionCount(1);
    agent.setSessionStatus('session-1', AgentStatus.Working);
    AgentRegistry.getInstance().registerAgent(agent);

    agent.updateFromConfig(makeAgentConfig({
      model: 'new-model',
      apiKey: 'new-key',
      parentAgentId: 'manager-1',
      teamName: 'New Team',
    }));

    expect(AgentRegistry.getInstance().agent('agent-1')).toBe(agent);
    expect(agent.modelName).toBe('new-model');
    expect(agent.apiKey).toBe('new-key');
    expect(agent.parentAgentId).toBe('manager-1');
    expect(agent.teamName).toBe('New Team');
    expect(agent.servingSessionCount).toBe(1);
    expect(agent.sessionStatus('session-1')).toBe(AgentStatus.Working);
  });

  it('uses a replacement Agent model configuration on the following turn', async () => {
    ToolRegistry.getInstance().registerTool(new ContinueTool());
    AgentRegistry.getInstance().registerAgent(new Agent(makeAgentConfig({
      allowedTools: ['ContinueTool'],
    })));
    const observed: Array<{ model: string; apiKey: string }> = [];
    let callCount = 0;

    extensionPoints.register('llmProvider', OWNER, () => ({
      async *chat(
        _messages: unknown[],
        _tools: unknown[],
        _systemPrompt: string,
        options: LLMOptions,
      ): AsyncGenerator<LLMStreamEvent> {
        callCount++;
        observed.push({ model: options.model, apiKey: options.apiKey || '' });
        if (callCount === 1) {
          AgentRegistry.getInstance().registerAgent(new Agent(makeAgentConfig({
            model: 'new-model',
            apiKey: 'new-key',
            allowedTools: ['ContinueTool'],
          })));
          yield { type: 'tool_use', toolId: 'continue-1', toolName: 'ContinueTool', toolInput: {} };
        } else {
          yield { type: 'text_delta', content: 'finished with new config' };
        }
        yield { type: 'done' };
      },
      cancel(): void {},
      providerName(): string { return 'test'; },
    }));

    const loop = new AgentLoop({
      maxTurns: 2,
      temperature: 0,
      contextWindow: 8000,
      agentId: 'agent-1',
      sessionId: 'session-1',
      systemPromptOverride: 'Complete the task.',
    });
    const events = [];
    for await (const event of loop.run(makeUserMessage(), [])) events.push(event);

    expect(observed).toEqual([
      { model: 'old-model', apiKey: 'old-key' },
      { model: 'new-model', apiKey: 'new-key' },
    ]);
    expect(events.some(event => (
      event.type === SSEEventType.Text && event.content === 'finished with new config'
    ))).toBe(true);
  });

  it('does not re-inject old history that was excluded from the context window', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anoclaw-loop-identity-'));
    const sessionManager = SessionManager.getInstance();

    try {
      await sessionManager.initialize(path.join(tmpDir, 'sessions'));
      await fsp.mkdir(path.join(tmpDir, 'workspace'), { recursive: true });
      const session = await sessionManager.createMainSession(
        'agent-1',
        'Identity cursor',
        path.join(tmpDir, 'workspace'),
      );
      ToolRegistry.getInstance().registerTool(new ContinueTool());
      AgentRegistry.getInstance().registerAgent(new Agent(makeAgentConfig({
        contextWindow: 1200,
        allowedTools: ['ContinueTool'],
      })));

      const oldMessage: Message = {
        ...makeUserMessage(session.id, 'old-excluded'),
        content: `OLD_EXCLUDED_MARKER ${'old context '.repeat(1000)}`,
      };
      const currentMessage = makeUserMessage(session.id, 'current-message');
      await sessionManager.appendMessage(session.id, oldMessage);
      await sessionManager.appendMessage(session.id, currentMessage);
      const history = await sessionManager.getHistory(session.id);
      const captured: Array<Array<{ role: string; content: string }>> = [];
      let callCount = 0;

      extensionPoints.register('llmProvider', OWNER, () => ({
        async *chat(messages: Array<{ role: string; content: string }>): AsyncGenerator<LLMStreamEvent> {
          callCount++;
          captured.push(messages.map(message => ({ ...message })));
          if (callCount === 1) {
            await sessionManager.appendMessage(session.id, {
              ...makeUserMessage(session.id, 'fresh-external'),
              content: 'FRESH_EXTERNAL_MARKER',
            });
            yield { type: 'tool_use', toolId: 'continue-1', toolName: 'ContinueTool', toolInput: {} };
          } else {
            yield { type: 'text_delta', content: 'done' };
          }
          yield { type: 'done' };
        },
        cancel(): void {},
        providerName(): string { return 'test'; },
      }));

      const loop = new AgentLoop({
        maxTurns: 2,
        temperature: 0,
        contextWindow: 1200,
        agentId: 'agent-1',
        sessionId: session.id,
        systemPromptOverride: 'Complete the task.',
      });
      for await (const _event of loop.run(currentMessage, history)) {
        // Drain the loop.
      }

      expect(captured).toHaveLength(2);
      expect(captured[1].some(message => message.content.includes('FRESH_EXTERNAL_MARKER'))).toBe(true);
      expect(captured[1].some(message => message.content.includes('OLD_EXCLUDED_MARKER'))).toBe(false);
    } finally {
      extensionPoints.unregisterAll(OWNER);
      SessionManager.resetInstance();
      SessionStore.resetInstance();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('requests a final answer after a reasoning-only response', async () => {
    AgentRegistry.getInstance().registerAgent(new Agent(makeAgentConfig()));
    let callCount = 0;
    let secondCallMessages: Array<{ role: string; content: string }> = [];

    extensionPoints.register('llmProvider', OWNER, () => ({
      async *chat(messages: Array<{ role: string; content: string }>): AsyncGenerator<LLMStreamEvent> {
        callCount++;
        if (callCount === 1) {
          yield { type: 'think_delta', content: 'private reasoning' };
        } else {
          secondCallMessages = messages;
          yield { type: 'text_delta', content: 'final answer' };
        }
        yield { type: 'done' };
      },
      cancel(): void {},
      providerName(): string { return 'test'; },
    }));

    const loop = new AgentLoop({
      maxTurns: 2,
      temperature: 0,
      contextWindow: 8000,
      agentId: 'agent-1',
      sessionId: 'session-1',
      systemPromptOverride: 'Complete the task.',
    });
    const events = [];
    for await (const event of loop.run(makeUserMessage(), [])) events.push(event);

    expect(callCount).toBe(2);
    expect(secondCallMessages.some(message => (
      message.content.includes('Please provide your final answer based on your reasoning above')
    ))).toBe(true);
    expect(secondCallMessages.some(message => message.content.includes('[Recovery:'))).toBe(false);
    expect(events.some(event => event.type === SSEEventType.Text && event.content === 'final answer')).toBe(true);
  });
});
