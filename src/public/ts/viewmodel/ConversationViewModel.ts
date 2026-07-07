// ConversationViewModel — session-agnostic state + SessionAgent registry.
// Each session has its own SessionAgent with independent EventEmitter, state, and pipeline.
// Switching sessions is just changing which agent's events SessionsPage listens to.

import { EventEmitter } from '../EventEmitter.js';
import { SessionAgent } from './SessionAgent.js';
import type { SessionViewModel } from './SessionViewModel.js';
import type { GoalState } from '../components/conversation/types.js';
import { ClientLogger } from '../ClientLogger.js';
import type { SessionNode } from '../types.js';

type PermissionModeUi = 'ask' | 'auto-edit' | 'plan' | 'auto';

export class ConversationViewModel extends EventEmitter {
  // ── Session-agnostic UI state ──
  // These belong to the overall app, not any single session.
  inputValue: string = '';
  /** Controls tool execution gate: ask user, auto-edit, plan-only, or full auto. */
  permissionMode: PermissionModeUi = 'auto';
  goal: GoalState | null = null;
  /** Whether the AI is allowed to put in extra effort on this turn. */
  effortMode: boolean = true;
  /** Files attached by the user before sending a message. */
  attachments: { name: string; path: string; type: string; size: number; content?: string }[] = [];

  private _sessionVM: SessionViewModel | null = null;

  // ── SessionAgent registry — one agent per session ──
  // Lazy-created on first getAgent(). Each agent owns its own
  // EventEmitter, SessionState, and WS event handlers.
  private _agents: Map<string, SessionAgent> = new Map();
  private _activeSessionId: string | null = null;
  /** Track sessions that had active streaming so connectionLost can notify them. */
  private _activeStreamingIds: Set<string> = new Set();

  setSessionVM(vm: SessionViewModel): void {
    this._sessionVM = vm;
    vm.getWSClient().on('goal_changed', (data: unknown) => {
      const d = data as { sessionId?: string; goal?: GoalState | null };
      if (!d.sessionId) return;
      const node = vm.sessions.getById(d.sessionId);
      if (node) {
        node.metadata = { ...(node.metadata || {}), goal: d.goal || null };
        vm.sessions.updateSession({ id: node.id, metadata: node.metadata });
      }
      if (this._activeSessionId) this._syncGoalFromActiveSession();
    });
    vm.getWSClient().on('session_mode_changed', (data: unknown) => {
      const d = data as { sessionId?: string; mode?: string; effort?: boolean; locked?: boolean };
      if (!d.sessionId) return;
      const node = vm.sessions.getById(d.sessionId);
      if (node) {
        node.metadata = {
          ...(node.metadata || {}),
          permissionMode: this._toCanonicalMode(this._fromCanonicalMode(d.mode)),
          effortMode: d.effort !== false,
        };
        vm.sessions.updateSession({ id: node.id, metadata: node.metadata });
      }
      if (d.sessionId === this._activeSessionId || node?.id === this._activeRootSession()?.id) {
        this.permissionMode = d.locked ? 'auto' : this._fromCanonicalMode(d.mode);
        this.effortMode = d.locked ? true : d.effort !== false;
        this.emit('permissionModeChanged', this.permissionMode);
        this.emit('effortModeChanged', this.effortMode);
      }
    });
  }
  getSessionVM(): SessionViewModel | null { return this._sessionVM; }

  // ── Agent registry ──

  /** Get or create a SessionAgent for the given session. Auto-subscribes streaming tracking. */
  getAgent(sessionId: string): SessionAgent {
    if (!this._sessionVM) {
      throw new Error('ConversationViewModel: _sessionVM is null. Call setSessionVM() before getAgent().');
    }
    let agent = this._agents.get(sessionId);
    if (!agent) {
      agent = new SessionAgent(sessionId, this._sessionVM);
      this._agents.set(sessionId, agent);
      // Forward streaming tracking
      agent.on('streamingStarted', () => this._activeStreamingIds.add(sessionId));
      agent.on('streamingStopped', () => this._activeStreamingIds.delete(sessionId));
    }
    return agent;
  }

