// Agent — runtime instance for an Agent identity
// Extends EventEmitter. One Agent instance can serve multiple sessions.

import { EventEmitter } from 'events';
import type { AgentConfig } from '../../../shared/types/agent.js';
import type { AgentConfigWithKey } from './AgentConfig.js';
import { AgentRole, AgentState, AgentStatus } from '../../../shared/types/agent.js';
import { AgentEvents } from '../../../shared/types/events.js';
import { createLogger } from '../logger.js';
import { TypedEventBus } from '../events/TypedEventBus.js';

export class Agent extends EventEmitter {
  // ── Identity (immutable) ──
  readonly id: string;
  readonly createdAt: string;
  readonly teamName: string;

  // ── Identity (mutable via controlled methods) ──
  private _level: number;
  private _parentAgentId: string | null;

  // ── Mutable identity fields (emit on change) ──
  private _name: string;
  private _role: AgentRole;

  // ── Global state ──
  private _state: AgentState;
  private _servingSessionCount: number = 0;

  // ── Per-session status ──
  private _sessionStatuses: Map<string, AgentStatus> = new Map();

  // ── Model config (immutable after construction, but config can be updated) ──
  private _provider: string;
  private _apiUrl: string;
  private _apiKey: string;
  private _model: string;
  private _contextWindow: number;
  private _maxTurns: number;
  private _temperature: number;

  // ── Capability config ──
  private _allowedTools: string[];
  private _enabledSkills: string[];
  private _mcpServers: string[];

  // ── Prompt config ──
  private _agentPrompt: string;
  private _preferredLanguage: string;
  private _conversationLanguage: string;

  constructor(config: AgentConfigWithKey) {
    super();
    this.setMaxListeners(20);

    // Identity
    this.id = config.id;
    this._name = config.name;
    this._role = config.role;
    this._parentAgentId = config.parentAgentId;
    this._level = config.level;
    this.teamName = config.teamName;
    this.createdAt = config.createdAt;

    // Global state
    this._state = config.state ?? AgentState.Active;

    // Model
    this._provider = config.provider;
    this._apiUrl = config.apiUrl;
    this._apiKey = config.apiKey;
    this._model = config.model;
    this._contextWindow = config.contextWindow;
    this._maxTurns = config.maxTurns ?? 25;
    this._temperature = config.temperature ?? 0.7;

    // Capabilities
    this._allowedTools = [...config.allowedTools ?? []];
    this._enabledSkills = [...config.enabledSkills ?? []];
    this._mcpServers = [...config.mcpServers ?? []];

    // Prompt
    this._agentPrompt = config.agentPrompt ?? '';
    this._preferredLanguage = config.preferredLanguage ?? 'en';
    this._conversationLanguage = config.conversationLanguage ?? 'en';

    createLogger('anochat.agent').debug('Agent constructed', { aid: this.id, role: this._role, model: this._model });
  }

  // ── Getters/Setters with event emission ──

  get name(): string {
    return this._name;
  }
  set name(value: string) {
    if (this._name !== value) {
      const old = this._name;
      this._name = value;
      this.emit(AgentEvents.NameChanged, value, old);
    }
  }

  get role(): AgentRole {
    return this._role;
  }
  get roleString(): string {
    return this._role;
  }
  /** Set role and emit RoleChanged event. */
  setRole(value: AgentRole): void {
    if (this._role !== value) {
      const old = this._role;
      this._role = value;
      this.emit(AgentEvents.RoleChanged, value, old);
    }
  }

  // ── Global state ──

  get state(): AgentState {
    return this._state;
  }

  get isActive(): boolean {
    return this._state === AgentState.Active;
  }

  /** Transition the agent's global state. Emits ActiveStateChanged. */
  setState(value: AgentState): void {
    if (this._state !== value) {
      const old = this._state;
      this._state = value;
      this.emit(AgentEvents.ActiveStateChanged, value, old);
      createLogger('anochat.agent').debug('Agent state changed', { aid: this.id, from: old, to: value });
    }
  }

  get servingSessionCount(): number {
    return this._servingSessionCount;
  }

  /** Called when a session starts/stops using this agent. Emits SessionCountChanged. */
  adjustSessionCount(delta: number): void {
    this._servingSessionCount = Math.max(0, this._servingSessionCount + delta);
    this.emit(AgentEvents.SessionCountChanged, this._servingSessionCount);
    createLogger('anochat.agent').debug('Agent session count adjusted', { aid: this.id, delta, count: this._servingSessionCount });
  }

  // ── Per-session status ──

  sessionStatus(sessionId: string): AgentStatus | undefined {
    return this._sessionStatuses.get(sessionId);
  }

