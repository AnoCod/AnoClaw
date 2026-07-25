export type ToolCallJournalStatus =
  | 'prepared'
  | 'started'
  | 'finished'
  | 'transcript_committed';

export interface ToolCallJournalEntry {
  toolCallId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  toolName: string;
  readOnly: boolean;
  status: ToolCallJournalStatus;
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  transcriptCommittedAt?: string;
  resultRef?: string;
  processId?: number;
}
export type ToolRecoveryAction =
  | { action: 'start'; reason: string }
  | { action: 'replay_read'; reason: string }
  | { action: 'commit_result'; resultRef?: string; reason: string }
  | { action: 'none'; reason: string }
  | { action: 'recovery_required'; reason: string };

/**
 * Classifies interrupted tool calls without replaying non-idempotent writes.
 */
export class ToolRecoveryPolicy {
  classify(entry: ToolCallJournalEntry): ToolRecoveryAction {
    if (entry.status === 'prepared') {
      return {
        action: 'start',
        reason: 'The tool call was durable but never started.',
      };
    }
    if (entry.status === 'started') {
      if (entry.readOnly) {
        return {
          action: 'replay_read',
          reason: 'An interrupted read-only call is safe to replay.',
        };
      }
      return {
        action: 'recovery_required',
        reason: 'An interrupted write may already have produced side effects.',
      };
    }
    if (entry.status === 'finished') {
      return {
        action: 'commit_result',
        resultRef: entry.resultRef,
        reason: 'The tool finished; only its persisted result is missing from the transcript.',
      };
    }
    return {
      action: 'none',
      reason: 'The tool result is already committed to the Session transcript.',
    };
  }
}
