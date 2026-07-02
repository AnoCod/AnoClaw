// Session domain class — wraps a SessionNode with behavior methods
// Part of the AnoClaw v2.0 rewrite: Session system (SA-4)

import type {
  SessionNode,
  SessionType,
  SessionStatus,
} from '../../../shared/types/session.js';
import type { Message } from '../../../shared/types/session.js';

export class Session {
  readonly id: string;
  private node: SessionNode;
  /** UUID of the last JSONL event written to this session (for uuid chain) */
  lastEventUuid: string | null = null;

  /** In-memory message cache — avoids repeated JSONL disk reads */
  private _cachedMessages: Message[] | null = null;

  constructor(node: SessionNode) {
    this.node = {
      ...node,
      subSessionIds: [...(node.subSessionIds || [])],
      metadata: { ...(node.metadata || {}) },
    };
    this.id = node.sessionId;
  }

  // ── Message cache ──

  get cachedMessages(): Message[] | null {
    return this._cachedMessages;
  }

  setCachedMessages(msgs: Message[]): void {
    this._cachedMessages = msgs;
  }

  clearMessageCache(): void {
    this._cachedMessages = null;
  }

  // ── Property accessors ──

  get sessionId(): string {
    return this.node.sessionId;
  }

  get parentSessionId(): string | null {
    return this.node.parentSessionId;
  }

  get level(): number {
    return this.node.level;
  }

  get agentId(): string {
    return this.node.agentId;
  }

  get type(): SessionType {
    return this.node.type;
  }

  get status(): SessionStatus {
    return this.node.status;
  }

  get title(): string {
    return this.node.title;
  }

  get workspace(): string {
    return this.node.workspace;
  }

  get createdAt(): string {
    return this.node.createdAt;
  }

  get lastActiveAt(): string {
    return this.node.lastActiveAt;
  }

  get subSessionIds(): string[] {
    return [...(this.node.subSessionIds || [])];
  }

  get metadata(): Record<string, unknown> {
    return { ...this.node.metadata };
  }

  // ── Predicates ──

  isMain(): boolean {
    return this.node.type === 'Main';
  }

  isSub(): boolean {
    return this.node.type === 'Sub';
  }

  isActive(): boolean {
    return this.node.status === 'Active';
  }

  isIdle(): boolean {
    return this.node.status === 'Idle';
  }

  isArchived(): boolean {
    return this.node.status === 'Archived';
  }

  hasParent(): boolean {
    return this.node.parentSessionId !== null && this.node.parentSessionId !== '';
  }

  isRoot(): boolean {
    return this.node.level === 0;
  }

  // ── Mutations ──

  /** Archive the session (status → Archived). No-op if already archived. */
  archive(): void {
    if (this.node.status === 'Archived') return;
    this.node.status = 'Archived' as SessionStatus;
    this.node.lastActiveAt = new Date().toISOString();
  }

  /** Set session to idle (Active → Idle) */
  setIdle(): void {
    if (this.node.status === 'Active') {
      this.node.status = 'Idle' as SessionStatus;
      this.node.lastActiveAt = new Date().toISOString();
    }
  }

  /** Mark session as active (Idle → Active, or refresh Active).
   *  Archived sessions cannot be reactivated — use SessionStore.unarchive() first. */
  setActive(): void {
    if (this.node.status === 'Archived') {
      return; // Archived sessions cannot be set active directly
    }
    this.node.status = 'Active' as SessionStatus;
    this.node.lastActiveAt = new Date().toISOString();
  }

  /** Update the session title */
  updateTitle(title: string): void {
    this.node.title = title;
    this.node.lastActiveAt = new Date().toISOString();
  }

  /** Update the workspace path */
  setWorkspace(workspace: string): void {
    this.node.workspace = workspace;
    this.node.lastActiveAt = new Date().toISOString();
  }

  /** Add a sub-session ID to the children list */
  addSubSession(subSessionId: string): void {
    if (!this.node.subSessionIds.includes(subSessionId)) {
      this.node.subSessionIds.push(subSessionId);
    }
    this.node.lastActiveAt = new Date().toISOString();
  }

  /** Remove a sub-session ID from the children list */
  removeSubSession(subSessionId: string): void {
    this.node.subSessionIds = this.node.subSessionIds.filter(
      (id) => id !== subSessionId,
    );
    this.node.lastActiveAt = new Date().toISOString();
  }

  /** Set arbitrary metadata key */
  setMetadata(key: string, value: unknown): void {
    this.node.metadata[key] = value;
  }

  /** Touch lastActiveAt to now */
  touch(): void {
    this.node.lastActiveAt = new Date().toISOString();
  }

  // ── Serialization ──

  /** Return a deep copy of the underlying SessionNode */
  toJSON(): SessionNode {
    return {
      sessionId: this.node.sessionId,
      parentSessionId: this.node.parentSessionId,
      level: this.node.level,
      agentId: this.node.agentId,
      type: this.node.type,
      status: this.node.status,
      title: this.node.title,
      workspace: this.node.workspace,
      createdAt: this.node.createdAt,
      lastActiveAt: this.node.lastActiveAt,
      subSessionIds: [...this.node.subSessionIds],
      metadata: { ...this.node.metadata },
    };
  }

  /** Get a reference to the internal node (use with caution — prefer toJSON for safety) */
  raw(): Readonly<SessionNode> {
    return this.node;
  }
}
