import type { Message } from '../types.js';
import type { ToolConfirmationSnapshot, ToolConfirmationSummary } from './ToolConfirmationQueue.js';

export type FloatingBallWaitingSource = 'tool-confirmation' | 'ask-user';

export interface FloatingBallWaitingItem {
  source: FloatingBallWaitingSource;
  toolCallId?: string;
  toolName?: string;
  displayName: string;
  riskLevel: string;
  sessionId?: string;
  detail?: string;
  canInlineResolve: boolean;
  timestamp?: number;
}

export interface FloatingBallWaitingSnapshot {
  count: number;
  first: FloatingBallWaitingItem | null;
}

export interface AskUserSessionMessages {
  sessionId: string;
  title?: string;
  lastActiveAt?: string;
  messages: readonly Message[];
}

export function combineFloatingBallWaiting(
  toolSnapshot: ToolConfirmationSnapshot,
  askUserSnapshot: FloatingBallWaitingSnapshot,
): FloatingBallWaitingSnapshot {
  const toolFirst = toolSnapshot.first ? toolWaitingItem(toolSnapshot.first) : null;
  return {
    count: toolSnapshot.count + askUserSnapshot.count,
    first: toolFirst || askUserSnapshot.first,
  };
}

export function summarizeAskUserWaiting(sessions: AskUserSessionMessages[]): FloatingBallWaitingSnapshot {
  const items = sessions
    .flatMap((session) => pendingAskUserMessages(session.messages).map((message) => askUserWaitingItem(session, message)))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));

  return {
    count: items.length,
    first: items[0] || null,
  };
}

export function pendingAskUserMessages(messages: readonly Message[]): Message[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'message' && message.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  return messages
    .slice(lastUserIndex + 1)
    .filter((message) => {
      if (message.type !== 'tool_call' || message.toolName !== 'AskUserQuestion') return false;
      const questions = normalizeQuestions(message.toolInput);
      return questions.length > 0;
    });
}

function toolWaitingItem(summary: ToolConfirmationSummary): FloatingBallWaitingItem {
  return {
    source: 'tool-confirmation',
    toolCallId: summary.toolCallId,
    toolName: summary.toolName,
    displayName: summary.displayName || summary.toolName || 'Tool',
    riskLevel: summary.riskLevel,
    sessionId: summary.sessionId,
    detail: summary.detail,
    canInlineResolve: summary.canInlineResolve === true,
  };
}

function askUserWaitingItem(session: AskUserSessionMessages, message: Message): FloatingBallWaitingItem {
  const questions = normalizeQuestions(message.toolInput);
  const firstQuestion = questions[0] || '';
  const extraCount = Math.max(0, questions.length - 1);
  const detail = extraCount > 0 ? `${firstQuestion} +${extraCount} more` : firstQuestion;
  return {
    source: 'ask-user',
    toolCallId: message.toolId || message.id,
    toolName: 'AskUserQuestion',
    displayName: 'Question',
    riskLevel: 'AskUser',
    sessionId: session.sessionId,
    detail,
    canInlineResolve: false,
    timestamp: message.timestamp,
  };
}

function normalizeQuestions(input: Record<string, unknown> | undefined): string[] {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const question = (item as { question?: unknown }).question;
      return typeof question === 'string' ? question.replace(/\s+/g, ' ').trim() : '';
    })
    .filter(Boolean);
}