  /** Destroy and remove a SessionAgent — cleans up emitter + state. */
  removeAgent(sessionId: string): void {
    const agent = this._agents.get(sessionId);
    if (agent) {
      agent.destroy();
      this._agents.delete(sessionId);
      this._activeStreamingIds.delete(sessionId);
    }
  }

  // ── Active session ──

  /** Switch the active session. No-ops if already active. Fires activeSessionChanged. */
  setActiveSession(sessionId: string): void {
    if (this._activeSessionId === sessionId) return;
    console.log('[ConvVM] Active session changed', { from: this._activeSessionId, to: sessionId });
    this._activeSessionId = sessionId;
    this._syncModeFromActiveSession();
    this._syncGoalFromActiveSession();
    this.emit('activeSessionChanged', sessionId);
  }

  getActiveSessionId(): string | null { return this._activeSessionId; }

  // ── Permission / mode ──

  /** Change tool execution gate. Fires permissionModeChanged for UI updates. */
  setPermissionMode(mode: PermissionModeUi): void {
    const active = this._sessionVM?.activeSession;
    if (active && !this._isRootSession(active)) {
      mode = 'auto';
    }
    console.log('[ConvVM] Permission mode changed', { mode });
    this.permissionMode = mode;
    this.emit('permissionModeChanged', mode);
    if (active && this._isRootSession(active)) {
      active.metadata = { ...(active.metadata || {}), permissionMode: this._toCanonicalMode(mode) };
      this._sessionVM?.sessions.updateSession({ id: active.id, metadata: active.metadata });
      this._sessionVM?.getWSClient().send({
        type: 'set_session_mode',
        sessionId: active.id,
        mode,
        effort: this.effortMode,
      });
    }
  }

  /** Toggle effort mode. Fires effortModeChanged for UI updates. */
  setEffortMode(effort: boolean): void {
    const active = this._sessionVM?.activeSession;
    if (active && !this._isRootSession(active)) effort = true;
    this.effortMode = effort;
    this.emit('effortModeChanged', effort);
    if (active && this._isRootSession(active)) {
      active.metadata = { ...(active.metadata || {}), effortMode: effort };
      this._sessionVM?.sessions.updateSession({ id: active.id, metadata: active.metadata });
      this._sessionVM?.getWSClient().send({
        type: 'set_session_mode',
        sessionId: active.id,
        mode: this.permissionMode,
        effort,
      });
    }
  }

  setGoal(action: 'start' | 'pause' | 'resume' | 'edit' | 'delete', objective?: string): void {
    const root = this._activeRootSession();
    if (!root || !this._sessionVM) return;
    if ((action === 'start' || action === 'edit') && !objective?.trim()) return;
    this._sessionVM.getWSClient().send({
      type: 'set_goal',
      sessionId: root.id,
      action,
      objective: objective?.trim(),
    });

    const now = new Date().toISOString();
    if (action === 'start' || action === 'edit') {
      const next: GoalState = {
        ...(this.goal || { createdAt: now }),
        objective: objective!.trim(),
        status: 'active',
        updatedAt: now,
      };
      root.metadata = { ...(root.metadata || {}), goal: next };
      this.goal = next;
    } else if (this.goal) {
      const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'deleted';
      const next = { ...this.goal, status, updatedAt: now } as GoalState;
      root.metadata = { ...(root.metadata || {}), goal: next };
      this.goal = status === 'deleted' ? null : next;
    }
    this._sessionVM.sessions.updateSession({ id: root.id, metadata: root.metadata });
    this.emit('goalChanged', this.goal);
    if (action === 'start' || action === 'resume' || action === 'edit') {
      this._kickGoalIfIdle(root).catch((err) => {
        ClientLogger.vm.error('Failed to kick goal loop', { error: (err as Error).message });
      });
    }
  }

  private _syncModeFromActiveSession(): void {
    const active = this._sessionVM?.activeSession;
    if (!active || !this._isRootSession(active)) {
      this.permissionMode = 'auto';
      this.effortMode = true;
      this.emit('permissionModeChanged', this.permissionMode);
      this.emit('effortModeChanged', this.effortMode);
      return;
    }

    const nextMode = this._fromCanonicalMode(active.metadata?.permissionMode);
    const nextEffort = active.metadata?.effortMode === false ? false : true;
    this.permissionMode = nextMode;
    this.effortMode = nextEffort;
    this.emit('permissionModeChanged', nextMode);
    this.emit('effortModeChanged', nextEffort);
  }

