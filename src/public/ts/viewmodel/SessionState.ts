// SessionState — per-session streaming state container.
// Each session has exactly one SessionState, lazily created on first access.
// When the active session changes, only the pointer changes — no save/restore.
// WS events always land in the correct SessionState regardless of active status.

import { MessageListModel } from './MessageListModel.js';
import type { Message, TokenBreakdown } from '../types.js';

export class SessionState {
  readonly sessionId: string;
  messages: MessageListModel = new MessageListModel();
  isStreaming: boolean = false;
  currentStreamMessage: string = '';
  tokenBreakdown: TokenBreakdown | null = null;

  /** @internal */ streamMsgId: string | null = null;
  /** @internal */ thinkStartTime: number = 0;
  /** @internal */ currentThinkMsg: Message | null = null;
  /** @internal */ generationSeq: number = 0;

  /** Abort controller for in-flight loadHistory. Cancel old when new load arrives. */
  loadAbortController: AbortController | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
}
