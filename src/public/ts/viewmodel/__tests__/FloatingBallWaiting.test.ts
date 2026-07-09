import { describe, expect, it } from 'vitest';
import {
  combineFloatingBallWaiting,
  pendingAskUserMessages,
  summarizeAskUserWaiting,
} from '../FloatingBallWaiting.js';
import type { Message } from '../../types.js';

function userMessage(id: string, timestamp: number): Message {
  return {
    id,
    type: 'message',
    role: 'user',
    content: 'answer',
    timestamp,
  };
}

function askUserMessage(id: string, timestamp: number, questions: string[]): Message {
  return {
    id,
    type: 'tool_call',
    toolName: 'AskUserQuestion',
    toolId: `tool-${id}`,
    toolInput: {
      questions: questions.map((question, index) => ({
        header: `Q${index + 1}`,
        question,
      })),
    },
    content: '',
    status: 'pending',
    timestamp,
  };
}

describe('FloatingBallWaiting', () => {
  it('treats AskUserQuestion after the latest user message as pending', () => {
    const pending = pendingAskUserMessages([
      userMessage('u1', 1),
      askUserMessage('ask1', 2, ['Which path should I use?']),
    ]);

    expect(pending.map((message) => message.id)).toEqual(['ask1']);
  });

  it('does not keep AskUserQuestion pending after a later user message', () => {
    const pending = pendingAskUserMessages([
      userMessage('u1', 1),
      askUserMessage('ask1', 2, ['Which path should I use?']),
      userMessage('u2', 3),
    ]);

    expect(pending).toEqual([]);
  });

  it('summarizes AskUser waiting items for FloatingBall', () => {
    const snapshot = summarizeAskUserWaiting([
      {
        sessionId: 'session-a',
        title: 'Planning',
        messages: [
          userMessage('u1', 1),
          askUserMessage('ask1', 2, ['Which path should I use?', 'Which checks matter?']),
        ],
      },
    ]);

    expect(snapshot.count).toBe(1);
    expect(snapshot.first).toMatchObject({
      source: 'ask-user',
      sessionId: 'session-a',
      displayName: 'Question',
      riskLevel: 'AskUser',
      detail: 'Which path should I use? +1 more',
      canInlineResolve: false,
    });
  });

  it('keeps tool confirmations ahead of AskUser items in the shared inbox', () => {
    const snapshot = combineFloatingBallWaiting(
      {
        count: 1,
        first: {
          toolCallId: 'tc-edit',
          toolName: 'Edit',
          displayName: 'Edit',
          riskLevel: 'Low',
          sessionId: 'session-tool',
          detail: 'file_path: "a.ts"',
          canInlineResolve: true,
        },
      },
      {
        count: 1,
        first: {
          source: 'ask-user',
          displayName: 'Question',
          riskLevel: 'AskUser',
          sessionId: 'session-ask',
          detail: 'Choose a path',
          canInlineResolve: false,
        },
      },
    );

    expect(snapshot.count).toBe(2);
    expect(snapshot.first).toMatchObject({
      source: 'tool-confirmation',
      toolCallId: 'tc-edit',
      sessionId: 'session-tool',
      canInlineResolve: true,
    });
  });
});
