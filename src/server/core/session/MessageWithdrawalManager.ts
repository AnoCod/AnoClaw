// MessageWithdrawalManager — preview and execute message withdrawal with file rewinding.
//
// When a user withdraws a message containing destructive tool calls (Edit, Write, etc.),
// this manager coordinates with FileHistoryTracker to rewind file changes and marks
// the message as withdrawn in the session transcript.

import { getFileHistoryTracker, clearFileHistoryTracker } from './FileHistoryTracker.js';
import { SessionManager } from './SessionManager.js';
import { SessionStore } from './SessionStore.js';
import { createLogger } from '../logger.js';
import type { Message } from '../../../shared/types/session.js';
import { MessageRole } from '../../../shared/types/session.js';
import type { JsonlEvent } from '../../../shared/types/session.js';

// ── Types ──

export interface WithdrawalPreview {
  /** The message that would be withdrawn */
  message: Message;
  /** Tool calls embedded in this message (if assistant message) */
  toolCalls: Array<{ name: string; id: string; irreversible: boolean }>;
  /** Files that would be rewound to prior state */
  affectedFiles: string[];
  /** Whether the withdrawal is safe (no irreversible tool calls) */
  safe: boolean;
  /** Warning message if unsafe */
  warning?: string;
}

export interface WithdrawalResult {
  success: boolean;
  rewoundFiles: string[];
  error?: string;
}

// ── Irreversible tool list ──

const IRREVERSIBLE_TOOLS = new Set([
  'Bash',
  'SubAgentSpawn',
  'HireEmployee',
  'RestartServer',
  'ApiCall',
  'MemorySave',
]);

// ── Manager ──

export class MessageWithdrawalManager {
  private static _instance: MessageWithdrawalManager;

  static getInstance(): MessageWithdrawalManager {
    if (!MessageWithdrawalManager._instance) {
      MessageWithdrawalManager._instance = new MessageWithdrawalManager();
    }
    return MessageWithdrawalManager._instance;
  }

  private constructor() {}

  // ── Public API ──

  /**
   * Preview what would happen if a message is withdrawn.
   * Does NOT perform the withdrawal — safe to call in UI.
   */
  async previewWithdrawal(
    sessionId: string,
    messageId: string,
  ): Promise<WithdrawalPreview | null> {
    const mgr = SessionManager.getInstance();
    const messages = await mgr.getHistory(sessionId);
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;

    const message = messages[idx];
    const toolCalls = this._extractToolCalls(message);
    const affectedFiles = getFileHistoryTracker(sessionId).getTrackedFiles();

    const hasIrreversible = toolCalls.some((tc) => tc.irreversible);
    const safe = !hasIrreversible;

    let warning: string | undefined;
    if (hasIrreversible) {
      const names = toolCalls
        .filter((tc) => tc.irreversible)
        .map((tc) => tc.name)
        .join(', ');
      warning = `This message contains irreversible tool calls: ${names}. ` +
        'Withdrawing the message cannot undo their effects.';
    }

    return { message, toolCalls, affectedFiles, safe, warning };
  }

  /**
   * Withdraw a message and rewind file changes synchronously.
   * Also marks the message as withdrawn in the session transcript.
   */
  async withdrawMessage(
    sessionId: string,
    messageId: string,
  ): Promise<WithdrawalResult> {
    const preview = await this.previewWithdrawal(sessionId, messageId);
    if (!preview) return { success: false, rewoundFiles: [], error: 'Message not found' };

    const tracker = getFileHistoryTracker(sessionId);

    // Rewind file changes
    let rewoundFiles: string[] = [];
    if (tracker.hasAnyChanges()) {
      rewoundFiles = await tracker.rewindTo(sessionId, 0);
    }

    // Mark message as withdrawn in transcript
    await this._markWithdrawn(sessionId, messageId);

    createLogger('anochat.system').info('Message withdrawn', {
      sid: sessionId,
      mid: messageId,
      rewoundFiles: rewoundFiles.length,
    });

    return { success: true, rewoundFiles };
  }

  /**
   * Withdraw a message asynchronously (fire-and-forget for agent pipelines).
   * Returns immediately — the withdrawal happens in the background.
   */
  withdrawMessageAsync(sessionId: string, messageId: string): void {
    this.withdrawMessage(sessionId, messageId).catch((err) => {
      createLogger('anochat.system').error('Async message withdrawal failed', {
        sid: sessionId,
        mid: messageId,
        error: (err as Error).message,
      });
    });
  }

  /**
   * Check whether a specific tool call is irreversible (cannot be rewound).
   */
  isIrreversibleToolCall(toolName: string): boolean {
    return IRREVERSIBLE_TOOLS.has(toolName);
  }

  // ── Internal ──

  private _extractToolCalls(
    message: Message,
  ): Array<{ name: string; id: string; irreversible: boolean }> {
    if (message.role !== MessageRole.Assistant) return [];
    const raw = message as unknown as Record<string, unknown>;
    const toolCalls = (raw.tool_calls || raw.toolCalls) as
      | Array<{ function?: { name?: string }; name?: string; id?: string }>
      | undefined;
    if (!toolCalls) return [];

    return toolCalls.map((tc) => {
      const name = tc.function?.name ?? tc.name ?? 'unknown';
      return {
        name,
        id: tc.id || '',
        irreversible: this.isIrreversibleToolCall(name),
      };
    });
  }

  /**
   * Append a `message_withdrawn` event to the session transcript.
   * This is a soft withdrawal — the original message stays in JSONL
   * but consumers should treat it as nullified.
   */
  private async _markWithdrawn(sessionId: string, messageId: string): Promise<void> {
    const store = SessionStore.getInstance();
    const event: JsonlEvent = {
      type: 'message_withdrawn' as JsonlEvent['type'],
      uuid: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      parentUuid: null,
      sessionId,
      messageId,
      timestamp: new Date().toISOString(),
    } as JsonlEvent;
    await store.persistEvent(sessionId, event).catch(() => {});
  }
}
