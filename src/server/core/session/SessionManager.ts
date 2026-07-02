// SessionManager — singleton session lifecycle manager
// Manages Session instances in-memory, delegates persistence to SessionStore
// Part of the AnoClaw v2.0 rewrite: Session system (SA-4)

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Session } from './Session.js';
import { SessionStore } from './SessionStore.js';
import { TokenCounter } from '../context/TokenCounter.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { AgentRegistry } from '../agent/AgentRegistry.js';
import { PromptAssembler } from '../prompt/PromptAssembler.js';
import type {
  SessionNode,
  SessionType,
  SessionStatus,
  Message,
  TokenBreakdown,
  JsonlEvent,
} from '../../../shared/types/session.js';
import { messageToJsonlEvents, jsonlEventsToMessages, MessageRole } from '../../../shared/types/session.js';
import { createLogger } from '../logger.js';
import { TypedEventBus } from '../events/TypedEventBus.js';
import type { ILogger } from '../interfaces/ILogger.js';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Event types for typed listeners
// ---------------------------------------------------------------------------

export interface SessionManagerEvents {
  sessionCreated: (session: Session) => void;
  sessionArchived: (sessionId: string) => void;
  messageAppended: (sessionId: string, message: Message) => void;
  titleChanged: (sessionId: string, newTitle: string) => void;
  activeSessionChanged: (sessionId: string) => void;
  workspaceChanged: (sessionId: string, newPath: string) => void;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager extends EventEmitter {
  private static _instance: SessionManager;
  private _logger: ILogger | null = null;

  setLogger(logger: ILogger): void { this._logger = logger; }
  private get log(): ILogger { return this._logger || createLogger('anochat.system'); }

  private sessions: Map<string, Session> = new Map();
  private activeSessionId: string = '';
  /** Per-session sequential locks — prevent concurrent mutations on the same session */
  private _locks: Map<string, Promise<void>> = new Map();
  /** Per-session external message counter — incremented on appendMessage, read by AgentLoop for inter-turn injection */
  private _messageCounts: Map<string, number> = new Map();
  /** Per-session running mode (normal/infinite) — controls whether agent stays alive after response */
  private _runningModes: Map<string, string> = new Map();

  private constructor() {
    super();
  }

  /** Execute fn under a per-session sequential lock. Prevents race conditions
   *  between concurrent mutations (appendMessage vs setTitle, etc.) */
  private async _withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._locks.get(sessionId) || Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    this._locks.set(sessionId, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Persist in-memory session node to meta.json — keeps disk consistent with RAM.
   *  Called after every mutation that changes session state. */
  private async _syncMeta(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await SessionStore.getInstance().writeSessionMeta(sessionId, session.toJSON()).catch((err) => {
      const msg = (err as Error).message;
      this.log.warn('Failed to sync session meta', { sid: sessionId, error: msg });
    });
  }

  static getInstance(): SessionManager {
    if (!SessionManager._instance) {
      SessionManager._instance = new SessionManager();
    }
    return SessionManager._instance;
  }

  // -----------------------------------------------------------------------
  // Initialization (called once at startup)
  // -----------------------------------------------------------------------

  /**
   * Recover all Sessions from disk (called once at startup).
   * Scans the data/sessions/ directory, restores in-memory session map,
   * and sets the first non-archived main session as the active session.
   *
   * @param sessionsDir — absolute path to data/sessions/
   */
  async initialize(sessionsDir: string): Promise<void> {
    const store = SessionStore.getInstance();
    await store.initialize(sessionsDir);

    const recovered = await store.recoverSessions(sessionsDir);
    for (const session of recovered) {
      this.sessions.set(session.id, session);
    }

    // Set the first non-archived main session as active
    for (const session of recovered) {
      if (session.isMain() && !session.isArchived()) {
        this.activeSessionId = session.id;
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Creation
  // -----------------------------------------------------------------------

  /**
   * Create a new main session (level 0, User ↔ Agent).
   * Returns the Session instance.
   */
  async createMainSession(
    agentId: string,
    title: string = 'New Session',
    workspace: string = '',
  ): Promise<Session> {
    const sessionId = this.generateMainId();
    const now = new Date().toISOString();

    // Auto-initialize default workspace if not specified
    if (!workspace) {
      workspace = path.resolve(process.cwd(), 'workspace', sessionId);
      try {
        fs.mkdirSync(workspace, { recursive: true });
      } catch {
        // Non-critical: workspace auto-creation is best-effort
      }
    }

    const node: SessionNode = {
      sessionId,
      parentSessionId: null,
      level: 0,
      agentId,
      type: 'Main' as SessionType,
      status: 'Active' as SessionStatus,
      title,
      workspace,
      createdAt: now,
      lastActiveAt: now,
      subSessionIds: [],
      metadata: {},
    };

    const session = new Session(node);
    this.sessions.set(sessionId, session);

    const logger = this.log;
    logger.info('Main session created', { sid: sessionId, aid: agentId });
    const store = SessionStore.getInstance();
    await store.writeSessionMeta(sessionId, node);
    await store.persistEvent(sessionId, {
      type: 'session_created',
      uuid: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      parentUuid: null,
      sessionId,
      agentId,
      parentSessionId: null,
      timestamp: now,
    });

    this.emit('sessionCreated', session);
    TypedEventBus.emit('session:created', { sessionId, agentId });
    return session;
  }

  /**
   * Create a sub-session (level 1 or 2, Agent ↔ Agent).
   * Sub-session ID follows the pattern: "{parentSessionId}-{agentId}"
   */
  async createSubSession(
    parentSessionId: string,
    agentId: string,
    title?: string,
  ): Promise<Session> {
    const parent = this.sessions.get(parentSessionId);
    if (!parent) {
      throw new Error(`Parent session '${parentSessionId}' not found`);
    }

    // Generate sub-session ID
    const sessionId = `${parentSessionId}-${agentId}`;

    // Check for duplicates — only one active sub-session per agent per parent
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.isArchived()) {
      // Sync workspace in case parent was rebound after sub-session creation
      if (existing.workspace !== parent.workspace) {
        existing.setWorkspace(parent.workspace);
        this.log.debug('Sub-session workspace synced from parent', { sid: sessionId, workspace: parent.workspace });
      }
      return existing;
    }

    const now = new Date().toISOString();
    const node: SessionNode = {
      sessionId,
      parentSessionId,
      level: parent.level + 1,
      agentId,
      type: 'Sub' as SessionType,
      status: 'Active' as SessionStatus,
      title: title ?? `Sub-session with ${agentId}`,
      workspace: parent.workspace, // Inherit parent workspace
      createdAt: now,
      lastActiveAt: now,
      subSessionIds: [],
      metadata: {},
    };

    const session = new Session(node);
    this.sessions.set(sessionId, session);

    const logger = this.log;
    logger.info('Sub-session created', { sid: sessionId, parentSid: parentSessionId, aid: agentId });
    parent.addSubSession(sessionId);
    // ── Sync parent meta to disk so subSessionIds survives restart ──
    await this._syncMeta(parentSessionId);

    // ── Notify parent session: inject a system message so the parent agent knows a child was spawned ──
    const agentName = AgentRegistry.getInstance().agent(agentId)?.name || agentId;
    this.appendMessage(parentSessionId, {
      id: `sub-created-${sessionId}`,
      sessionId: parentSessionId,
      role: MessageRole.System,
      content: `[Sub-session created] Agent "${agentName}" (${agentId}) assigned: ${title || 'task'}. Sub-session ID: ${sessionId}`,
      tokenCount: 0, compressed: false,
      timestamp: now,
    }).catch(() => { /* non-critical */ });

    // Persist
    const store = SessionStore.getInstance();
    await store.writeSessionMeta(sessionId, node);
    const evUuid = `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await store.persistEvent(sessionId, {
      type: 'session_created',
      uuid: evUuid,
      parentUuid: null,
      sessionId,
      agentId,
      parentSessionId,
      timestamp: now,
    });
    await store.persistEvent(parentSessionId, {
      type: 'subsession_created',
      uuid: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      parentUuid: evUuid,
      sessionId: parentSessionId,
      subSessionId: sessionId,
      agentId,
      timestamp: now,
    });

    this.emit('sessionCreated', session);
    TypedEventBus.emit('session:created', { sessionId, agentId });
    return session;
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  /**
   * Get a Session instance by ID.
   *
   * @param sessionId — session ID
   * @returns Session instance, or undefined if not found
   */
  session(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Set a metadata key on a session. Generic extension point — plugins
   * inject metadata for sub-session coordination, auto-execute, etc.
   */
  setMetadata(sessionId: string, key: string, value: unknown): void {
    const s = this.sessions.get(sessionId);
    if (s) s.setMetadata(key, value);
  }

  /**
   * List all Sessions, optionally filtered by status.
   *
   * @param status — optional status filter
   * @returns matching Session array
   */
  listSessions(status?: SessionStatus): Session[] {
    const all = Array.from(this.sessions.values());
    if (!status) return all;
    return all.filter((s) => s.status === status);
  }

  /**
   * Get all active (non-archived) main sessions.
   * Main sessions are level-0 top-level sessions.
   */
  mainSessions(): Session[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.isMain() && !s.isArchived(),
    );
  }

  /**
   * Get all active (non-archived) sessions, regardless of level.
   */
  activeSessions(): Session[] {
    return Array.from(this.sessions.values()).filter((s) => !s.isArchived());
  }

  /**
   * Get all direct child sessions of a parent session.
   *
   * @param parentSessionId — parent session ID
   */
  subsessionsOf(parentSessionId: string): Session[] {
    const parent = this.sessions.get(parentSessionId);
    if (!parent) return [];
    return parent.subSessionIds
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined);
  }

  // -----------------------------------------------------------------------
  // Active session
  // -----------------------------------------------------------------------

  /**
   * Get the currently active main session.
   *
   * @returns active Session instance, or undefined if not set
   */
  activeMainSession(): Session | undefined {
    if (!this.activeSessionId) return undefined;
    return this.sessions.get(this.activeSessionId);
  }

  /**
   * Set the currently active session.
   * Emits {@link SessionManagerEvents.activeSessionChanged} after switching.
   *
   * @param sessionId — session ID to activate (must exist)
   * @throws Error if the specified session does not exist
   */
  setActiveSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    if (session.isArchived()) {
      throw new Error(`Cannot activate archived session '${sessionId}'. Use SessionStore.unarchive() first.`);
    }
    this.activeSessionId = sessionId;
    this.emit('activeSessionChanged', sessionId);
  }

  /**
   * Get the ID of the currently active session.
   */
  getActiveSessionId(): string {
    return this.activeSessionId;
  }

  // -----------------------------------------------------------------------
  // Tree walking
  // -----------------------------------------------------------------------

  /**
   * Get the parent session.
   *
   * @param sessionId — child session ID
   * @returns parent Session instance, or undefined for root sessions
   */
  getParentSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || !session.parentSessionId) return undefined;
    return this.sessions.get(session.parentSessionId);
  }

  /**
   * Get all direct child sessions.
   *
   * @param sessionId — parent session ID
   */
  getSubSessions(sessionId: string): Session[] {
    return this.subsessionsOf(sessionId);
  }

  /**
   * Walk up the tree to find the root session (level 0).
   *
   * @param sessionId — session ID at any level
   * @returns top-level root Session
   * @throws Error if the specified session does not exist
   */
  getRootSession(sessionId: string): Session {
    let current = this.sessions.get(sessionId);
    if (!current) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    while (current.parentSessionId) {
      const parent = this.sessions.get(current.parentSessionId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  /**
   * Build the full session tree (active sessions only).
   * Root sessions appear first, followed by their children.
   *
   * @returns SessionNode array in tree traversal order
   */
  getSessionTree(): SessionNode[] {
    const result: SessionNode[] = [];
    const visited = new Set<string>();

    // Collect roots first
    for (const session of this.sessions.values()) {
      if (session.isRoot() && !session.isArchived()) {
        if (!visited.has(session.id)) {
          result.push(session.toJSON());
          visited.add(session.id);
        }
        this.collectTree(session.id, result, visited);
      }
    }

    return result;
  }

  private collectTree(
    parentId: string,
    result: SessionNode[],
    visited: Set<string>,
  ): void {
    const parent = this.sessions.get(parentId);
    if (!parent) return;

    for (const childId of parent.subSessionIds) {
      const child = this.sessions.get(childId);
      if (child && !visited.has(childId) && !child.isArchived()) {
        result.push(child.toJSON());
        visited.add(childId);
        this.collectTree(childId, result, visited);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Messages
  // -----------------------------------------------------------------------

  /**
   * Append a message to a session, persist to JSONL, and update token stats.
   * Protected by a per-session sequential lock to prevent concurrent write conflicts.
   *
   * @param sessionId — target session ID
   * @param message   — message to append
   * @throws Error if the session does not exist
   */
  async appendMessage(sessionId: string, message: Message): Promise<void> {
    return this._withLock(sessionId, async () => {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    const store = SessionStore.getInstance();

    // Token breakdown is deferred — reading full history on every append is O(n²).
    // The breakdown is recalculated when AgentLoop starts anyway.

    // Convert to Claude-style JSONL events and persist each one
    const prevUuid = session.lastEventUuid || null;
    const events = messageToJsonlEvents(message, prevUuid || '00000000-0000-0000-0000-000000000000');
    for (const ev of events) {
      await store.persistEvent(sessionId, ev);
    }
    // Track last event uuid for chaining
    if (events.length > 0) {
      const lastEv = events[events.length - 1];
      session.lastEventUuid = (lastEv as Record<string, unknown>).uuid as string;
    }

    session.touch();
    // ── Sync meta to disk: lastEventUuid + lastActiveAt ──
    await this._syncMeta(sessionId);
    // Increment external message counter for AgentLoop inter-turn check
    const currentCount = this._messageCounts.get(sessionId) || 0;
    this._messageCounts.set(sessionId, currentCount + 1);
    // Push to in-memory cache if loaded
    if (session.cachedMessages) {
      session.cachedMessages.push(message);
    }
    this.emit('messageAppended', sessionId, message);
    TypedEventBus.emit('session:message_appended', {
      sessionId,
      messageId: message.id,
      role: message.role,
    });
    });
  }

  /**
   * Get the count of externally-appended messages for a session.
   * Lockless by design — Map.get is atomic in JS single-thread model.
   * Worst case: reads stale value, AgentLoop detects new message one turn later.
   * Used by AgentLoop to detect new messages injected mid-loop
   * (e.g., AgentMessage from another agent, background task progress).
   */
  getMessageCount(sessionId: string): number {
    return this._messageCounts.get(sessionId) || 0;
  }

  /** Store the running mode for a session */
  setRunningMode(sessionId: string, mode: string): void {
    this._runningModes.set(sessionId, mode);
  }

  /** Read the running mode for a session (defaults to 'normal') */
  getRunningMode(sessionId: string): string {
    return this._runningModes.get(sessionId) || 'normal';
  }

  /**
   * Replace the entire message history of a session with new compacted messages.
   * Truncates all existing shards, then re-appends each message as a fresh event.
   * Used by CompactCommand to persist compaction results.
   */
  async rewriteHistory(sessionId: string, messages: Message[]): Promise<void> {
    return this._withLock(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session '${sessionId}' not found`);

      const store = SessionStore.getInstance();
      await store.truncateSession(sessionId);

      // Reset event chaining — fresh start for compacted history
      session.lastEventUuid = null;
      session.touch();

      for (const message of messages) {
        const prevUuid = session.lastEventUuid || '00000000-0000-0000-0000-000000000000';
        const events = messageToJsonlEvents(message, prevUuid);
        for (const ev of events) {
          await store.persistEvent(sessionId, ev);
        }
        if (events.length > 0) {
          const lastEv = events[events.length - 1];
          session.lastEventUuid = (lastEv as Record<string, unknown>).uuid as string;
        }
      }

      // Compute and persist token breakdown after rewrite
      try {
        const agent = AgentRegistry.getInstance().agent(session.agentId);
        if (agent) {
          const systemPrompt = PromptAssembler.getInstance().buildEffectivePrompt(
            session.agentId,
            sessionId,
          );
          const toolRegistry = ToolRegistry.getInstance();
          const agentTools = toolRegistry.toolsForAgent(agent.allowedTools());
          const tools = agentTools.map((t) => t.toAnthropicTool());
          const breakdown = TokenCounter.breakdown(
            systemPrompt,
            tools,
            '',
            messages,
            agent.contextWindow,
          );
          await store.updateMeta(sessionId, { tokenBreakdown: breakdown, messageCount: messages.length });
        }
      } catch (err) {
        this.log.warn('Token breakdown after rewrite failed', { sid: sessionId, error: (err as Error).message });
      }

      await this._syncMeta(sessionId);
      session.setCachedMessages(messages);
      this._messageCounts.set(sessionId, messages.length);
    });
  }

  /**
   * Read the full message history of a session from JSONL storage.
   * Deserializes persisted events back into a Message array.
   *
   * @param sessionId — session ID
   * @param flat — when true, return individual events in chronological order
   *               (tool results embedded in tool_call messages). When false
   *               (default), merge events sharing the same message.id.
   * @returns chronologically ordered Message array
   */
  async getHistory(sessionId: string, flat?: boolean): Promise<Message[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];

    // Return in-memory cache when available (non-flat only)
    if (!flat && session.cachedMessages) {
      return session.cachedMessages;
    }

    const store = SessionStore.getInstance();
    const events = await store.loadHistory(sessionId);
    const messages = jsonlEventsToMessages(events as JsonlEvent[], flat);

    // Cache non-flat results for next call
    if (!flat) {
      session.setCachedMessages(messages);
    }

    return messages;
  }