  private _syncGoalFromActiveSession(): void {
    const root = this._activeRootSession();
    const goal = root?.metadata?.goal as GoalState | null | undefined;
    this.goal = goal && goal.status !== 'deleted' ? goal : null;
    this.emit('goalChanged', this.goal);
  }

  private _isRootSession(node: SessionNode): boolean {
    return !node.parentId && !node.parentSessionId && (node.level === undefined || node.level === 0);
  }

  private _activeRootSession(): SessionNode | null {
    const active = this._sessionVM?.activeSession;
    if (!active || !this._sessionVM) return null;
    let current: SessionNode | undefined = active;
    while (current && !this._isRootSession(current)) {
      const parentId: string | null = current.parentId || current.parentSessionId || null;
      current = parentId ? this._sessionVM.sessions.getById(parentId) : undefined;
    }
    return current || active;
  }

  private async _kickGoalIfIdle(root: SessionNode): Promise<void> {
    if (!this._sessionVM || !this.goal || this.goal.status !== 'active') return;
    const agent = this.getAgent(root.id);
    if (agent.state.isStreaming) return;
    const mode = this._fromCanonicalMode(root.metadata?.permissionMode);
    const effort = root.metadata?.effortMode === false ? false : true;
    const content = [
      'Start or continue working toward this active session goal.',
      '',
      `Goal: ${this.goal.objective}`,
    ].join('\n');
    await agent.sendMessage(content, mode, effort, []);
  }

  private _fromCanonicalMode(value: unknown): PermissionModeUi {
    switch (value) {
      case 'Ask': return 'ask';
      case 'ask': return 'ask';
      case 'AutoEdit': return 'auto-edit';
      case 'auto-edit': return 'auto-edit';
      case 'auto_edit': return 'auto-edit';
      case 'Plan': return 'plan';
      case 'plan': return 'plan';
      case 'Auto':
      case 'auto':
      default:
        return 'auto';
    }
  }

  private _toCanonicalMode(mode: PermissionModeUi): string {
    switch (mode) {
      case 'ask': return 'Ask';
      case 'auto-edit': return 'AutoEdit';
      case 'plan': return 'Plan';
      case 'auto':
      default:
        return 'Auto';
    }
  }

  // ── Commands ──

  /** Dispatch a slash command to the backend via WS for the active session. */
  runCommand(command: string, args?: Record<string, string>): void {
    console.log('[ConvVM] Command run', { command, args });
    const sid = this._sessionVM?.activeSessionId;
    if (!sid || !this._sessionVM) return;
    this._sessionVM.getWSClient().runCommand(sid, command, args);
    ClientLogger.vm.debug('Command sent via WS', { command });
  }

  // ── Connection ──

  /** Notify all sessions that were streaming that the WS connection dropped. */
  onConnectionLost(): void {
    console.warn('[ConvVM] Connection lost, notifying sessions', { count: this._activeStreamingIds.size });
    for (const sid of this._activeStreamingIds) {
      const agent = this._agents.get(sid);
      if (agent) agent.onConnectionLost();
    }
  }

  // ── Attachments ──

  /** Add a file attachment for the next message. Fires attachmentsChanged. */
  addAttachment(file: { name: string; path: string; type: string; size: number; content?: string }): void {
    this.attachments.push(file);
    this.emit('attachmentsChanged', this.attachments);
  }

  /** Remove an attachment by index. Fires attachmentsChanged. */
  removeAttachment(index: number): void {
    if (index >= 0 && index < this.attachments.length) {
      this.attachments.splice(index, 1);
      this.emit('attachmentsChanged', this.attachments);
    }
  }

  /** Clear all pending attachments. Fires attachmentsChanged. */
  clearAttachments(): void {
    this.attachments = [];
    this.emit('attachmentsChanged', this.attachments);
  }
}
