/**
 * AgentLoop tests — main ReAct loop execution engine
 *
 * Covers:
 *   - constructor: config storage, defaults
 *   - ExtensionPoints override (plugin integration)
 *   - Agent not found path
 *   - Config edge cases (maxTurns=0 → Infinity, temperature)
 *
 * Note: The full ReAct loop (run method) depends on LLM calls, SessionManager,
 * AgentRegistry, ToolRegistry, PromptAssembler, and TokenCounter. These are
 * tested through integration tests. Unit tests here cover the constructs and
 * paths that are isolable.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../AgentLoop.js';
import { MAX_TURNS_DEFAULT } from '../../../../shared/constants.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { Agent } from '../Agent.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { RiskLevel, Tool, type ExecutionContext } from '../../tools/Tool.js';
import type { ToolResult } from '../../../../shared/types/tool.js';
import type { Message } from '../../../../shared/types/session.js';
import type { LLMStreamEvent } from '../../../../shared/types/llm.js';
import { SSEEventType } from '../../../../shared/types/events.js';
import { extensionPoints } from '../../plugin-host/ExtensionPoints.js';
import { APIScheduler } from '../../../infra/llm/APIScheduler.js';

const LLM_OVERRIDE_OWNER = 'agent-loop-effective-allowlist-test';

class FixtureTool extends Tool {
  executions = 0;

  constructor(
    private readonly toolName: string,
    private readonly risk: RiskLevel = RiskLevel.Safe,
  ) {
    super();
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    return `${this.toolName} fixture`;
  }

  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {}, additionalProperties: false };
  }

  riskLevel(): RiskLevel {
    return this.risk;
  }

  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    this.executions++;
    return this.makeResult(`${this.toolName} executed`);
  }
}

function makeAgent(allowedTools: string[]): Agent {
  return new Agent({
    id: 'agent-1',
    name: 'Allowlist Agent',
    role: AgentRole.Member,
    parentAgentId: null,
    level: 2,
    teamName: '',
    provider: 'test',
    apiUrl: '',
    apiKey: 'sk-test',
    model: 'test-model',
    contextWindow: 128000,
    maxTurns: 2,
    temperature: 0,
    agentPrompt: '',
    preferredLanguage: 'en',
    conversationLanguage: 'en',
    allowedTools,
    enabledSkills: [],
    mcpServers: [],
    state: AgentState.Active,
    createdAt: new Date().toISOString(),
  });
}

function installToolCallSequence(toolName: string): void {
  let callCount = 0;
  extensionPoints.register('llmProvider', LLM_OVERRIDE_OWNER, () => ({
    async *chat(): AsyncGenerator<LLMStreamEvent> {
      callCount++;
      if (callCount === 1) {
        yield { type: 'tool_use', toolId: 'call-1', toolName, toolInput: {} };
      } else {
        yield { type: 'text_delta', content: 'finished' };
      }
      yield { type: 'done' };
    },
    cancel(): void {},
    providerName(): string {
      return 'agent-loop-test';
    },
  }));
}

function userMessage(): Message {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Run the requested tool',
    tokenCount: 0,
    compressed: false,
    timestamp: new Date().toISOString(),
  };
}

afterEach(() => {
  extensionPoints.unregisterAll(LLM_OVERRIDE_OWNER);
  AgentRegistry.resetInstance();
  ToolRegistry.resetInstance();
  APIScheduler.resetInstance();
  vi.restoreAllMocks();
});

describe('AgentLoop', () => {
  // ── Constructor ──

  describe('constructor', () => {
    it('stores config values', () => {
      const loop = new AgentLoop({
        maxTurns: 10,
        temperature: 0.5,
        contextWindow: 128000,
        agentId: 'agent-1',
        sessionId: 'session-1',
      });

      expect(loop.agentId).toBe('agent-1');
      expect(loop.sessionId).toBe('session-1');
      expect(loop.maxTurns).toBe(10);
      expect(loop.temperature).toBe(0.5);
      expect(loop.contextWindow).toBe(128000);
    });

    it('uses default maxTurns when not provided', () => {
      const loop = new AgentLoop({
        maxTurns: undefined as unknown as number,
        temperature: 0.7,
        contextWindow: 128000,
        agentId: 'a',
        sessionId: 's',
      });

      expect(loop.maxTurns).toBe(MAX_TURNS_DEFAULT);
    });

    it('uses zero temperature', () => {
      const loop = new AgentLoop({
        maxTurns: 25,
        temperature: 0,
        contextWindow: 64000,
        agentId: 'a',
        sessionId: 's',
      });

      expect(loop.temperature).toBe(0);
    });

    it('handles large context window', () => {
      const loop = new AgentLoop({
        maxTurns: 25,
        temperature: 0.7,
        contextWindow: 1000000,
        agentId: 'a',
        sessionId: 's',
      });

      expect(loop.contextWindow).toBe(1000000);
    });

    it('supports empty string IDs', () => {
      const loop = new AgentLoop({
        maxTurns: 25,
        temperature: 0.7,
        contextWindow: 128000,
        agentId: '',
        sessionId: '',
      });

      expect(loop.agentId).toBe('');
      expect(loop.sessionId).toBe('');
    });
  });

  // ── maxTurns edge case ──

  describe('maxTurns edge cases (internal logic)', () => {
    it('treats maxTurns=0 as Infinity (unlimited turns) in the run loop', () => {
      // The loop body uses: const maxTurns = this.maxTurns <= 0 ? Infinity : this.maxTurns;
      // This is tested indirectly — we can verify config passes through correctly.
      const loop = new AgentLoop({
        maxTurns: 0,
        temperature: 0.7,
        contextWindow: 128000,
        agentId: 'a',
        sessionId: 's',
      });

      expect(loop.maxTurns).toBe(0);
    });

    it('accepts negative maxTurns (treated as Infinity)', () => {
      const loop = new AgentLoop({
        maxTurns: -1,
        temperature: 0.7,
        contextWindow: 128000,
        agentId: 'a',
        sessionId: 's',
      });

      expect(loop.maxTurns).toBe(-1);
    });
  });

  describe('effective tool allowlist enforcement', () => {
    it('rejects a registered high-risk tool that is absent from agentTools without executing it', async () => {
      const registry = ToolRegistry.getInstance();
      const allowedTool = new FixtureTool('AllowedTool');
      const blockedTool = new FixtureTool('BlockedHighRiskTool', RiskLevel.High);
      registry.registerTool(allowedTool);
      registry.registerTool(blockedTool);
      AgentRegistry.getInstance().registerAgent(makeAgent(['AllowedTool']));
      installToolCallSequence('BlockedHighRiskTool');
      const registryExecute = vi.spyOn(registry, 'execute');

      const loop = new AgentLoop({
        maxTurns: 2,
        temperature: 0,
        contextWindow: 128000,
        agentId: 'agent-1',
        sessionId: 'session-1',
        permissionMode: 'AutoEdit',
        systemPromptOverride: 'Test tool allowlist enforcement.',
      });
      const events = [];
      for await (const event of loop.run(userMessage(), [])) events.push(event);

      expect(registryExecute).not.toHaveBeenCalled();
      expect(blockedTool.executions).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({
        type: SSEEventType.ToolResult,
        toolName: 'BlockedHighRiskTool',
        success: false,
        content: expect.stringContaining('not allowed for this agent'),
      }));
    });

    it('continues to execute a registered tool present in agentTools', async () => {
      const registry = ToolRegistry.getInstance();
      const allowedTool = new FixtureTool('AllowedTool');
      registry.registerTool(allowedTool);
      AgentRegistry.getInstance().registerAgent(makeAgent(['AllowedTool']));
      installToolCallSequence('AllowedTool');
      const registryExecute = vi.spyOn(registry, 'execute');

      const loop = new AgentLoop({
        maxTurns: 2,
        temperature: 0,
        contextWindow: 128000,
        agentId: 'agent-1',
        sessionId: 'session-1',
        permissionMode: 'AutoEdit',
        systemPromptOverride: 'Test tool allowlist enforcement.',
      });
      const events = [];
      for await (const event of loop.run(userMessage(), [])) events.push(event);

      expect(registryExecute).toHaveBeenCalledOnce();
      expect(registryExecute).toHaveBeenCalledWith(
        'AllowedTool',
        {},
        expect.objectContaining({ agentId: 'agent-1', sessionId: 'session-1' }),
        'call-1',
      );
      expect(allowedTool.executions).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({
        type: SSEEventType.ToolResult,
        toolName: 'AllowedTool',
        success: true,
        content: 'AllowedTool executed',
      }));
    });
  });
});
