/**
 * SessionTagger — M4: session tagging with auto and user labels.
 *
 * Maintains an in-memory tag index plus a reverse map (tag → sessions)
 * for efficient tag-based session queries. Supports serialization via
 * toJSON() for persisting into SessionNode.metadata.
 *
 * Tags are categorized:
 *   - 'auto':  LLM-generated or algorithmically assigned (low confidence)
 *   - 'user':   Manually assigned by the user (overrides auto on conflict)
 */

import { createLogger } from '../../logger.js';

export interface SessionTag {
  label: string;
  category: 'auto' | 'user';
  confidence: number;  // 0.0 - 1.0, only relevant for 'auto'
  createdAt: string;   // ISO8601
}

interface TagEntry extends SessionTag {
  sessionId: string;
}

export class SessionTagger {
  private _tags: Map<string, Map<string, SessionTag>> = new Map(); // sessionId → label → tag
  private _reverse: Map<string, Set<string>> = new Map();          // label → sessionIds
  private _log = createLogger('anochat.evolution.tagger');

  // ── Mutations ──

  /**
   * Add a tag to a session.
   * - If a 'user' tag with the same label already exists, this is a no-op.
   * - If an 'auto' tag with the same label already exists and new is 'user',
   *   the category is promoted to 'user'.
   * - Duplicate (sessionId + label + category) calls are idempotent.
   */
  addTag(sessionId: string, label: string, category: 'auto' | 'user', confidence = 0.8): void {
    const labelLower = label.toLowerCase().trim();
    if (!labelLower) return;

    if (!this._tags.has(sessionId)) {
      this._tags.set(sessionId, new Map());
    }

    const sessionTags = this._tags.get(sessionId)!;
    const existing = sessionTags.get(labelLower);

    // User tag overrides auto tag
    if (existing && existing.category === 'user' && category === 'user') return;
    if (existing && existing.category === 'user' && category === 'auto') return;
    if (existing && existing.category === 'auto' && category === 'auto') return;

    const tag: SessionTag = {
      label: labelLower,
      category: category === 'user' ? 'user' : 'auto',
      confidence: category === 'user' ? 1.0 : Math.min(1, Math.max(0, confidence)),
      createdAt: new Date().toISOString(),
    };

    sessionTags.set(labelLower, tag);

    // Update reverse index
    if (!this._reverse.has(labelLower)) {
      this._reverse.set(labelLower, new Set());
    }
    this._reverse.get(labelLower)!.add(sessionId);

    this._log.debug('Tag added', { sessionId, label: labelLower, category });
  }

  /** Remove a tag from a session. Idempotent. */
  removeTag(sessionId: string, label: string): boolean {
    const labelLower = label.toLowerCase().trim();
    const sessionTags = this._tags.get(sessionId);
    if (!sessionTags) return false;

    const removed = sessionTags.delete(labelLower);
    if (removed) {
      // Clean reverse index
      const rev = this._reverse.get(labelLower);
      if (rev) {
        rev.delete(sessionId);
        if (rev.size === 0) this._reverse.delete(labelLower);
      }
      if (sessionTags.size === 0) this._tags.delete(sessionId);
      this._log.debug('Tag removed', { sessionId, label: labelLower });
    }
    return removed;
  }

  // ── Queries ──

  /** Get all tags for a session. Returns empty array if none. */
  getTags(sessionId: string): SessionTag[] {
    const sessionTags = this._tags.get(sessionId);
    if (!sessionTags) return [];
    return Array.from(sessionTags.values());
  }

  /** Get all session IDs that have a specific tag. */
  getSessionsByTag(label: string): string[] {
    const labelLower = label.toLowerCase().trim();
    const sessions = this._reverse.get(labelLower);
    return sessions ? Array.from(sessions) : [];
  }

  /** Check if a session has a specific tag. */
  hasTag(sessionId: string, label: string): boolean {
    const labelLower = label.toLowerCase().trim();
    return this._tags.get(sessionId)?.has(labelLower) ?? false;
  }

  /** Get all unique tags across all sessions. */
  getAllLabels(): string[] {
    return Array.from(this._reverse.keys());
  }

  /** Get total number of unique (session, label) pairs. */
  get totalTags(): number {
    let count = 0;
    for (const tags of this._tags.values()) count += tags.size;
    return count;
  }

  // ── Serialization ──

  /** Serialize tags for a session to JSON-safe format. */
  toJSON(sessionId: string): SessionTag[] {
    return this.getTags(sessionId);
  }

  /** Load tags from a previously serialized session metadata. */
  fromJSON(sessionId: string, tags: SessionTag[]): void {
    for (const tag of tags) {
      this.addTag(sessionId, tag.label, tag.category, tag.confidence);
    }
  }
}
