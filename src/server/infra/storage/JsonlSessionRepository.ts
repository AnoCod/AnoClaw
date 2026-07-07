/**
 * JsonlSessionRepository — JSONL-backed implementation of ISessionRepository.
 *
 * Delegates all persistence operations to the existing SessionStore singleton.
 * This is the reference implementation; future backends (SQLite, remote, etc.)
 * can implement ISessionRepository independently.
 *
 * @module JsonlSessionRepository
 */

import type { Message, SessionMeta } from '../../../shared/types/session.js';
import { messageToJsonlEvents, jsonlEventsToMessages } from '../../../shared/serialization/jsonl-converters.js';
import type { ISessionRepository } from '../../core/session/ISessionRepository.js';
import { SessionStore } from '../../core/session/SessionStore.js';

/** Null UUID used as parentUuid when an event has no predecessor. */
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * JSONL-backed implementation of ISessionRepository.
 * Wraps the existing SessionStore singleton. All persistence ops delegate to it.
 */
export class JsonlSessionRepository implements ISessionRepository {
  private _store: SessionStore;

  constructor() {
    this._store = SessionStore.getInstance();
  }

  /** Load full session data: metadata + message history. */
  async load(sessionId: string): Promise<{ meta: SessionMeta; messages: Message[] } | null> {
    const meta = await this._store.readSessionMeta(sessionId);
    if (!meta) return null;

    const events = await this._store.loadHistory(sessionId);
    const messages = jsonlEventsToMessages(events as any[]);

    return { meta: meta as unknown as SessionMeta, messages };
  }

  /** Save/update session metadata. */
  async saveMeta(sessionId: string, meta: Partial<SessionMeta>): Promise<void> {
    // updateMeta handles partial updates; also works via full write
    await this._store.updateMeta(sessionId, meta);
  }

  /** Append a message to the session. */
  async appendMessage(sessionId: string, message: Message): Promise<void> {
    const events = messageToJsonlEvents(message, NULL_UUID);
    for (const ev of events) {
      await this._store.persistEvent(sessionId, ev);
    }
  }

  /** Rewrite the entire message history (after compaction). */
  async rewriteMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this._store.truncateSession(sessionId);
    for (const message of messages) {
      const events = messageToJsonlEvents(message, NULL_UUID);
      for (const ev of events) {
        await this._store.persistEvent(sessionId, ev);
      }
    }
  }

  /** List all session metadata summaries (via recovery scan). */
  async listSessions(): Promise<SessionMeta[]> {
    const sessions = await this._store.recoverSessions();
    return sessions.map((s) => s.toJSON() as unknown as SessionMeta);
  }

  /** Delete a session and all its data from disk. */
  async deleteSession(sessionId: string): Promise<void> {
    await this._store.deleteSession(sessionId);
  }
}