  setSessionStatus(sessionId: string, status: AgentStatus): void {
    const prev = this._sessionStatuses.get(sessionId);
    if (prev !== status) {
      this._sessionStatuses.set(sessionId, status);
      this.emit(AgentEvents.StatusChanged, sessionId, status, prev);
      TypedEventBus.emit('agent:status_changed', { agentId: this.id, oldStatus: prev || '', newStatus: status });
      createLogger('anochat.agent').debug('Agent session status changed', { aid: this.id, sid: sessionId, from: prev, to: status });
    }
  }

  allSessionStatuses(): ReadonlyMap<string, AgentStatus> {
    return this._sessionStatuses;
  }

  /** Remove a session's status tracking (e.g., session ended). */
  clearSessionStatus(sessionId: string): void {
    this._sessionStatuses.delete(sessionId);
  }

  // ── Model properties ──

  get provider(): string { return this._provider; }
  get apiUrl(): string { return this._apiUrl; }
  get apiKey(): string { return this._apiKey; }
  get modelName(): string { return this._model; }
  get contextWindow(): number { return this._contextWindow; }
  get maxTurns(): number { return this._maxTurns; }
  get temperature(): number { return this._temperature; }

  // ── Capabilities ──

  allowedTools(): string[] {
    return [...this._allowedTools];
  }

  enabledSkills(): string[] {
    return [...this._enabledSkills];
  }

  mcpServers(): string[] {
    return [...this._mcpServers];
  }

  // ── Prompt ──

  get agentPrompt(): string {
    return this._agentPrompt;
  }

  get preferredLanguage(): string {
    return this._preferredLanguage;
  }

  get conversationLanguage(): string {
    return this._conversationLanguage;
  }

  // ── Organization ──

  get level(): number { return this._level; }
  get parentAgentId(): string | null { return this._parentAgentId; }

  /** Whether this agent role can have subordinates. */
  isManagerRole(): boolean {
    return this._role === AgentRole.MainAgent || this._role === AgentRole.Manager;
  }

  /**
   * Reassign this agent to a new parent in the org tree.
   * Updates parentAgentId and recalculates level. Preserves all runtime state
   * (session statuses, event listeners, servingSessionCount).
   */
  reassignParent(newParentId: string, newLevel: number): void {
    const oldParentId = this._parentAgentId;
    const oldLevel = this._level;
    this._parentAgentId = newParentId;
    this._level = newLevel;
    this.emit(AgentEvents.ConfigUpdated, { parentAgentId: newParentId, level: newLevel });
    createLogger('anochat.agent').info('Agent parent reassigned', { aid: this.id, parent: newParentId, level: newLevel });
  }

  // ── Update config (batch update from a loaded AgentConfig) ──

  /**
   * Apply changes from an AgentConfig object. Emits events for changed fields.
   * Used after reloading config from disk or receiving an update.
   */
  updateFromConfig(config: AgentConfigWithKey): void {
    // Identity fields that can change
    this.name = config.name;

    if (this._role !== config.role) {
      const old = this._role;
      this._role = config.role;
      this.emit(AgentEvents.RoleChanged, config.role, old);
    }

    // Global state
    if (this._state !== config.state) {
      const old = this._state;
      this._state = config.state;
      this.emit(AgentEvents.ActiveStateChanged, config.state, old);
    }

    // Model
    this._provider = config.provider;
    this._apiUrl = config.apiUrl;
    this._apiKey = config.apiKey;
    this._model = config.model;
    this._contextWindow = config.contextWindow;
    this._maxTurns = config.maxTurns ?? 25;
    this._temperature = config.temperature ?? 0.7;

    // Capabilities
    this._allowedTools = [...config.allowedTools];
    this._enabledSkills = [...config.enabledSkills];
    this._mcpServers = [...config.mcpServers];

    // Prompt
    this._agentPrompt = config.agentPrompt;
    this._preferredLanguage = config.preferredLanguage;
    this._conversationLanguage = config.conversationLanguage;

    this.emit(AgentEvents.ConfigUpdated, config);
    createLogger('anochat.agent').debug('Agent config updated', { aid: this.id });
  }

  // ── Serialization ──

  /** Produce an AgentConfig snapshot (useful for saving to disk). */
  toConfig(): AgentConfigWithKey {
    return {
      id: this.id,
      name: this._name,
      role: this._role,
      parentAgentId: this._parentAgentId,
      level: this._level,
      teamName: this.teamName,
      provider: this._provider,
      apiUrl: this._apiUrl,
      apiKey: this._apiKey,
      model: this._model,
      contextWindow: this._contextWindow,
      maxTurns: this._maxTurns,
      temperature: this._temperature,
      agentPrompt: this._agentPrompt,
      preferredLanguage: this._preferredLanguage,
      conversationLanguage: this._conversationLanguage,
      allowedTools: [...this._allowedTools],
      enabledSkills: [...this._enabledSkills],
      mcpServers: [...this._mcpServers],
      state: this._state,
      createdAt: this.createdAt,
    };
  }
}
