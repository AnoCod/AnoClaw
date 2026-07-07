import { describe, expect, it } from 'vitest';
import { MessageRole, type JsonlEvent, type Message } from '../../types/session.js';
import { jsonlEventsToMessages, messageToJsonlEvents } from '../jsonl-converters.js';

describe('jsonl converters', () => {
  it('preserves system messages for AgentMessage-style session records', () => {
    const message: Message = {
      id: 'agent-msg-1',
      sessionId: 'session-child',
      role: MessageRole.System,
      content: '[Message from Manager]: please check status',
      tokenCount: 0,
      compressed: false,
      timestamp: '2026-07-04T00:00:00.000Z',
      agentId: 'manager-1',
      agentName: 'Manager',
    };

    const events = messageToJsonlEvents(message, '00000000-0000-0000-0000-000000000000');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');

    const restored = jsonlEventsToMessages(events);
    expect(restored).toHaveLength(1);
    expect(restored[0].role).toBe('system');
    expect(restored[0].content).toBe(message.content);
    expect(restored[0].agentId).toBe(message.agentId);

    const flat = jsonlEventsToMessages(events, true);
    expect(flat).toHaveLength(1);
    expect(flat[0].role).toBe('system');
    expect(flat[0].content).toBe(message.content);
  });

  it('restores multiple flat tool calls with their matching results', () => {
    const events = [
      {
        type: 'assistant',
        uuid: 'ev-tool-a',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:00.000Z',
        message: {
          id: 'turn-1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-a', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      },
      {
        type: 'user',
        uuid: 'ev-result-a',
        parentUuid: 'ev-tool-a',
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'alpha', is_error: false }],
        },
      },
      {
        type: 'assistant',
        uuid: 'ev-tool-b',
        parentUuid: 'ev-result-a',
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:02.000Z',
        message: {
          id: 'turn-1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-b', name: 'Grep', input: { pattern: 'x' } }],
        },
      },
      {
        type: 'user',
        uuid: 'ev-result-b',
        parentUuid: 'ev-tool-b',
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-b', content: 'beta', is_error: true }],
        },
      },
    ] satisfies JsonlEvent[];

    const flat = jsonlEventsToMessages(events, true);
    const toolMessages = flat.filter(m => m.toolCalls?.length);

    expect(toolMessages).toHaveLength(2);
    expect((toolMessages[0].toolCalls![0] as any).result.content).toBe('alpha');
    expect((toolMessages[0].toolCalls![0] as any).result.success).toBe(true);
    expect((toolMessages[1].toolCalls![0] as any).result.content).toBe('beta');
    expect((toolMessages[1].toolCalls![0] as any).result.success).toBe(false);
  });

  it('attaches legacy tool results to empty-id tool calls when possible', () => {
    const events = [
      {
        type: 'assistant',
        uuid: 'ev-tool-legacy',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:00.000Z',
        message: {
          id: 'turn-legacy',
          role: 'assistant',
          content: [{ type: 'tool_use', id: '', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      },
      {
        type: 'user',
        uuid: 'ev-result-legacy',
        parentUuid: 'ev-tool-legacy',
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-later', content: 'legacy output', is_error: false }],
        },
      },
    ] satisfies JsonlEvent[];

    const flat = jsonlEventsToMessages(events, true);
    const toolCall = flat.find(m => m.toolCalls?.length)?.toolCalls?.[0] as any;

    expect(toolCall?.result?.content).toBe('legacy output');
  });

  it('restores persisted display events for errors, plan mode, and compaction', () => {
    const events = [
      {
        type: 'error',
        uuid: 'ev-error',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:00.000Z',
        error: 'API key rejected',
        source: 'agent_loop',
      },
      {
        type: 'plan_enter',
        uuid: 'ev-plan-enter',
        parentUuid: 'ev-error',
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:01.000Z',
        title: 'Implementation Plan',
      },
      {
        type: 'plan_exit',
        uuid: 'ev-plan-exit',
        parentUuid: 'ev-plan-enter',
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:02.000Z',
      },
      {
        type: 'compaction',
        uuid: 'ev-compaction',
        parentUuid: 'ev-plan-exit',
        sessionId: 'session-1',
        timestamp: '2026-07-04T00:00:03.000Z',
        summary: 'Older turns summarized',
        prunedCount: 12,
      },
    ] satisfies JsonlEvent[];

    const flat = jsonlEventsToMessages(events, true) as any[];

    expect(flat.map(m => m.type)).toEqual(['error', 'plan_enter', 'plan_exit', 'status']);
    expect(flat[0].content).toBe('API key rejected');
    expect(flat[1].planTitle).toBe('Implementation Plan');
    expect(flat[3].content).toContain('Older turns summarized');
  });
});
