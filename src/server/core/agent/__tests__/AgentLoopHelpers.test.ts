/**
 * AgentLoopHelpers tests — concurrency, edge cases, and inter-agent coupling
 *
 * Covers:
 *   - messageToApiMessage: AgentRegistry coupling, structural edge cases, type compatibility
 *   - estimateTokens: concurrency, edge cases
 *   - interruptibleSleep: AbortSignal behavior, timing accuracy
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  messageToApiMessage,
  estimateTokens,
  interruptibleSleep,
  selectHistoryForContext,
  truncateMessagesPreservingTask,
} from '../AgentLoopHelpers.js';
import type { ApiMessage } from '../AgentLoopHelpers.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { Agent } from '../Agent.js';
import type { AgentConfigWithKey } from '../AgentConfig.js';
import type { Message } from '../../../../shared/types/session.js';
import { AgentRole } from '../../../../shared/types/agent.js';

// Reset the AgentRegistry singleton before each test
beforeEach(() => {
  AgentRegistry.resetInstance();
});

// ── Helpers ────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AgentConfigWithKey> = {}): AgentConfigWithKey {
  return {
    id: overrides.id ?? 'agent-test-1',
    name: overrides.name ?? 'TestAgent',
    role: overrides.role ?? AgentRole.Member,
    parentAgentId: overrides.parentAgentId ?? null,
    level: overrides.level ?? 1,
    teamName: overrides.teamName ?? '',
    provider: overrides.provider ?? 'cloud_api',
    apiUrl: overrides.apiUrl ?? '',
    apiKey: overrides.apiKey ?? 'sk-test',
    model: overrides.model ?? '',
    contextWindow: overrides.contextWindow ?? 128000,
    maxTurns: overrides.maxTurns ?? 0,
    temperature: overrides.temperature ?? 0.7,
    agentPrompt: overrides.agentPrompt ?? '',
    preferredLanguage: overrides.preferredLanguage ?? 'en',
    conversationLanguage: overrides.conversationLanguage ?? 'en',
    allowedTools: overrides.allowedTools ?? [],
    enabledSkills: overrides.enabledSkills ?? [],
    mcpServers: overrides.mcpServers ?? [],
    state: overrides.state ?? undefined as any,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

function registerAgent(id: string, name: string): Agent {
  const agent = new Agent(makeConfig({ id, name }));
  AgentRegistry.getInstance().registerAgent(agent);
  return agent;
}

function makeMessage(overrides: Partial<Message> & { role: Message['role']; content: string | null }): Message {
  return {
    id: overrides.id ?? 'msg-1',
    sessionId: overrides.sessionId ?? 'session-1',
    role: overrides.role,
    content: overrides.content as string,
    toolCalls: overrides.toolCalls,
    toolResults: overrides.toolResults,
    thinking: overrides.thinking,
    tokenCount: overrides.tokenCount ?? 0,
    compressed: overrides.compressed ?? false,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    withdrawn: overrides.withdrawn,
    agentId: overrides.agentId,
    agentName: overrides.agentName,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// messageToApiMessage — AgentRegistry coupling tests
// ═══════════════════════════════════════════════════════════════════════

describe('messageToApiMessage — AgentRegistry coupling', () => {
  it('prefixes with [Name says] when AgentRegistry has the agent', () => {
    registerAgent('agent-bob', 'Bob');
    const msg = makeMessage({ role: 'user', content: 'Hello team', agentId: 'agent-bob' });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('[Bob says]: Hello team');
    expect(result.role).toBe('user');
  });

  it('prefixes with [agentId says] when AgentRegistry does NOT have the agent', () => {
    // AgentRegistry is empty (reset in beforeEach)
    const msg = makeMessage({ role: 'user', content: 'a task', agentId: 'agent-missing' });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('[agent-missing says]: a task');
  });

  it('prefix appears when agent is registered AFTER a prior miss', () => {
    const msg = makeMessage({ role: 'user', content: 'ping', agentId: 'agent-bob' });

    // First call: agent not registered yet — fallback
    const r1 = messageToApiMessage(msg);
    expect(r1.content).toBe('[agent-bob says]: ping');

    // Register the agent now
    registerAgent('agent-bob', 'Bob');

    // Second call: agent IS registered — uses name
    const r2 = messageToApiMessage(msg);
    expect(r2.content).toBe('[Bob says]: ping');
  });

  it('fallback is used when agent is unregistered between calls', () => {
    registerAgent('agent-bob', 'Bob');

    const msg = makeMessage({ role: 'user', content: 'hey', agentId: 'agent-bob' });

    // First call: agent is registered
    const r1 = messageToApiMessage(msg);
    expect(r1.content).toBe('[Bob says]: hey');

    // Unregister the agent
    AgentRegistry.getInstance().unregisterAgent('agent-bob');

    // Second call: agent no longer in registry — fallback
    const r2 = messageToApiMessage(msg);
    expect(r2.content).toBe('[agent-bob says]: hey');
  });

  it('does NOT add prefix for system messages even with agentId', () => {
    registerAgent('agent-bob', 'Bob');
    const msg = makeMessage({ role: 'system', content: 'System prompt here', agentId: 'agent-bob' });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('System prompt here');
  });

  it('does NOT add prefix for tool messages even with agentId', () => {
    registerAgent('agent-bob', 'Bob');
    const msg = makeMessage({ role: 'tool', content: 'Tool output', agentId: 'agent-bob' });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('Tool output');
  });

  it('prefix is dynamic — live registry lookup, no snapshotting', () => {
    // Proves the function does NOT cache the agent name at message creation time.
    // It queries the live AgentRegistry each call.
    const msg = makeMessage({ role: 'user', content: 'task', agentId: 'agent-bob' });

    // Register with name "Bob"
    registerAgent('agent-bob', 'Bob');
    expect(messageToApiMessage(msg).content).toBe('[Bob says]: task');

    // Unregister and re-register with a different name (simulating rename)
    AgentRegistry.getInstance().unregisterAgent('agent-bob');
    registerAgent('agent-bob', 'Robert');
    expect(messageToApiMessage(msg).content).toBe('[Robert says]: task');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// messageToApiMessage — structural edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('messageToApiMessage — structural edge cases', () => {
  it('converts null content to empty string', () => {
    const msg = makeMessage({ role: 'tool', content: null as any });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('');
    expect(result.role).toBe('tool');
  });

  it('converts undefined content to empty string', () => {
    const msg = makeMessage({ role: 'user', content: undefined as unknown as string });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('');
  });

  it('converts empty string content', () => {
    const msg = makeMessage({ role: 'user', content: '' });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('');
  });

  it('prefixes null content + agentId correctly', () => {
    registerAgent('agent-bob', 'Bob');
    const msg = makeMessage({ role: 'user', content: null as any, agentId: 'agent-bob' });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('[Bob says]: ');
  });

  it('converts 3 toolCalls in one message', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'Reading multiple files',
      toolCalls: [
        { id: 'call-1', toolName: 'read', params: { path: '/a.txt' } },
        { id: 'call-2', toolName: 'write', params: { path: '/b.txt', content: 'hi' } },
        { id: 'call-3', toolName: 'bash', params: { command: 'ls -la' } },
      ],
    });
    const result = messageToApiMessage(msg);

    expect(result.tool_calls).toHaveLength(3);
    expect(result.tool_calls![0].id).toBe('call-1');
    expect(result.tool_calls![0].function.name).toBe('read');
    expect(result.tool_calls![1].id).toBe('call-2');
    expect(result.tool_calls![1].function.name).toBe('write');
    expect(result.tool_calls![2].id).toBe('call-3');
    expect(result.tool_calls![2].function.name).toBe('bash');
  });

  it('converts toolCalls with nested object params', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'Complex params',
      toolCalls: [
        {
          id: 'call-1',
          toolName: 'write',
          params: {
            path: '/out.json',
            data: { users: [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }] },
            config: { encoding: 'utf-8', overwrite: true },
          },
        },
      ],
    });
    const result = messageToApiMessage(msg);

    expect(result.tool_calls).toHaveLength(1);
    const parsed = JSON.parse(result.tool_calls![0].function.arguments);
    expect(parsed.data.users).toHaveLength(2);
    expect(parsed.data.users[0].name).toBe('Alice');
    expect(parsed.config.overwrite).toBe(true);
  });

  it('converts toolCalls with array params', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'Array param',
      toolCalls: [
        {
          id: 'call-1',
          toolName: 'batch',
          params: { ids: ['a', 'b', 'c'], flags: [true, false, true] },
        },
      ],
    });
    const result = messageToApiMessage(msg);

    expect(result.tool_calls).toHaveLength(1);
    const parsed = JSON.parse(result.tool_calls![0].function.arguments);
    expect(parsed.ids).toEqual(['a', 'b', 'c']);
    expect(parsed.flags).toEqual([true, false, true]);
  });

  it('tool_calls each have type "function"', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'test',
      toolCalls: [
        { id: 'c1', toolName: 'grep', params: {} },
        { id: 'c2', toolName: 'glob', params: {} },
      ],
    });
    const result = messageToApiMessage(msg);
    for (const tc of result.tool_calls!) {
      expect(tc.type).toBe('function');
    }
  });

  it('omits tool_calls when toolCalls array is empty', () => {
    const msg = makeMessage({ role: 'assistant', content: 'thinking', toolCalls: [] });
    const result = messageToApiMessage(msg);
    // The helper checks length > 0, so an empty array should not produce tool_calls
    expect(result.tool_calls).toBeUndefined();
  });

  it('omits tool_calls when toolCalls is undefined', () => {
    const msg = makeMessage({ role: 'assistant', content: 'no tools' });
    const result = messageToApiMessage(msg);
    expect(result.tool_calls).toBeUndefined();
  });

  it('handles system role message', () => {
    const msg = makeMessage({ role: 'system', content: 'You are helpful' });
    const result = messageToApiMessage(msg);
    expect(result.role).toBe('system');
    expect(result.content).toBe('You are helpful');
  });

  it('assistant message with agentId does NOT get prefix', () => {
    registerAgent('agent-bob', 'Bob');
    const msg = makeMessage({ role: 'assistant', content: 'Done', agentId: 'agent-bob' });
    const result = messageToApiMessage(msg);
    expect(result.content).toBe('Done');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// messageToApiMessage — ApiMessage type compatibility
// ═══════════════════════════════════════════════════════════════════════

describe('messageToApiMessage — ApiMessage type compatibility', () => {
  it('produces shape expected by LLM API callers: role + content', () => {
    const msg = makeMessage({ role: 'user', content: 'Hello' });
    const result: ApiMessage = messageToApiMessage(msg);
    expect(result).toHaveProperty('role');
    expect(result).toHaveProperty('content');
    expect(typeof result.role).toBe('string');
    expect(typeof result.content).toBe('string');
  });

  it('role is one of the four valid API roles', () => {
    const roles = ['user', 'assistant', 'system', 'tool'] as const;
    for (const role of roles) {
      const msg = makeMessage({ role, content: 'test' });
      const result = messageToApiMessage(msg);
      expect(roles).toContain(result.role);
    }
  });

  it('tool_calls have the exact shape: id, type="function", function.name, function.arguments', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'call',
      toolCalls: [{ id: 'call-xyz', toolName: 'search', params: { q: 'test' } }],
    });
    const result = messageToApiMessage(msg);

    const tc = result.tool_calls![0];
    expect(tc).toHaveProperty('id');
    expect(tc).toHaveProperty('type');
    expect(tc).toHaveProperty('function');
    expect(tc.function).toHaveProperty('name');
    expect(tc.function).toHaveProperty('arguments');
    expect(tc.type).toBe('function');
    expect(typeof tc.id).toBe('string');
    expect(typeof tc.function.name).toBe('string');
    expect(typeof tc.function.arguments).toBe('string');
  });

  it('tool_call_id is NOT set on assistant messages (not a tool response)', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', toolName: 'foo', params: {} }],
    });
    const result = messageToApiMessage(msg);
    expect(result.tool_call_id).toBeUndefined();
  });

  it('content is always a string (never null in ApiMessage, even when input is null)', () => {
    const msg = makeMessage({ role: 'tool', content: null as any });
    const result = messageToApiMessage(msg);
    expect(typeof result.content).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// estimateTokens — concurrency & edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('estimateTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates text content (deterministic)', () => {
    const msgs: ApiMessage[] = [
      { role: 'user', content: 'Hello world' },
    ];
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it('multiple messages sum correctly', () => {
    const single: ApiMessage[] = [{ role: 'user', content: 'Hello world' }];
    const double: ApiMessage[] = [
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const singleTokens = estimateTokens(single);
    const doubleTokens = estimateTokens(double);
    // Sum of two messages should exceed one message
    expect(doubleTokens).toBeGreaterThan(singleTokens);
  });

  it('includes tool_calls in total', () => {
    const withTools: ApiMessage[] = [
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"/long/path/to/file.txt"}' },
          },
          {
            id: '2',
            type: 'function',
            function: { name: 'write', arguments: '{"content":"a large block of text here"}' },
          },
        ],
      },
    ];
    const noTools: ApiMessage[] = [{ role: 'assistant', content: 'ok' }];
    expect(estimateTokens(withTools)).toBeGreaterThan(estimateTokens(noTools));
  });

  it('handles null content as 0 tokens', () => {
    const msgs: ApiMessage[] = [{ role: 'tool', content: null }];
    expect(estimateTokens(msgs)).toBe(0);
  });

  it('handles empty string content', () => {
    const msgs: ApiMessage[] = [{ role: 'user', content: '' }];
    expect(estimateTokens(msgs)).toBe(0);
  });

  it('concurrent calls with different messages all return correct values', async () => {
    const makeMsgs = (i: number): ApiMessage[] => [
      { role: 'user', content: `Message number ${i} with some additional text to vary length` },
    ];

    const promises = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
      Promise.resolve(estimateTokens(makeMsgs(i)))
    );

    const results = await Promise.all(promises);

    // estimateTokens is deterministic — same input = same output
    const single = estimateTokens(makeMsgs(0));
    expect(results[0]).toBe(single);

    // All results should be positive integers (content length varies but all > 0)
    for (const r of results) {
      expect(r).toBeGreaterThan(0);
      expect(Number.isInteger(r)).toBe(true);
    }
  });

  it('highly concurrent calls do not interfere', async () => {
    // 100 parallel calls, each with different data. estimateTokens is a pure
    // function with no shared mutable state — they must all return correctly.
    const promises = Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(
        estimateTokens([
          { role: 'user', content: `concurrent call ${i}` },
        ])
      )
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(100);

    // All results are non-negative integers
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r)).toBe(true);
    }
  });

  it('mixed role messages sum tokens from all', () => {
    const msgs: ApiMessage[] = [
      { role: 'system', content: 'System prompt with many words to count' },
      { role: 'user', content: 'User question here' },
      { role: 'assistant', content: 'Assistant response with tool calls', tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{"path":"/x"}' } }] },
      { role: 'tool', content: 'Tool output text' },
    ];
    const tokens = estimateTokens(msgs);
    expect(tokens).toBeGreaterThan(20); // reasonable floor for this content
    expect(Number.isInteger(tokens)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('selectHistoryForContext', () => {
  it('excludes the current user message to avoid duplicating the active turn', () => {
    const current = makeMessage({ id: 'current', role: 'user', content: 'Continue the active goal.' });
    const history = [
      makeMessage({ id: 'old', role: 'user', content: 'Original task' }),
      current,
      makeMessage({ id: 'assistant', role: 'assistant', content: 'Working on it.' }),
    ];

    const selected = selectHistoryForContext(history, {
      contextWindow: 8000,
      reservedTokens: 1000,
      excludeMessageIds: ['current'],
    });

    expect(selected.map(m => m.id)).not.toContain('current');
    expect(selected.map(m => m.id)).toContain('assistant');
  });

  it('preserves compacted summaries while filling the rest from recent history', () => {
    const summary = makeMessage({
      id: 'summary',
      role: 'system',
      content: 'Compacted milestone summary: architecture decision and remaining work.',
      compressed: true,
    });
    const history = [
      summary,
      ...Array.from({ length: 12 }, (_, i) => makeMessage({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Recent work item ${i}: ${'detail '.repeat(220)}`,
      })),
    ];

    const selected = selectHistoryForContext(history, {
      contextWindow: 3000,
      reservedTokens: 1200,
    });

    expect(selected.map(m => m.id)).toContain('summary');
    expect(selected.at(-1)?.id).toBe('msg-11');
    expect(selected.length).toBeLessThan(history.length);
  });

  it('allows larger context windows to retain more history than smaller windows', () => {
    const history = Array.from({ length: 30 }, (_, i) => makeMessage({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: ${'context '.repeat(40)}`,
    }));

    const small = selectHistoryForContext(history, {
      contextWindow: 2200,
      reservedTokens: 800,
    });
    const large = selectHistoryForContext(history, {
      contextWindow: 20000,
      reservedTokens: 800,
    });

    expect(large.length).toBeGreaterThan(small.length);
    expect(large.length).toBeLessThanOrEqual(history.length);
  });
});

describe('truncateMessagesPreservingTask', () => {
  it('keeps the original user task when reducing context after empty responses', () => {
    const messages: ApiMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Please keep developing the 2D RPG game.' },
      { role: 'assistant', content: 'I will build version 2.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'no html files' },
      { role: 'assistant', content: 'Writing a large file.' },
      { role: 'system', content: '[Recovery: empty response]' },
    ];

    const result = truncateMessagesPreservingTask(messages, 3);

    expect(result).toBe(messages);
    expect(messages[0].role).toBe('system');
    expect(messages.some((msg) => msg.content === 'Please keep developing the 2D RPG game.')).toBe(true);
    expect(messages.at(-1)?.content).toBe('[Recovery: empty response]');
  });

  it('does not duplicate the original user task when it is already in the tail', () => {
    const task: ApiMessage = { role: 'user', content: 'Continue the game.' };
    const messages: ApiMessage[] = [
      { role: 'system', content: 'system prompt' },
      task,
      { role: 'assistant', content: 'Working.' },
    ];

    truncateMessagesPreservingTask(messages, 3);

    expect(messages.filter((msg) => msg === task)).toHaveLength(1);
  });

  it('skips task notifications when selecting the preserved user task', () => {
    const messages: ApiMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '<task-notification>\nfailed\n</task-notification>' },
      { role: 'user', content: 'Build the requested game upgrade.' },
      { role: 'assistant', content: 'Checking files.' },
      { role: 'tool', content: 'no html files' },
    ];

    truncateMessagesPreservingTask(messages, 2);

    expect(messages.some((msg) => msg.content === 'Build the requested game upgrade.')).toBe(true);
  });
});

// interruptibleSleep — AbortSignal behavior
// ═══════════════════════════════════════════════════════════════════════

describe('interruptibleSleep', () => {
  it('sleeps the full duration when no signal is provided', async () => {
    const start = Date.now();
    await interruptibleSleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // allow small timing variance
  });

  it('returns immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(); // abort before sleep

    const start = Date.now();
    await interruptibleSleep(5000, controller.signal);
    const elapsed = Date.now() - start;

    // Should return near-instantly, certainly not the full 5000ms
    expect(elapsed).toBeLessThan(50);
  });

  it('returns early when signal is aborted mid-sleep', async () => {
    const controller = new AbortController();

    const start = Date.now();
    const sleepPromise = interruptibleSleep(5000, controller.signal);

    // Abort after 50ms — well before the 5000ms sleep finishes
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    await sleepPromise;
    const elapsed = Date.now() - start;

    // Should return around 50ms, not the full 5000ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(300);
  });

  it('very short sleep (< 100ms) completes with accurate timing', async () => {
    const start = Date.now();
    await interruptibleSleep(10);
    const elapsed = Date.now() - start;

    // For a 10ms sleep, we allow 5-30ms range (event loop variance)
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(50);
  });

  it('no signal — sleeps full even with long duration', async () => {
    const start = Date.now();
    await interruptibleSleep(60);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(55);
  });

  it('returns immediately when sleep duration is 0', async () => {
    const start = Date.now();
    await interruptibleSleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20);
  });

  it('aborted signal with 0ms sleep returns immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await interruptibleSleep(0, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20);
  });

  it('signal aborted before sleep does not cause errors', async () => {
    const controller = new AbortController();
    controller.abort();

    // Should resolve cleanly, not throw
    await expect(interruptibleSleep(100, controller.signal)).resolves.toBeUndefined();
  });

  it('mid-sleep abort does not throw', async () => {
    const controller = new AbortController();

    const sleepPromise = interruptibleSleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 30);

    // Should resolve cleanly
    await expect(sleepPromise).resolves.toBeUndefined();
  });

  it('does not reject when base sleep is 0 and signal is active', async () => {
    const controller = new AbortController();
    // Signal is not aborted — just a zero-duration sleep
    await expect(interruptibleSleep(0, controller.signal)).resolves.toBeUndefined();
  });
});
