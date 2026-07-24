// ConversationViewModel — session-agnostic state + SessionAgent registry.
// Each session has its own SessionAgent with independent EventEmitter, state, and pipeline.
// Switching sessions is just changing which agent's events SessionsPage listens to.

import { EventEmitter } from '../EventEmitter.js';
import { SessionAgent } from './SessionAgent.js';
import type { SessionViewModel } from './SessionViewModel.js';
import type { GoalContractDraft, GoalState } from '../components/conversation/types.js';
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
  goalPending: boolean = false;
  goalError: string | null = null;
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
  private _goalKickWaiters: Set<string> = new Set();
  private _pendingGoalMessageId: string | null = null;
  private _goalRequestTimer: ReturnType<typeof setTimeout> | null = null;

  setSessionVM(vm: SessionViewModel): void {
    this._sessionVM = vm;
    vm.getWSClient().on('goal_changed', (data: unknown) => {
      const d = data as { sessionId?: string; messageId?: string; goal?: GoalState | null };
      if (!d.sessionId) return;
      const node = vm.sessions.getById(d.sessionId);
      if (node) {
        node.metadata = { ...(node.metadata || {}), goal: d.goal || null };
        vm.sessions.updateSession({ id: node.id, metadata: node.metadata });
      }
      if (d.sessionId === this._activeRootSession()?.id) this.goalError = null;
      if (this._pendingGoalMessageId && d.messageId === this._pendingGoalMessageId) {
        if (this._goalRequestTimer) clearTimeout(this._goalRequestTimer);
        this._goalRequestTimer = null;
        this._pendingGoalMessageId = null;
        this.goalPending = false;
        this.goalError = null;
        this.emit('goalPendingChanged', false);
      }
      if (this._activeSessionId) this._syncGoalFromActiveSession();
      if (this._activeSessionId) this._syncModeFromActiveSession();
      if (d.goal?.status === 'active' && (data as { action?: string }).action && node) {
        this._kickGoalIfIdle(node).catch((err) => {
          ClientLogger.vm.error('Failed to kick acknowledged Goal', { error: (err as Error).message });
        });
      }
    });
    vm.getWSClient().on('session_mode_changed', (data: unknown) => {
      const d = data as { sessionId?: string; mode?: string; storedMode?: string; effort?: boolean; locked?: boolean };
      if (!d.sessionId) return;
      const node = vm.sessions.getById(d.sessionId);
      if (node) {
        node.metadata = {
          ...(node.metadata || {}),
          permissionMode: this._toCanonicalMode(this._fromCanonicalMode(d.storedMode ?? d.mode)),
          effortMode: d.effort !== false,
        };
        vm.sessions.updateSession({ id: node.id, metadata: node.metadata });
      }
      if (d.sessionId === this._activeSessionId || node?.id === this._activeRootSession()?.id) {
        const goalIsActive = this._hasActiveGoal(this._rootForSession(node));
        this.permissionMode = d.locked || goalIsActive ? 'auto-edit' : this._fromCanonicalMode(d.mode);
        this.effortMode = d.locked ? true : d.effort !== false;
        this.emit('permissionModeChanged', this.permissionMode);
        this.emit('effortModeChanged', this.effortMode);
      }
    });
    vm.getWSClient().on('error', (data: unknown) => {
      const d = data as { code?: string; messageId?: string; errorMessage?: string };
      if (!d.code?.startsWith('GOAL_') && d.code !== 'INVALID_GOAL_ACTION') return;
      if (this._pendingGoalMessageId && d.messageId !== this._pendingGoalMessageId) return;
      if (this._goalRequestTimer) clearTimeout(this._goalRequestTimer);
      this._goalRequestTimer = null;
      this._pendingGoalMessageId = null;
      this.goalPending = false;
      this.goalError = d.errorMessage || 'Goal update failed';
      this.emit('goalPendingChanged', false);
      this.emit('goalError', this.goalError);
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
      const emitMessagesChanged = () => this.emit('messagesChanged', sessionId);
      agent.on('messageAdded', emitMessagesChanged);
      agent.on('messageUpdated', emitMessagesChanged);
      agent.on('messageRemoved', emitMessagesChanged);
      agent.on('reset', emitMessagesChanged);
      agent.on('historyLoaded', emitMessagesChanged);
    }
    return agent;
  }

  getKnownAgents(): SessionAgent[] {
    return Array.from(this._agents.values());
  }

  /** Reconcile every known session, including the active one, after WS reconnect. */
  reconcileAfterReconnect(): void {
    if (this._activeSessionId) this.getAgent(this._activeSessionId);
    for (const agent of this._agents.values()) agent.requestHistoryReconcile();
    const root = this._activeRootSession();
    if (root && this._hasActiveGoal(root)) {
      this._kickGoalIfIdle(root).catch(() => {});
    }
  }

  /** Destroy and remove a SessionAgent — cleans up emitter + state. */
  removeAgent(sessionId: string): void {
    const agent = this._agents.get(sessionId);
    if (agent) {
      agent.destroy();
      this._agents.delete(sessionId);
      this._activeStreamingIds.delete(sessionId);
      this._goalKickWaiters.delete(sessionId);
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

  getStreamingSessionIds(): string[] {
    return Array.from(this._activeStreamingIds);
  }

  isSessionStreaming(sessionId: string): boolean {
    return this._activeStreamingIds.has(sessionId) || this._agents.get(sessionId)?.state.isStreaming === true;
  }

  /** True when the supplied session, or the current active session, belongs to an active root goal. */
  hasActiveGoalForSession(sessionId?: string | null): boolean {
    if (!this._sessionVM) return false;
    if (sessionId) {
      const node = this._sessionVM.sessions.getById(sessionId);
      return node ? this._hasActiveGoal(this._rootForSession(node)) : false;
    }
    return this._hasActiveGoal(this._activeRootSession());
  }

  // ── Permission / mode ──

  /** Change tool execution gate. Fires permissionModeChanged for UI updates. */
  setPermissionMode(mode: PermissionModeUi): void {
    const active = this._sessionVM?.activeSession;
    if (active && !this._isRootSession(active)) {
      mode = 'auto-edit';
    }
    if (active && this._hasActiveGoal(this._rootForSession(active))) {
      this.permissionMode = 'auto-edit';
      this.emit('permissionModeChanged', this.permissionMode);
      return;
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

  setGoal(
    action: 'start' | 'pause' | 'resume' | 'edit' | 'complete' | 'delete',
    input?: string | GoalContractDraft,
  ): void {
    const root = this._activeRootSession();
    if (!root || !this._sessionVM) return;
    const contract: GoalContractDraft | undefined = typeof input === 'string'
      ? { objective: input }
      : input;
    if ((action === 'start' || action === 'edit') && !contract?.objective?.trim()) return;
    const messageId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (this._goalRequestTimer) clearTimeout(this._goalRequestTimer);
    this._pendingGoalMessageId = messageId;
    this.goalPending = true;
    this.goalError = null;
    this.emit('goalPendingChanged', true);
    this._goalRequestTimer = setTimeout(() => {
      if (this._pendingGoalMessageId !== messageId) return;
      this._pendingGoalMessageId = null;
      this._goalRequestTimer = null;
      this.goalPending = false;
      this.goalError = 'Goal update timed out. Check the connection and try again.';
      this.emit('goalPendingChanged', false);
      this.emit('goalError', this.goalError);
    }, 15_000);
    this._sessionVM.getWSClient().send({
      type: 'set_goal',
      sessionId: root.id,
      messageId,
      action,
      ...(contract ? {
        objective: contract.objective.trim(),
        acceptanceCriteria: contract.acceptanceCriteria?.trim(),
        workspace: contract.workspace,
        maxRuns: contract.maxRuns,
        maxConsecutiveFailures: contract.maxConsecutiveFailures,
        wakeIntervalMs: contract.wakeIntervalMs,
        completionMode: contract.completionMode,
      } : {}),
    });
  }

  private _syncModeFromActiveSession(): void {
    const active = this._sessionVM?.activeSession;
    if (!active || !this._isRootSession(active)) {
      this.permissionMode = 'auto-edit';
      this.effortMode = true;
      this.emit('permissionModeChanged', this.permissionMode);
      this.emit('effortModeChanged', this.effortMode);
      return;
    }

    const nextEffort = active.metadata?.effortMode === false ? false : true;
    const nextMode = this._hasActiveGoal(active)
      ? 'auto-edit'
      : this._fromCanonicalMode(active.metadata?.permissionMode);
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

  private _hasActiveGoal(node: SessionNode | null | undefined): boolean {
    const goal = node?.metadata?.goal as GoalState | null | undefined;
    return goal?.status === 'active';
  }

  private _activeRootSession(): SessionNode | null {
    const active = this._sessionVM?.activeSession;
    return this._rootForSession(active);
  }

  private _rootForSession(node: SessionNode | null | undefined): SessionNode | null {
    if (!node || !this._sessionVM) return null;
    let current: SessionNode | undefined = node;
    while (current && !this._isRootSession(current)) {
      const parentId: string | null = current.parentId || current.parentSessionId || null;
      current = parentId ? this._sessionVM.sessions.getById(parentId) : undefined;
    }
    return current || node;
  }

  private async _kickGoalIfIdle(root: SessionNode): Promise<void> {
    if (!this._sessionVM) return;
    const goal = root.metadata?.goal as GoalState | null | undefined;
    if (!goal || goal.status !== 'active') return;
    const agent = this.getAgent(root.id);
    if (agent.state.isStreaming) {
      if (this._goalKickWaiters.has(root.id)) return;
      this._goalKickWaiters.add(root.id);
      const onStopped = () => {
        agent.off('streamingStopped', onStopped);
        this._goalKickWaiters.delete(root.id);
        const latest = this._sessionVM?.sessions.getById(root.id);
        if (!latest) return;
        this._kickGoalIfIdle(latest).catch((err) => {
          ClientLogger.vm.error('Failed to restart acknowledged Goal', { error: (err as Error).message });
        });
      };
      agent.on('streamingStopped', onStopped);
      return;
    }
    const mode: PermissionModeUi = 'auto-edit';
    const effort = root.metadata?.effortMode === false ? false : true;
    const content = [
      'Start or continue working toward this active session goal.',
      '',
      '# Active Goal',
      `Objective: ${goal.objective}`,
      `Run count: ${goal.runCount || 0}`,
      '',
      '# Current Execution Context',
      `Workspace: ${root.workspace || '(default workspace)'}`,
      `Permission mode: ${this._toCanonicalMode(mode)}`,
      `Effort: ${effort ? 'HIGH' : 'NORMAL'}`,
      '',
      'Use the current workspace as the primary context. Advance the next useful step; if the goal is already complete or blocked, say so clearly.',
    ].join('\n');
    await agent.sendMessage(content, mode, effort, [], { internalGoal: true });
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
