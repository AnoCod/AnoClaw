import { describe, expect, it } from 'vitest';
import {
  ToolRecoveryPolicy,
  type ToolCallJournalEntry,
  type ToolCallJournalStatus,
} from '../ToolRecoveryPolicy.js';

describe('ToolRecoveryPolicy', () => {
  const policy = new ToolRecoveryPolicy();

  it.each([
    ['prepared', true, 'start'],
    ['started', true, 'replay_read'],
    ['started', false, 'recovery_required'],
    ['finished', false, 'commit_result'],
    ['transcript_committed', false, 'none'],
  ] as const)(
    'maps %s readOnly=%s to %s',
    (status, readOnly, action) => {
      expect(policy.classify(entry(status, readOnly))).toMatchObject({ action });
    },
  );
});

function entry(
  status: ToolCallJournalStatus,
  readOnly: boolean,
): ToolCallJournalEntry {
  return {
    toolCallId: 'tool-a',
    runId: 'run-a',
    taskId: 'task-a',
    sessionId: 'session-a',
    toolName: readOnly ? 'Read' : 'Edit',
    readOnly,
    status,
    preparedAt: '2026-07-25T00:00:00.000Z',
    ...(status !== 'prepared' ? { startedAt: '2026-07-25T00:00:01.000Z' } : {}),
    ...(
      status === 'finished' || status === 'transcript_committed'
        ? {
            finishedAt: '2026-07-25T00:00:02.000Z',
            resultRef: 'result-a',
          }
        : {}
    ),
    ...(
      status === 'transcript_committed'
        ? { transcriptCommittedAt: '2026-07-25T00:00:03.000Z' }
        : {}
    ),
  };
}
