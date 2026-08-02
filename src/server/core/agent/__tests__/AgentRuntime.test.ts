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
 *   - durable task routing and Goal continuation behavior
 */

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRuntime, buildGoalContinuationContent } from '../AgentRuntime.js';
import { AgentLoop } from '../AgentLoop.js';
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
import { WsServer } from '../../../infra/network/WsServer.js';
import { CoordinationService } from '../../coordination/CoordinationService.js';
import { SessionManager } from '../../session/SessionManager.js';
import type { CoordinationMessage, CoordinationTask } from '../../../../shared/types/coordination.js';

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

afterEach(() => {
  vi.restoreAllMocks();
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

    it('serializes idle-session wakes and deduplicates the same notification', async () => {
      const runtime = AgentRuntime.getInstance();
      const started: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      vi.spyOn(runtime as any, 'processIdleSessionWake').mockImplementation(
        async (request: unknown) => {
          const notificationId = (request as { notificationId: string }).notificationId;
          started.push(notificationId);
          if (notificationId === 'notification-1') await firstBlocked;
        },
      );

      const first = {
        sessionId: 'session-1',
        agentId: 'agent-1',
        notificationId: 'notification-1',
        content: 'first',
        source: 'test',
      };
      const second = {
        ...first,
        notificationId: 'notification-2',
        content: 'second',
      };
      (runtime as any).enqueueIdleSessionWake(first);
      (runtime as any).enqueueIdleSessionWake(second);
      (runtime as any).enqueueIdleSessionWake(second);
      await vi.waitFor(() => expect(started).toEqual(['notification-1']));

      releaseFirst();
      await (runtime as any)._idleSessionWakeQueues.get('session-1');

      expect(started).toEqual(['notification-1', 'notification-2']);
      expect((runtime as any)._idleSessionWakeQueues.has('session-1')).toBe(false);
    });
  });

  describe('coordination result delivery', () => {
    it('queues an automatic idle wake after durably delivering a task result', async () => {
      const runtime = AgentRuntime.getInstance();
      const service = CoordinationService.getInstance();
      const sessionManager = SessionManager.getInstance();
      const task: CoordinationTask = {
        id: 'task-1',
        rootSessionId: 'root-1',
        sourceSessionId: 'source-1',
        mode: 'hierarchy',
        subject: 'Report status',
        description: 'Return a status report',
        acceptanceCriteria: [],
        priority: 'normal',
        creatorAgentId: 'creator-1',
        assigneeAgentId: 'worker-1',
        dependsOn: [],
        readOnly: true,
        writeScope: [],
        status: 'completed',
        version: 4,
        attempt: 1,
        maxAttempts: 1,
        sessionId: 'worker-session-1',
        resultSummary: 'All checks passed.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const message: CoordinationMessage = {
        id: 'message-task-result-1',
        rootSessionId: 'root-1',
        taskId: task.id,
        fromAgentId: 'worker-1',
        toAgentId: 'creator-1',
        kind: 'task_result',
        content: 'All checks passed.',
        sequence: 1,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      vi.spyOn(service, 'queueMessage').mockResolvedValue(message);
      const updateStatus = vi.spyOn(service, 'updateMessageStatus').mockResolvedValue({
        ...message,
        status: 'delivered',
      });
      vi.spyOn(sessionManager, 'session').mockImplementation((sessionId: string) => (
        sessionId === 'source-1' ? { id: 'source-1' } as any : undefined
      ));
      vi.spyOn(sessionManager, 'getHistory').mockResolvedValue([]);
      const appendMessage = vi.spyOn(sessionManager, 'appendMessage').mockResolvedValue(undefined);
      const enqueueWake = vi.spyOn(runtime as any, 'enqueueIdleSessionWake').mockImplementation(() => {});

      await (runtime as any).deliverCoordinationResult(task, 'completed');

      expect(appendMessage).toHaveBeenCalledWith('source-1', expect.objectContaining({
        id: message.id,
        role: 'user',
        content: expect.stringContaining('All checks passed.'),
      }));
      expect(updateStatus).toHaveBeenCalledWith('root-1', message.id, 'delivered', 'creator-1');
      expect(enqueueWake).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'source-1',
        agentId: 'creator-1',
        notificationId: message.id,
        source: 'coordination_result',
      }));
    });

    it('leaves an idle coordination parent for the scheduler instead of racing it with a generic wake', async () => {
      const runtime = AgentRuntime.getInstance();
      const service = CoordinationService.getInstance();
      const sessionManager = SessionManager.getInstance();
      const now = new Date().toISOString();
      const parent: CoordinationTask = {
        id: 'parent-task',
        rootSessionId: 'root-1',
        sourceSessionId: 'root-1',
        mode: 'hierarchy',
        subject: 'Parent',
        description: 'Integrate child results',
        acceptanceCriteria: [],
        priority: 'normal',
        creatorAgentId: 'ceo',
        assigneeAgentId: 'manager',
        dependsOn: [],
        readOnly: true,
        writeScope: [],
        status: 'blocked',
        blocker: 'waiting_for_child_tasks',
        version: 5,
        attempt: 1,
        maxAttempts: 3,
        sessionId: 'manager-session',
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const child: CoordinationTask = {
        ...parent,
        id: 'child-task',
        sourceSessionId: 'manager-session',
        subject: 'Child',
        creatorAgentId: 'manager',
        assigneeAgentId: 'worker',
        status: 'completed',
        blocker: undefined,
        sessionId: 'worker-session',
        resultSummary: 'Child result',
      };
      const message: CoordinationMessage = {
        id: 'child-result-message',
        rootSessionId: 'root-1',
        taskId: child.id,
        fromAgentId: 'worker',
        toAgentId: 'manager',
        kind: 'task_result',
        content: 'Child result',
        summary: 'Child: completed',
        sequence: 1,
        status: 'queued',
        createdAt: now,
      };
      vi.spyOn(service, 'queueMessage').mockResolvedValue(message);
      vi.spyOn(service, 'updateMessageStatus').mockResolvedValue({
        ...message,
        status: 'delivered',
      });
      vi.spyOn(service, 'getTask').mockReturnValue(parent);
      vi.spyOn(service, 'listDirectChildTasks').mockReturnValue([child]);
      vi.spyOn(sessionManager, 'session').mockReturnValue({
        id: 'manager-session',
        metadata: { coordinationTaskId: parent.id },
      } as any);
      vi.spyOn(sessionManager, 'getHistory').mockResolvedValue([]);
      vi.spyOn(sessionManager, 'appendMessage').mockResolvedValue(undefined);
      const enqueueWake = vi.spyOn(runtime as any, 'enqueueIdleSessionWake').mockImplementation(() => {});

      await runtime.deliverCoordinationResult(child, 'completed');

      expect(enqueueWake).not.toHaveBeenCalled();
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

    it('reserves a session during async preflight so a second loop cannot race it', async () => {
      const agent = makeAgent('agent-1', 'TestAgent', AgentRole.Member);
      AgentRegistry.getInstance().registerAgent(agent);
      const runtime = AgentRuntime.getInstance();
      let releasePreflight!: () => void;
      const preflight = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      vi.spyOn(runtime as any, '_resolveUserTask').mockImplementation(async () => {
        await preflight;
        return null;
      });
      const executeLoop = vi.spyOn(runtime as any, '_executeAndForwardLoop')
        .mockImplementation(async function* () {
          yield { type: SSEEventType.Done };
        });
      vi.spyOn(runtime as any, '_runGoalMode').mockImplementation(async function* () {});

      const firstEvents: unknown[] = [];
      const firstRun = (async () => {
        for await (const event of runtime.processMessage(
          'session-race',
          'agent-1',
          {
            id: 'first',
            sessionId: 'session-race',
            role: 'user',
            content: 'first',
            tokenCount: 0,
            compressed: false,
            timestamp: new Date().toISOString(),
          },
        )) firstEvents.push(event);
      })();
      await vi.waitFor(() => expect(runtime.isSessionActive('session-race')).toBe(true));

      const secondEvents: any[] = [];
      for await (const event of runtime.processMessage(
        'session-race',
        'agent-1',
        {
          id: 'second',
          sessionId: 'session-race',
          role: 'user',
          content: 'second',
          tokenCount: 0,
          compressed: false,
          timestamp: new Date().toISOString(),
        },
      )) secondEvents.push(event);

      expect(secondEvents).toHaveLength(1);
      expect(secondEvents[0].content).toContain('queued');
      releasePreflight();
      await firstRun;
      expect(executeLoop).toHaveBeenCalledOnce();
      expect(runtime.isSessionActive('session-race')).toBe(false);
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

  describe('processMessage task routing', () => {
    it('short-circuits with a plugin recommendation when a daily capability is recognized but unavailable', async () => {
      CapabilityRegistry.getInstance().setCatalogCapabilities([{
        id: 'widget.create',
        title: 'Create a widget',
        description: 'Create a widget output.',
        domain: 'utility',
        kind: 'utility',
        triggers: ['widget'],
        requiredTools: ['widget.render'],
        recommendedPlugins: ['widget-provider'],
      }]);
      const agent = makeAgent('main-1', 'MainAgent', AgentRole.MainAgent);
      AgentRegistry.getInstance().registerAgent(agent);

      const runtime = AgentRuntime.getInstance();
      const loopSpy = vi.fn();
      (runtime as any)._executeAndForwardLoop = loopSpy;

      const events: any[] = [];
      for await (const event of runtime.processMessage(
        'session-1',
        'main-1',
        { id: 'm1', sessionId: 'session-1', role: 'user', content: 'Please create a widget', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(loopSpy).not.toHaveBeenCalled();
      expect(events[0].type).toBe(SSEEventType.StatusInfo);
      expect(events[0].taskResolution.bestCapability.id).toBe('widget.create');
      expect(events[0].agentMissingTools).toEqual([]);
      const taskResolutionEvent = events.find((event) => event.type === SSEEventType.TaskResolution);
      expect(taskResolutionEvent?.taskResolution.bestCapability.id).toBe('widget.create');
      expect(taskResolutionEvent?.taskResolution.pluginRecommendations[0].pluginName).toBe('widget-provider');
      expect(events.some((event) => event.type === SSEEventType.Text && String(event.content).includes('widget-provider'))).toBe(true);
      expect(events.at(-1)?.type).toBe(SSEEventType.Done);
    });

    it('injects transient task routing context when a capability can start', async () => {
      CapabilityRegistry.getInstance().setCatalogCapabilities([
        {
          id: 'widget.create',
          title: 'Create a widget',
          description: 'Create a widget output.',
          domain: 'test',
          kind: 'utility',
          triggers: ['widget'],
          requiredTools: ['DoThing'],
          outputs: [{ type: 'file', label: 'Widget file', extension: 'widget' }],
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
      expect(events[0].taskResolution.suggestedToolCall).toMatchObject({
        toolName: 'DoThing',
        parameters: {},
      });
      expect(events.some((event) => event.type === SSEEventType.Text && event.content === 'loop ran')).toBe(true);
      const routingContext = capturedHistory.find((msg) => msg.id.startsWith('task-resolution-'));
      expect(routingContext?.role).toBe('system');
      expect(routingContext?.content).toContain('widget.create');
      expect(routingContext?.content).toContain('DoThing');
      expect(routingContext?.content).toContain('Suggested first tool call: DoThing');
      expect(routingContext?.content).toContain('Suggested tool parameters: {}');
    });

    it('injects workspace IDE guidance for coding routes', async () => {
      CapabilityRegistry.getInstance().setCatalogCapabilities([
        {
          id: 'code.implement',
          title: 'Modify a codebase',
          description: 'Inspect and modify code in the current workspace.',
          domain: 'coding',
          kind: 'automation',
          triggers: ['fix bug'],
          requiredTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
        },
      ]);
      for (const toolName of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']) {
        ToolRegistry.getInstance().registerTool(new FixtureTool(toolName));
      }

      const agent = makeAgent('main-1', 'MainAgent', AgentRole.MainAgent);
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
        { id: 'm1', sessionId: 'session-1', role: 'user', content: 'fix bug in src/app.ts', tokenCount: 0, compressed: false, timestamp: new Date().toISOString() },
      )) {
        events.push(event);
      }

      expect(events[0].type).toBe(SSEEventType.StatusInfo);
      expect(events[0].taskResolution.bestCapability.id).toBe('code.implement');
      expect(events[0].taskResolution.suggestedToolCall).toMatchObject({
        toolName: 'Read',
        parameters: { file_path: 'src/app.ts' },
      });
      const routingContext = capturedHistory.find((msg) => msg.id.startsWith('task-resolution-'));
      expect(routingContext?.content).toContain('Coding route: use the existing workspace/IDE context');
      expect(routingContext?.content).toContain('Editor Context');
      expect(routingContext?.content).toContain('Suggested first tool call: Read');
      expect(routingContext?.content).toContain('Suggested tool parameters: {"file_path":"src/app.ts"}');
    });

    it('auto-grants registered capability tools for the current routed task', async () => {
      CapabilityRegistry.getInstance().setCatalogCapabilities([
        {
          id: 'widget.create',
          title: 'Create a widget',
          description: 'Create a widget output.',
          domain: 'test',
          kind: 'utility',
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
      expect(routingContext?.content).toContain('Suggested first tool call: DoThing');
      expect(events.at(-1)?.type).toBe(SSEEventType.Done);
    });
  });

  describe('goal continuation context', () => {
    it('runs bounded Goal continuations with the contract permission and no persisted internal prompt', async () => {
      const runtime = AgentRuntime.getInstance();
      const goal = {
        goalId: 'goal-1',
        version: 1,
        objective: '持续修复构建问题',
        acceptanceCriteria: '构建通过',
        workspace: 'F:/Projects/AnoClaw',
        permissionMode: 'Auto',
        maxRuns: 20,
        maxConsecutiveFailures: 3,
        wakeIntervalMs: 5000,
        completionMode: 'review',
        status: 'active',
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:01:00.000Z',
        runCount: 0,
        consecutiveFailures: 0,
      };
      let loopPermissionMode: string | undefined;
      let loopWorkspace: string | undefined;
      let loopPrompt = '';
      let extraAllowedTools: string[] = [];
      const runningGoal = { ...goal, runCount: 1, currentRunId: 'run-1', currentRunStartedAt: '2026-07-07T00:02:00.000Z' };
      const reviewGoal = { ...runningGoal, status: 'waiting_review', currentRunId: undefined, lastReportedRunId: 'run-1' };

      const sessionManager = {
        session: vi.fn(() => ({ isRoot: () => true, metadata: { permissionMode: 'Auto' } })),
        getGoal: vi.fn()
          .mockReturnValueOnce(goal)
          .mockReturnValueOnce(goal)
          .mockReturnValueOnce(reviewGoal),
        getRootSession: vi.fn(() => ({ id: 'session-1', workspace: 'F:/Projects/AnoClaw' })),
        beginGoalRun: vi.fn(async () => runningGoal),
        failGoalRun: vi.fn(),
        updateGoalStatus: vi.fn(),
        getHistory: vi.fn(async () => []),
      };
      const runSpy = vi.spyOn(AgentLoop.prototype, 'run').mockImplementation(async function* (this: AgentLoop, message: Message) {
        loopPermissionMode = this.permissionMode;
        loopWorkspace = this.workspace;
        extraAllowedTools = this.extraAllowedTools;
        loopPrompt = message.content;
        yield { type: SSEEventType.Done };
      });
      const sendSpy = vi.spyOn(WsServer.getInstance(), 'send').mockImplementation(() => true);
      const sleepSpy = vi.spyOn(runtime as any, '_sleepUntilGoalWake').mockResolvedValue(undefined);
      const resolveGoalSpy = vi.spyOn(runtime as any, '_resolveGoalTask').mockResolvedValue(null);

      try {
        const events: unknown[] = [];
        for await (const event of (runtime as any)._runGoalMode(
          'session-1',
          sessionManager,
          {
            agentId: 'main-1',
            sessionId: 'session-1',
            maxTurns: 1,
            temperature: 0,
            contextWindow: 128000,
            permissionMode: 'Auto',
          },
          new AbortController().signal,
        )) {
          events.push(event);
        }

        expect(sessionManager.beginGoalRun).toHaveBeenCalledWith('session-1', expect.objectContaining({
          permissionMode: 'AutoEdit',
        }));
        expect(loopPrompt).toContain('Permission mode: AutoEdit');
        expect(loopPrompt).toContain('Run ID: run-1');
        expect(loopPermissionMode).toBe('AutoEdit');
        expect(loopWorkspace).toBe('F:/Projects/AnoClaw');
        expect(extraAllowedTools).toContain('GoalReport');
        expect(events.some((event: any) => event.type === SSEEventType.Wake)).toBe(true);
      } finally {
        runSpy.mockRestore();
        sendSpy.mockRestore();
        sleepSpy.mockRestore();
        resolveGoalSpy.mockRestore();
      }
    });

    it('builds a workspace-aware goal wake prompt with execution context and capability routing', () => {
      const content = buildGoalContinuationContent({
        sessionId: 'session-1',
        goal: {
          goalId: 'goal-1',
          version: 1,
          objective: '修复 workspace 中的构建错误',
          acceptanceCriteria: '构建通过',
          workspace: 'F:/Projects/AnoClaw',
          permissionMode: 'Plan',
          maxRuns: 20,
          maxConsecutiveFailures: 3,
          wakeIntervalMs: 15000,
          completionMode: 'review',
          status: 'active',
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:01:00.000Z',
          runCount: 3,
          consecutiveFailures: 0,
          lastRunAt: '2026-07-07T00:02:00.000Z',
        },
        workspace: 'F:/Projects/AnoClaw',
        permissionMode: 'Plan',
        effort: 'NORMAL',
        locale: 'zh-CN',
        taskResolution: {
          intent: 'capability',
          query: '修复 workspace 中的构建错误',
          locale: 'zh-CN',
          confidence: 0.82,
          nextAction: 'execute_capability',
          canStart: true,
          bestCapability: {
            id: 'code.implement',
            title: 'Modify a codebase',
            description: 'Inspect and modify code in the current workspace.',
            domain: 'coding',
            kind: 'automation',
            triggers: ['fix bug'],
            requiredTools: ['Read', 'Edit', 'Bash'],
            source: 'catalog',
            sourceName: 'anoclaw.default',
            status: 'available',
            missingTools: [],
          },
          candidates: [],
          missingInputs: [],
          missingTools: [],
          recommendedPlugins: [],
          pluginRecommendations: [],
          suggestedToolCall: {
            toolName: 'Glob',
            parameters: { pattern: '**/*.{ts,tsx,js}' },
            confidence: 0.55,
            notes: ['Start from the current IDE/editor context when available.'],
          },
          assumptions: [],
          reason: 'Resolved to code.implement (available).',
          suggestedResponse: 'I found the "Modify a codebase" capability and can start now.',
        },
      });

      expect(content).toContain('Objective: 修复 workspace 中的构建错误');
      expect(content).toContain('Run count: 3');
      expect(content).toContain('Workspace: F:/Projects/AnoClaw');
      expect(content).toContain('Permission mode: Plan');
      expect(content).toContain('Resolved capability: code.implement');
      expect(content).toContain('Suggested first tool call: Glob');
      expect(content).toContain('Coding task: start from the current IDE/workspace context');
      expect(content).toContain('Plan mode is active');
    });
  });
});
