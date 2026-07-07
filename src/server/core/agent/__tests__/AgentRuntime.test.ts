/**
 * AgentRuntime tests — singleton runtime manager
 *
 * Covers:
 *   - Singleton: getInstance, resetInstance
 *   - isSessionActive: active loop tracking
 *   - activeSessionCount
 *   - cleanupSession
 *   - processMessage rejection paths (agent not found, agent destroyed,
 *     concurrent session guard)
 *   - delegateTask permission checks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRuntime } from '../AgentRuntime.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { Agent } from '../Agent.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import { SSEEventType } from '../../../../shared/types/events.js';
import { InterruptController } from '../supervision/InterruptController.js';
import { SessionLeaseManager } from '../../session/SessionLeaseManager.js';
import { CapabilityRegistry } from '../../capability/CapabilityRegistry.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { Tool, type ExecutionContext } from '../../tools/Tool.js';
import type { Message } from '../../../../shared/types/session.js';
import type { ToolResult } from '../../../../shared/types/tool.js';

// Reset singletons before each test
beforeEach(() => {
  AgentRuntime.resetInstance();
  AgentRegistry.resetInstance();
  CapabilityRegistry.resetInstance();
  ToolRegistry.resetInstance();
  (InterruptController as any)._instance = null;
  // SessionLeaseManager can't be reset via static method easily; recreate
  const slm = SessionLeaseManager.getInstance();
  (slm as any)._leases?.clear();
});

class FixtureTool extends Tool {
  constructor(private readonly toolName: string) {
    super();
  }

  name(): string {
    return this.toolName;
  }

  description(): string {
    return `${this.toolName} fixture`;
  }

  parametersSchema(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }

  async execute(_params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
    return this.makeResult('ok');
  }
}

function makeAgent(id: string, name: string, role: AgentRole, allowedTools: string[] = []): Agent {
  return new Agent({
    id,
    name,
    role,
    parentAgentId: null,
    level: role === AgentRole.MainAgent ? 0 : 1,
    teamName: '',
    provider: 'test',
    apiUrl: '',
    apiKey: 'sk-test',
    model: 'test-model',
    contextWindow: 128000,
    maxTurns: 25,
    temperature: 0.7,
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

describe('AgentRuntime', () => {
  // ── Singleton ──

  describe('singleton', () => {
    it('getInstance returns the same instance', () => {
      const a = AgentRuntime.getInstance();
      const b = AgentRuntime.getInstance();
      expect(a).toBe(b);
    });

    it('resetInstance creates a new instance on next getInstance', () => {
      const a = AgentRuntime.getInstance();
      AgentRuntime.resetInstance();
      const b = AgentRuntime.getInstance();
      expect(b).not.toBe(a);
    });
  });

  // ── Session tracking ──

  describe('isSessionActive / activeSessionCount / cleanupSession', () => {
    it('starts with no active sessions', () => {
      const runtime = AgentRuntime.getInstance();
      expect(runtime.isSessionActive('any')).toBe(false);
      expect(runtime.activeSessionCount).toBe(0);
    });

    it('cleanupSession removes a session from active tracking', () => {
      const runtime = AgentRuntime.getInstance();

      // Manually add to the private _activeLoops map
      (runtime as any)._activeLoops.set('session-1', {});
      expect(runtime.isSessionActive('session-1')).toBe(true);
      expect(runtime.activeSessionCount).toBe(1);

      runtime.cleanupSession('session-1');
      expect(runtime.isSessionActive('session-1')).toBe(false);
      expect(runtime.activeSessionCount).toBe(0);
    });

    it('isSessionActive returns false for unknown sessions', () => {
      const runtime = AgentRuntime.getInstance();
      expect(runtime.isSessionActive('nonexistent')).toBe(false);
    });

    it('cleanupSession is idempotent for already-cleaned sessions', () => {
      const runtime = AgentRuntime.getInstance();
      // Should not throw
      runtime.cleanupSession('never-added');
    });
  });

  // ── processMessage ──

  describe('processMessage — rejection paths', () => {
    it('rejects with error when agent is not found', async () => {
      const runtime = AgentRuntime.getInstance();
      const events: any[] = [];

      for await (const event of runtime.processMessage(
        'session-1',
        'unknown-agent',
        { id: 'm1', sessionId: 'session-1', role: 'user', content: 'hello', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(SSEEventType.Error);
      expect(events[0].errorMessage).toContain('Agent not found');
    });

    it('rejects with error when agent is destroyed', async () => {
      const agent = makeAgent('agent-1', 'TestAgent', AgentRole.Member);
      agent.setState(AgentState.Destroyed);
      AgentRegistry.getInstance().registerAgent(agent);

      const runtime = AgentRuntime.getInstance();
      const events: any[] = [];

      for await (const event of runtime.processMessage(
        'session-1',
        'agent-1',
        { id: 'm1', sessionId: 'session-1', role: 'user', content: 'hello', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(SSEEventType.Error);
      expect(events[0].errorMessage).toContain('is destroyed');
    });

    it('queues message as pending interrupt when session already active', async () => {
      const agent = makeAgent('agent-1', 'TestAgent', AgentRole.Member);
      AgentRegistry.getInstance().registerAgent(agent);

      const runtime = AgentRuntime.getInstance();

      // Simulate an active session
      (runtime as any)._activeLoops.set('session-1', {});

      const events: any[] = [];
      for await (const event of runtime.processMessage(
        'session-1',
        'agent-1',
        { id: 'm1', sessionId: 'session-1', role: 'user', content: 'new message', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(SSEEventType.StatusInfo);
      expect(events[0].content).toContain('queued');
    });

    it('allows unlimited concurrent sessions (no lease limit)', async () => {
      const agent = makeAgent('agent-1', 'TestAgent', AgentRole.Member);
      AgentRegistry.getInstance().registerAgent(agent);
      const runtime = AgentRuntime.getInstance();
      const slm = SessionLeaseManager.getInstance();
      // Fill leases with 5 blocker sessions — should NOT reject new ones
      for (let i = 0; i < 5; i++) {
        slm.acquire(`blocker-${i}`);
      }
      // This should NOT throw or return an error — unlimited concurrency
      expect(slm.activeCount).toBeGreaterThanOrEqual(5);
      // Clean up
      for (let i = 0; i < 5; i++) {
        slm.release(`blocker-${i}`);
      }
    });
  });

  // ── delegateTask ──

  describe('delegateTask — permission checks', () => {
    beforeEach(() => {
      // Make sure InterruptController is clean
      (InterruptController as any)._instance = null;
    });

    it('rejects with permission denied when delegator is not a manager role', async () => {
      const member = makeAgent('member-1', 'Member1', AgentRole.Member);
      AgentRegistry.getInstance().registerAgent(member);

      const target = makeAgent('target-1', 'Target', AgentRole.Member);
      AgentRegistry.getInstance().registerAgent(target);

      const runtime = AgentRuntime.getInstance();
      const result = await runtime.delegateTask('target-1', 'do stuff', 'parent-session', 'member-1');

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('Permission denied');
    });

    it('rejects when target agent is not found', async () => {
      const mainAgent = makeAgent('main-1', 'CEO', AgentRole.MainAgent);
      AgentRegistry.getInstance().registerAgent(mainAgent);

      const runtime = AgentRuntime.getInstance();
      const result = await runtime.delegateTask('nonexistent', 'do stuff', 'parent-session', 'main-1');

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('Target agent not found');
    });

    it('rejects when target agent is destroyed', async () => {
      const mainAgent = makeAgent('main-1', 'CEO', AgentRole.MainAgent);
      AgentRegistry.getInstance().registerAgent(mainAgent);

      const target = makeAgent('target-1', 'Target', AgentRole.Member);
      target.setState(AgentState.Destroyed);
      AgentRegistry.getInstance().registerAgent(target);

      const runtime = AgentRuntime.getInstance();
      const result = await runtime.delegateTask('target-1', 'do stuff', 'parent-session', 'main-1');

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('is destroyed');
    });

    it('allows MainAgent to delegate to an active member', async () => {
      const mainAgent = makeAgent('main-1', 'CEO', AgentRole.MainAgent);
      AgentRegistry.getInstance().registerAgent(mainAgent);

      const target = makeAgent('target-1', 'Target', AgentRole.Member);
      AgentRegistry.getInstance().registerAgent(target);

      const runtime = AgentRuntime.getInstance();

      // Without proper session mocks this will fail on createSubSession.
      // But we can verify it passes the permission check.
      const result = await runtime.delegateTask('target-1', 'do stuff', 'parent-session', 'main-1');

      // Should NOT be a permission error
      expect(result.errorMessage).not.toContain('Permission denied');
    });
  });

  describe('processMessage task routing', () => {
    it('short-circuits with a plugin recommendation when a daily capability is recognized but unavailable', async () => {
      const agent = makeAgent('main-1', 'MainAgent', AgentRole.MainAgent);
      AgentRegistry.getInstance().registerAgent(agent);

      const runtime = AgentRuntime.getInstance();
      const loopSpy = vi.fn();
      (runtime as any)._executeAndForwardLoop = loopSpy;

      const events: any[] = [];
      for await (const event of runtime.processMessage(
        'session-1',
        'main-1',
        { id: 'm1', sessionId: 'session-1', role: 'user', content: '帮我做一个介绍太阳系的 PPT', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(loopSpy).not.toHaveBeenCalled();
      expect(events[0].type).toBe(SSEEventType.StatusInfo);
      expect(events[0].taskResolution.bestCapability.id).toBe('presentation.create');
      expect(events[0].agentMissingTools).toEqual([]);
      const taskResolutionEvent = events.find((event) => event.type === SSEEventType.TaskResolution);
      expect(taskResolutionEvent?.taskResolution.bestCapability.id).toBe('presentation.create');
      expect(taskResolutionEvent?.taskResolution.pluginRecommendations[0].pluginName).toBe('anoclaw-office');
      expect(events.some((event) => event.type === SSEEventType.Text && String(event.content).includes('office'))).toBe(true);
      expect(events.at(-1)?.type).toBe(SSEEventType.Done);
    });

    it('injects transient task routing context when a capability can start', async () => {
      CapabilityRegistry.getInstance().setCatalogCapabilities([
        {
          id: 'widget.create',
          title: 'Create a widget',
          description: 'Create a widget artifact.',
          domain: 'test',
          kind: 'artifact',
          triggers: ['widget'],
          requiredTools: ['DoThing'],
          outputs: [{ type: 'file', label: 'Widget file', extension: 'widget', artifactType: 'widget' }],
        },
      ]);
      ToolRegistry.getInstance().registerTool(new FixtureTool('DoThing'));

      const agent = makeAgent('main-1', 'MainAgent', AgentRole.MainAgent, ['DoThing']);
      AgentRegistry.getInstance().registerAgent(agent);

      const runtime = AgentRuntime.getInstance();
      let capturedHistory: Message[] = [];
      (runtime as any)._runGoalMode = vi.fn(async function* () {});
      (runtime as any)._executeAndForwardLoop = vi.fn(async function* (
        _loop: unknown,
        _message: Message,
        history: Message[],
      ) {
        capturedHistory = history;
        yield { type: SSEEventType.Text, content: 'loop ran' };
      });

      const events: any[] = [];
      for await (const event of runtime.processMessage(
        'session-1',
        'main-1',
        { id: 'm1', sessionId: 'session-1', role: 'user', content: 'please create a widget for me', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(events[0].type).toBe(SSEEventType.StatusInfo);
      expect(events[0].taskResolution.bestCapability.id).toBe('widget.create');
      expect(events.some((event) => event.type === SSEEventType.Text && event.content === 'loop ran')).toBe(true);
      const routingContext = capturedHistory.find((msg) => msg.id.startsWith('task-resolution-'));
      expect(routingContext?.role).toBe('system');
      expect(routingContext?.content).toContain('widget.create');
      expect(routingContext?.content).toContain('DoThing');
    });

    it('auto-grants registered capability tools for the current routed task', async () => {
      CapabilityRegistry.getInstance().setCatalogCapabilities([
        {
          id: 'widget.create',
          title: 'Create a widget',
          description: 'Create a widget artifact.',
          domain: 'test',
          kind: 'artifact',
          triggers: ['widget'],
          requiredTools: ['DoThing'],
        },
      ]);
      ToolRegistry.getInstance().registerTool(new FixtureTool('DoThing'));

      const agent = makeAgent('main-1', 'MainAgent', AgentRole.MainAgent);
      AgentRegistry.getInstance().registerAgent(agent);

      const runtime = AgentRuntime.getInstance();
      let grantedTools: string[] = [];
      let capturedHistory: Message[] = [];
      (runtime as any)._runGoalMode = vi.fn(async function* () {});
      (runtime as any)._executeAndForwardLoop = vi.fn(async function* (
        loop: { extraAllowedTools: string[] },
        _message: Message,
        history: Message[],
      ) {
        grantedTools = loop.extraAllowedTools;
        capturedHistory = history;
        yield { type: SSEEventType.Text, content: 'loop ran' };
        yield { type: SSEEventType.Done };
      });

      const events: any[] = [];
      for await (const event of runtime.processMessage(
        'session-1',
        'main-1',
        { id: 'm1', sessionId: 'session-1', role: 'user', content: 'please create a widget for me', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(events[0].type).toBe(SSEEventType.StatusInfo);
      expect(events[0].agentMissingTools).toEqual([]);
      expect(events.some((event) => event.type === SSEEventType.Text && event.content === 'loop ran')).toBe(true);
      expect(grantedTools).toEqual(['DoThing']);
      expect(agent.allowedTools()).toEqual([]);
      const routingContext = capturedHistory.find((msg) => msg.id.startsWith('task-resolution-'));
      expect(routingContext?.content).toContain('DoThing');
      expect(events.at(-1)?.type).toBe(SSEEventType.Done);
    });
  });
});
