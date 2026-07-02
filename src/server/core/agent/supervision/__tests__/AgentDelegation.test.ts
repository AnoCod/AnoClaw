/**
 * AgentDelegation tests — sub-agent management and delegation flow
 *
 * Covers:
 *   - subAgentAllowedTools: correct tool list per type
 *   - bubbleEventToParent: filtering, event emission
 *   - emitDelegationStatus: phase routing to TypedEventBus
 *   - handleSubAgentOutput: content accumulation, state mutation, persistence
 *   - spawnSubAgent: permission check, agent lifecycle, success/error paths
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  subAgentAllowedTools,
  bubbleEventToParent,
  emitDelegationStatus,
  handleSubAgentOutput,
  spawnSubAgent,
  type DelegationState,
} from '../../AgentDelegation.js';
import type { AgentRuntime } from '../../AgentRuntime.js';
import { SSEEventType } from '../../../../../shared/types/events.js';
import type { SSEEvent } from '../../../../../shared/types/events.js';
import { AgentRegistry } from '../../AgentRegistry.js';
import { Agent } from '../../Agent.js';
import { AgentRole, AgentState } from '../../../../../shared/types/agent.js';
import { TypedEventBus } from '../../../events/TypedEventBus.js';

// ── Mocks ──

function createMockRuntime(): AgentRuntime {
  return {
    processMessage: vi.fn(),
    delegateTask: vi.fn(),
    spawnSubAgent: vi.fn(),
    isSessionActive: vi.fn(),
    cleanupSession: vi.fn(),
    activeSessionCount: 0,
    emit: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    listenerCount: vi.fn(),
    eventNames: vi.fn(),
    addListener: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
  } as unknown as AgentRuntime;
}

function makeAgent(id: string, name: string, role: AgentRole): Agent {
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
    allowedTools: [],
    enabledSkills: [],
    mcpServers: [],
    state: AgentState.Active,
    createdAt: new Date().toISOString(),
  });
}

function createPersisterMock() {
  return {
    persistEvent: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Helpers ──

function makeSSEEvent(overrides: Partial<SSEEvent> & { type: string }): SSEEvent {
  return overrides as unknown as SSEEvent;
}

// ═══════════════════════════════════════════════════════════════════════
// subAgentAllowedTools
// ═══════════════════════════════════════════════════════════════════════

describe('subAgentAllowedTools', () => {
  const runtime = createMockRuntime();

  it('returns read-only tools for Explore type', () => {
    const tools = subAgentAllowedTools(runtime, 'Explore');
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('WebSearch');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('Bash');
  });

  it('returns planning tools for Plan type', () => {
    const tools = subAgentAllowedTools(runtime, 'Plan');
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('EnterPlanMode');
    expect(tools).toContain('TodoWrite');
    expect(tools).not.toContain('Bash');
  });

  it('returns broad tools for general-purpose type', () => {
    const tools = subAgentAllowedTools(runtime, 'general-purpose');
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Bash');
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('WebSearch');
  });

  it('returns conservative defaults for unknown type', () => {
    const tools = subAgentAllowedTools(runtime, 'unknown' as any);
    expect(tools).toEqual(['Read', 'Glob', 'Grep']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// bubbleEventToParent
// ═══════════════════════════════════════════════════════════════════════

describe('bubbleEventToParent', () => {
  const runtime = createMockRuntime();

  it('emits delegation:progress for bubbled event types', () => {
    const emitted: any[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string, data: any) => {
      if (type === 'delegation:progress') emitted.push(data);
    }) as any;

    bubbleEventToParent(runtime, 'parent-1', 'sub-1', 'agent-1', {
      type: SSEEventType.Text,
      content: 'Hello from sub-agent',
    });

    TypedEventBus.emit = origEmit;

    expect(emitted).toHaveLength(1);
    expect(emitted[0].parentSessionId).toBe('parent-1');
    expect(emitted[0].subSessionId).toBe('sub-1');
    expect(emitted[0].subAgentId).toBe('agent-1');
    expect(emitted[0].content).toBe('Hello from sub-agent');
  });

  it('does NOT bubble non-bubble event types (e.g. done, status)', () => {
    const emitted: any[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string, data: any) => {
      if (type === 'delegation:progress') emitted.push(data);
    }) as any;

    bubbleEventToParent(runtime, 'parent-1', 'sub-1', 'agent-1', {
      type: SSEEventType.Done,
      tokenUsage: { total: 100 } as any,
    });

    TypedEventBus.emit = origEmit;
    expect(emitted).toHaveLength(0);
  });

  it('truncates content to 500 chars', () => {
    const longContent = 'x'.repeat(1000);
    const emitted: any[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string, data: any) => {
      if (type === 'delegation:progress') emitted.push(data);
    }) as any;

    bubbleEventToParent(runtime, 'parent-1', 'sub-1', 'agent-1', {
      type: SSEEventType.Text,
      content: longContent,
    });

    TypedEventBus.emit = origEmit;
    expect(emitted[0].content.length).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// emitDelegationStatus
// ═══════════════════════════════════════════════════════════════════════

describe('emitDelegationStatus', () => {
  const runtime = createMockRuntime();

  it('emits delegation:started event', () => {
    const events: string[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string) => { events.push(type); return true; }) as any;

    emitDelegationStatus(runtime, 'parent-1', 'sub-1', 'agent-1', {
      phase: 'started',
      taskSummary: 'Do something',
    });

    TypedEventBus.emit = origEmit;
    expect(events).toContain('delegation:started');
  });

  it('emits delegation:working event with turnCount and elapsedMs', () => {
    const payloads: any[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string, data: any) => {
      if (type === 'delegation:working') payloads.push(data);
      return true;
    }) as any;

    emitDelegationStatus(runtime, 'parent-1', 'sub-1', 'agent-1', {
      phase: 'working',
      taskSummary: 'Working...',
      turnCount: 5,
      currentTool: 'Read',
      elapsedMs: 15000,
    });

    TypedEventBus.emit = origEmit;
    expect(payloads).toHaveLength(1);
    expect(payloads[0].parentSessionId).toBe('parent-1');
    expect(payloads[0].turnCount).toBe(5);
    expect(payloads[0].currentTool).toBe('Read');
    expect(payloads[0].elapsedMs).toBe(15000);
  });

  it('emits delegation:completed event', () => {
    const events: string[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string) => { events.push(type); return true; }) as any;

    emitDelegationStatus(runtime, 'parent-1', 'sub-1', 'agent-1', {
      phase: 'completed',
      taskSummary: 'Done',
    });

    TypedEventBus.emit = origEmit;
    expect(events).toContain('delegation:completed');
  });

  it('emits delegation:error event', () => {
    const events: string[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string) => { events.push(type); return true; }) as any;

    emitDelegationStatus(runtime, 'parent-1', 'sub-1', 'agent-1', {
      phase: 'error',
      taskSummary: 'Failed',
    });

    TypedEventBus.emit = origEmit;
    expect(events).toContain('delegation:error');
  });

  it('passes base fields in all events', () => {
    const payloads: any[] = [];
    const origEmit = TypedEventBus.emit.bind(TypedEventBus);
    TypedEventBus.emit = ((type: string, data: any) => {
      payloads.push({ type, data });
      return true;
    }) as any;

    emitDelegationStatus(runtime, 'parent-1', 'sub-1', 'agent-1', {
      phase: 'started',
      taskSummary: 'Test task',
    });

    TypedEventBus.emit = origEmit;
    expect(payloads[0].data.parentSessionId).toBe('parent-1');
    expect(payloads[0].data.subSessionId).toBe('sub-1');
    expect(payloads[0].data.subAgentId).toBe('agent-1');
    expect(payloads[0].data.taskSummary).toBe('Test task');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// handleSubAgentOutput
// ═══════════════════════════════════════════════════════════════════════

describe('handleSubAgentOutput', () => {
  const runtime = createMockRuntime();

  it('accumulates text content into state.fullContent', async () => {
    async function* stream(): AsyncGenerator<SSEEvent> {
      yield { type: SSEEventType.Text, content: 'Hello ' };
      yield { type: SSEEventType.Text, content: 'world!' };
    }

    const state: DelegationState = { fullContent: '', thinking: '', turnCount: 0, currentTool: undefined };
    const persister = createPersisterMock();

    await handleSubAgentOutput(runtime, stream(), 'parent-1', 'sub-1', 'agent-1', 'task', Date.now(), persister, state);

    expect(state.fullContent).toBe('Hello world!');
  });

  it('accumulates think content into state.thinking', async () => {
    async function* stream(): AsyncGenerator<SSEEvent> {
      yield { type: SSEEventType.Think, content: 'Thinking step 1...' };
      yield { type: SSEEventType.Think, content: 'Thinking step 2...' };
    }

    const state: DelegationState = { fullContent: '', thinking: '', turnCount: 0, currentTool: undefined };
    const persister = createPersisterMock();

    await handleSubAgentOutput(runtime, stream(), 'parent-1', 'sub-1', 'agent-1', 'task', Date.now(), persister, state);

    expect(state.thinking).toBe('Thinking step 1...Thinking step 2...');
  });

  it('increments turnCount and sets currentTool on tool_call events', async () => {
    async function* stream(): AsyncGenerator<SSEEvent> {
      yield { type: SSEEventType.ToolCall, toolName: 'Read', toolCallId: 'tc-1' } as any;
      yield { type: SSEEventType.ToolCall, toolName: 'Write', toolCallId: 'tc-2' } as any;
    }

    const state: DelegationState = { fullContent: '', thinking: '', turnCount: 0, currentTool: undefined };
    const persister = createPersisterMock();

    await handleSubAgentOutput(runtime, stream(), 'parent-1', 'sub-1', 'agent-1', 'task', Date.now(), persister, state);

    expect(state.turnCount).toBe(2);
    expect(state.currentTool).toBe('Write');
  });

  it('clears currentTool on tool_result', async () => {
    async function* stream(): AsyncGenerator<SSEEvent> {
      yield { type: SSEEventType.ToolCall, toolName: 'Read', toolCallId: 'tc-1' } as any;
      yield { type: SSEEventType.ToolResult, toolCallId: 'tc-1', toolName: 'Read', result: 'done', success: true } as any;
    }

    const state: DelegationState = { fullContent: '', thinking: '', turnCount: 0, currentTool: 'Read' };
    const persister = createPersisterMock();

    await handleSubAgentOutput(runtime, stream(), 'parent-1', 'sub-1', 'agent-1', 'task', Date.now(), persister, state);

    expect(state.turnCount).toBe(1);
    expect(state.currentTool).toBeUndefined();
  });

  it('calls persister.persistEvent for each relevant event type', async () => {
    async function* stream(): AsyncGenerator<SSEEvent> {
      yield { type: SSEEventType.Text, content: 'Hello' };
      yield { type: SSEEventType.Think, content: 'Hmm' };
      yield { type: SSEEventType.ToolCall, toolName: 'Read', toolCallId: 'tc-1' } as any;
      yield { type: SSEEventType.ToolResult, toolCallId: 'tc-1', toolName: 'Read', result: 'output', success: true } as any;
    }

    const state: DelegationState = { fullContent: '', thinking: '', turnCount: 0, currentTool: undefined };
    const persister = createPersisterMock();

    await handleSubAgentOutput(runtime, stream(), 'parent-1', 'sub-1', 'agent-1', 'task', Date.now(), persister, state);

    expect(persister.persistEvent).toHaveBeenCalledTimes(4);
    expect(persister.persistEvent).toHaveBeenCalledWith('text', { content: 'Hello' });
    expect(persister.persistEvent).toHaveBeenCalledWith('think', { content: 'Hmm' });
    expect(persister.persistEvent).toHaveBeenCalledWith('tool_call', expect.objectContaining({ name: 'Read', id: 'tc-1' }));
    expect(persister.persistEvent).toHaveBeenCalledWith('tool_result', expect.objectContaining({ toolCallId: 'tc-1', content: 'output' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// spawnSubAgent — permission checks
// ═══════════════════════════════════════════════════════════════════════

describe('spawnSubAgent — permission checks', () => {
  beforeEach(() => {
    AgentRegistry.resetInstance();
  });

  it('rejects SubAgent role from spawning SubAgent', async () => {
    const subAgent = makeAgent('sub-1', 'Sub1', AgentRole.SubAgent);
    const registry = AgentRegistry.getInstance();
    registry.registerAgent(subAgent);

    const result = await spawnSubAgent(createMockRuntime(), {
      description: 'test',
      prompt: 'do stuff',
      subagent_type: 'general-purpose',
    }, 'sub-1');

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Permission denied');
  });

  it('allows Member role to spawn SubAgent', async () => {
    const member = makeAgent('member-1', 'Member1', AgentRole.Member);
    const registry = AgentRegistry.getInstance();
    registry.registerAgent(member);

    // Mock processMessage to yield empty stream then clean up
    const runtime = createMockRuntime();
    async function* emptyStream(): AsyncGenerator<SSEEvent> {
      // No events — simulates an agent that immediately returns
    }
    runtime.processMessage = vi.fn().mockReturnValue(emptyStream());

    const result = await spawnSubAgent(runtime, {
      description: 'test',
      prompt: 'do stuff',
      subagent_type: 'general-purpose',
    }, 'member-1');

    // Should succeed since Member can spawn
    expect(result.success).toBe(true);
    expect(result.content).toBe('');
  });

  it('allows Manager role to spawn SubAgent', async () => {
    const manager = makeAgent('mgr-1', 'Manager1', AgentRole.Manager);
    AgentRegistry.getInstance().registerAgent(manager);

    const runtime = createMockRuntime();
    async function* emptyStream(): AsyncGenerator<SSEEvent> {}
    runtime.processMessage = vi.fn().mockReturnValue(emptyStream());

    const result = await spawnSubAgent(runtime, {
      description: 'test',
      prompt: 'do stuff',
      subagent_type: 'Explore',
    }, 'mgr-1');

    expect(result.success).toBe(true);
  });

  it('returns error when processMessage throws', async () => {
    const member = makeAgent('member-1', 'Member1', AgentRole.Member);
    AgentRegistry.getInstance().registerAgent(member);

    const runtime = createMockRuntime();
    runtime.processMessage = vi.fn().mockImplementation(async function* () {
      throw new Error('Something went terribly wrong');
    });

    const result = await spawnSubAgent(runtime, {
      description: 'test',
      prompt: 'do stuff',
      subagent_type: 'general-purpose',
    }, 'member-1');

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Something went terribly wrong');
  });

  it('creates temp Agent and unregisters it in finally block', async () => {
    const member = makeAgent('member-1', 'Member1', AgentRole.Member);
    const registry = AgentRegistry.getInstance();
    registry.registerAgent(member);

    const runtime = createMockRuntime();
    async function* emptyStream(): AsyncGenerator<SSEEvent> {}
    runtime.processMessage = vi.fn().mockReturnValue(emptyStream());

    const beforeCount = registry.size;

    await spawnSubAgent(runtime, {
      description: 'test',
      prompt: 'do stuff',
      subagent_type: 'general-purpose',
    }, 'member-1');

    // After spawn, the temp agent should be cleaned up
    expect(registry.size).toBe(beforeCount);
  });

  it('accumulates text content from processMessage stream', async () => {
    const member = makeAgent('member-1', 'Member1', AgentRole.Member);
    AgentRegistry.getInstance().registerAgent(member);

    const runtime = createMockRuntime();
    async function* textStream(): AsyncGenerator<SSEEvent> {
      yield { type: SSEEventType.Text, content: 'Line 1\n' };
      yield { type: SSEEventType.Text, content: 'Line 2\n' };
      yield { type: SSEEventType.Think, content: 'thinking...' };
    }
    runtime.processMessage = vi.fn().mockReturnValue(textStream());

    const result = await spawnSubAgent(runtime, {
      description: 'test',
      prompt: 'do stuff',
      subagent_type: 'general-purpose',
    }, 'member-1');

    expect(result.success).toBe(true);
    expect(result.content).toBe('Line 1\nLine 2\n');
  });
});
