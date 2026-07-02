/**
 * ISessionRepository — persistence interface for session data.
 *
 * SessionManager depends on this interface, not on concrete storage
 * (JsonlStore, SQLite, etc.). Implementations live in infra/storage/.
 *
 * @module ISessionRepository
 */

import type { Message, SessionMeta } from '../../../shared/types/session.js';

export interface ISessionRepository {
  /** Load full session data including messages. */
  load(sessionId: string): Promise<{ meta: SessionMeta; messages: Message[] } | null>;

  /** Save/update session metadata. */
  saveMeta(sessionId: string, meta: Partial<SessionMeta>): Promise<void>;

  /** Append a message to the session. */
  appendMessage(sessionId: string, message: Message): Promise<void>;

  /** Rewrite the entire message history (used after compaction). */
  rewriteMessages(sessionId: string, messages: Message[]): Promise<void>;

  /** List all session metadata summaries. */
  listSessions(): Promise<SessionMeta[]>;

  /** Delete a session and all its data. */
  deleteSession(sessionId: string): Promise<void>;
}
