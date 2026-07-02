// ConversationViewModel — session-agnostic state + SessionAgent registry.
// Each session has its own SessionAgent with independent EventEmitter, state, and pipeline.
// Switching sessions is just changing which agent's events SessionsPage listens to.

import { EventEmitter } from '../EventEmitter.js';
import { SessionAgent } from './SessionAgent.js';
import type { SessionViewModel } from './SessionViewModel.js';
import type { RunningMode } from '../components/conversation/types.js';
import { ClientLogger } from '../ClientLogger.js';

export class ConversationViewModel extends EventEmitter {
  // ── Session-agnostic UI state ──
  // These belong to the overall app, not any single session.
  inputValue: string = '';
  /** Controls tool execution gate: ask user, auto-edit, plan-only, or full auto. */
  permissionMode: 'ask' | 'auto-edit' | 'plan' | 'auto' = 'auto';
  /** normal = single turn, infinite = keep running until stopped. */
  runningMode: RunningMode = 'normal';
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

  setSessionVM(vm: SessionViewModel): void { this._sessionVM = vm; }
  getSessionVM(): SessionViewModel | null { return this._sessionVM; }

  // ── Agent registry ──

  /** Get or create a SessionAgent for the given session. Auto-subscribes streaming tracking. */
  getAgent(sessionId: string): SessionAgent {
    let agent = this._agents.get(sessionId);
    if (!agent) {
      agent = new SessionAgent(sessionId, this._sessionVM!);
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
    this.emit('activeSessionChanged', sessionId);
  }

  getActiveSessionId(): string | null { return this._activeSessionId; }

  // ── Permission / mode ──

  /** Change tool execution gate. Fires permissionModeChanged for UI updates. */
  setPermissionMode(mode: 'ask' | 'auto-edit' | 'plan' | 'auto'): void {
    console.log('[ConvVM] Permission mode changed', { mode });
    this.permissionMode = mode;
    this.emit('permissionModeChanged', mode);
  }

  /** Change running mode. Sends set_running_mode to backend via WS. */
  setRunningMode(mode: RunningMode): void {
    this.runningMode = mode;
    this.emit('runningModeChanged', mode);
    const sid = this._sessionVM?.activeSessionId;
    if (sid) {
      this._sessionVM!.getWSClient().send({ type: 'set_running_mode', sessionId: sid, runningMode: mode });
    }
  }

  /** Toggle effort mode. Fires effortModeChanged for UI updates. */
  setEffortMode(effort: boolean): void {
    this.effortMode = effort;
    this.emit('effortModeChanged', effort);
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