  /**
   * Rebuild the in-memory message cache from disk.
   * Called after each agent turn so the next getHistory() is instant.
   * Fire-and-forget — failure just means next read hits disk.
   */
  async rebuildMessageCache(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    try {
      const store = SessionStore.getInstance();
      const events = await store.loadHistory(sessionId);
      const messages = jsonlEventsToMessages(events as JsonlEvent[]);
      session.setCachedMessages(messages);
    } catch {
      session.clearMessageCache(); // only clear on failure — next getHistory() will rebuild from disk
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Archive a session and all its child sessions (recursively).
   * Archived sessions no longer appear in active lists, but JSONL data remains on disk.
   *
   * @param sessionId — session ID to archive
   * @throws Error if the session does not exist
   */
  async archiveSession(sessionId: string): Promise<void> {
    return this._withLock(sessionId, async () => {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    // Recursively archive sub-sessions (tolerant — child may already be gone)
    for (const childId of session.subSessionIds) {
      try {
        await this.archiveSession(childId);
      } catch (err) {
        this.log.warn('Failed to archive child session — skipping', { parentSid: sessionId, childSid: childId, error: (err as Error).message });
      }
    }

    session.archive();

    const store = SessionStore.getInstance();
    await store.persistEvent(sessionId, {
      type: 'session_archived',
      uuid: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      parentUuid: session.lastEventUuid,
      sessionId,
      timestamp: new Date().toISOString(),
    });
    await store.archiveSession(sessionId);
    // ── Sync parent meta (its subSessionIds may include this now-archived child) ──
    if (session.parentSessionId) {
      await this._syncMeta(session.parentSessionId);
    }

    // Clean up per-session auxiliary maps to prevent memory leak
    this._locks.delete(sessionId);
    this._messageCounts.delete(sessionId);

    // Notify EventSubscriptionManager (via TypedEventBus) to clean up subscriptions
    TypedEventBus.emit('session:archiving', { sessionId });

    this.emit('sessionArchived', sessionId);
    });
  }

  /**
   * Set the session title.
   * Emits {@link SessionManagerEvents.titleChanged} event.
   *
   * @param sessionId — session ID
   * @param title     — new title
   * @throws Error if the session does not exist
   */
  async setTitle(sessionId: string, title: string): Promise<void> {
    return this._withLock(sessionId, async () => {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    session.updateTitle(title);

    const store = SessionStore.getInstance();
    await store.persistEvent(sessionId, {
      type: 'title_change',
      uuid: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      parentUuid: session.lastEventUuid,
      sessionId,
      newTitle: title,
      timestamp: new Date().toISOString(),
    });
    // ── Sync meta to disk: title + lastActiveAt ──
    await this._syncMeta(sessionId);

    this.emit('titleChanged', sessionId, title);
    });
  }

  /**
   * Set the session workspace path.
   * Emits {@link SessionManagerEvents.workspaceChanged} event.
   *
   * @param sessionId — session ID
   * @param workspace — new absolute workspace path
   * @throws Error if the session does not exist
   */
  async setWorkspace(sessionId: string, workspace: string): Promise<void> {
    return this._withLock(sessionId, async () => {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }

    session.setWorkspace(workspace);

    const store = SessionStore.getInstance();
    await store.persistEvent(sessionId, {
      type: 'workspace_change',
      uuid: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      parentUuid: session.lastEventUuid,
      sessionId,
      path: workspace,
      timestamp: new Date().toISOString(),
    });
    // ── Sync meta to disk: workspace + lastActiveAt ──
    await this._syncMeta(sessionId);

    this.emit('workspaceChanged', sessionId, workspace);
    TypedEventBus.emit('session:workspace_changed', { sessionId, workspace });
    });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Generate a unique main session ID */
  private generateMainId(): string {
    // Use a short readable ID: 4-char hex from UUID
    return randomUUID().replace(/-/g, '').slice(0, 8);
  }

  /**
   * Directly register an already-constructed Session (used by SessionStore
   * during recovery). Not part of the public API — package-private in spirit.
   */
  registerSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  /** Remove ALL sessions from memory. Does NOT touch disk — call deleteAllSessions() separately. */
  clearAll(): void {
    this._locks.clear();
    this.sessions.clear();
    this.log.info('All sessions cleared from memory');
  }
}
