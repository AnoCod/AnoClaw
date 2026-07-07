// AnoClaw Frontend — Session ViewModel
// Manages session tree nodes (CRUD), active session selection, and workspace binding.
// Owns the WSClient reference — all WS communication flows through here.

import { EventEmitter } from '../EventEmitter.js';
import { SessionListModel } from './SessionListModel.js';
import type { WSClient } from './WSClient.js';
import { ClientLogger } from '../ClientLogger.js';
import type { SessionNode } from '../types.js';
import { ToastManager } from '../ToastManager.js';
import type { AgentViewModel } from './AgentViewModel.js';

/** localStorage key for persisting the active session across page refreshes. */
const ACTIVE_SESSION_KEY = 'anoclaw-active-session';

export class SessionViewModel extends EventEmitter {
  /** Observable session tree. Fires sessionAdded/Updated/Removed events. */
  sessions: SessionListModel = new SessionListModel();
  activeSessionId: string | null = null;
  private _sseClient: WSClient;
  private _agentVM: AgentViewModel | null = null;

  constructor(sseClient: WSClient) {
    super();
    this._sseClient = sseClient;
    // Forward SessionListModel events so SessionsPage's tree bindings work.
    // SessionListModel fires these internally; we re-emit them on the ViewModel
    // so the page layer can subscribe to a single source.
    this.sessions.on('sessionAdded', (node: unknown) => { this.emit('sessionAdded', node); });
    this.sessions.on('sessionUpdated', (node: unknown) => { this.emit('sessionUpdated', node); });
    this.sessions.on('sessionRemoved', (node: unknown) => { this.emit('sessionRemoved', node); });

    // Listen for session title changes via WebSocket (e.g. CEO renames a session)
    this._sseClient.on('session_title_changed', (data: unknown) => {
      const d = data as { sessionId: string; title: string };
      if (d.sessionId && d.title) {
        this.sessions.updateSession({ id: d.sessionId, title: d.title });
      }
    });

    // Listen for session hard deletes via WebSocket (e.g. CEO permanently deletes)
    this._sseClient.on('session_hard_deleted', (data: unknown) => {
      const d = data as { sessionId: string };
      if (d.sessionId) {
        this.sessions.removeSession(d.sessionId);
      }
    });
  }

  getWSClient(): WSClient { return this._sseClient; }

  setAgentVM(agentVM: AgentViewModel): void {
    this._agentVM = agentVM;
  }

  async ensureRunnableAgentForSession(sessionId: string): Promise<void> {
    if (!this._agentVM) return;
    await this._agentVM.ensureLoaded();
    const session = this.sessions.getById(sessionId);
    const result = this._agentVM.selectRunnableAgent(session?.agentId);
    if (!result.ok) {
      throw new Error(result.message || 'No runnable agent is configured. Open Agents and configure a model connection before sending a message.');
    }
  }

  /** Fetch the full session list from the backend and rebuild the tree. */
  async loadSessions(): Promise<void> {
    console.log('[SessionVM] Loading sessions...');
    try {
      const resp = await fetch('/api/v1/sessions');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json(); const data: SessionNode[] = Array.isArray(raw) ? raw : (raw.sessions || []);
      // Rebuild the tree from scratch
      this.sessions.clear();
      for (const node of data) {
        this.sessions.addSession(node);
      }
      this.emit('sessionsLoaded', this.sessions.tree);
      ClientLogger.vm.info('Sessions loaded', { count: this.sessions.tree.length });
    } catch (e) {
      ClientLogger.vm.error('Failed to load sessions', { error: (e as Error).message });
    }
  }

  /** Select a session by ID. Persists the choice to localStorage for restore on refresh.
   *  No WS reconnect needed — the connection is global, not per-session. */
  selectSession(id: string): void {
    console.log('[SessionVM] Selecting session', { sessionId: id });
    const node = this.sessions.getById(id);
    if (!node) {
      ClientLogger.vm.warn('Session not found for selection', { sid: id });
      return;
    }

    this.activeSessionId = id;
    // Persist so we can restore after page refresh (restoreActiveSession)
    try { localStorage.setItem(ACTIVE_SESSION_KEY, id); } catch (_) { /* ignore */ }
    this.emit('sessionSelected', node);
  }

  /** Create a new session via the API, add it to the tree, and auto-select it. */
  async createSession(name?: string, parentId?: string): Promise<SessionNode | null> {
    console.log('[SessionVM] Creating session', { name, parentId });
    try {
      const resp = await fetch('/api/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || 'New Session', parentId: parentId || null }),
      });
      if (!resp.ok) {
        let message = `HTTP ${resp.status}`;
        try {
          const body = await resp.json() as { message?: string; error?: string };
          message = body.message || body.error || message;
        } catch { /* keep status fallback */ }
        throw new Error(message);
      }
      const node: SessionNode = await resp.json();
      this.sessions.addSession(node);
      this.selectSession(node.id);
      ClientLogger.vm.info('Session created', { sid: node.id });
      return node;
    } catch (e) {
      ClientLogger.vm.error('Failed to create session', { error: (e as Error).message });
      ToastManager.getInstance().error((e as Error).message || 'Failed to create session');
      return null;
    }
  }

  /** Delete (archive) a session via the API. If it was the active session, deselect it. */
  async archiveSession(id: string): Promise<boolean> {
    console.log('[SessionVM] Archiving session', { sessionId: id });
    try {
      const resp = await fetch(`/api/v1/sessions/${id}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.sessions.removeSession(id);
      if (this.activeSessionId === id) {
        this.activeSessionId = null;
        try { localStorage.removeItem(ACTIVE_SESSION_KEY); } catch (_) { /* ignore */ }
        this.emit('sessionDeselected');
      }
      this.emit('sessionArchived', id);
      ClientLogger.vm.info('Session archived', { sid: id });
      return true;
    } catch (e) {
      ClientLogger.vm.error('Failed to archive session', { sid: id, error: (e as Error).message });
      return false;
    }
  }

  /** Rename a session via the API and update the local tree node. */
  async renameSession(id: string, newName: string): Promise<boolean> {
    try {
      const resp = await fetch(`/api/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newName }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.sessions.updateSession({ id, title: newName });
      ClientLogger.vm.debug('Session renamed', { sid: id });
      return true;
    } catch (e) {
      ClientLogger.vm.error('Failed to rename session', { sid: id, error: (e as Error).message });
      return false;
    }
  }

  /** Get the full SessionNode for the currently active session (or null). */
  get activeSession(): SessionNode | null {
    if (!this.activeSessionId) return null;
    return this.sessions.getById(this.activeSessionId) || null;
  }

  /** After page refresh, look up the saved session ID in localStorage and reselect it.
   *  Returns true if a session was successfully restored. */
  restoreActiveSession(): boolean {
    try {
      const savedId = localStorage.getItem(ACTIVE_SESSION_KEY);
      if (savedId && this.sessions.getById(savedId)) {
        this.selectSession(savedId);
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }
}
