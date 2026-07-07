// AnoClaw Frontend — Agent ViewModel
// Manages agent list, selection, creation, deletion. Talks to /api/agents endpoints.

import { EventEmitter } from '../EventEmitter.js';
import type { AgentConfig } from '../types.js';
import { ClientLogger } from '../ClientLogger.js';

export interface AgentSelectionResult {
  ok: boolean;
  agentId?: string;
  message?: string;
}

export interface AgentConnectionTestRequest {
  agentId?: string;
  provider: string;
  apiUrl: string;
  apiKey?: string;
  model: string;
}

export interface AgentConnectionTestResult {
  ok: boolean;
  message: string;
  durationMs?: number;
}

export function agentRunnableProblem(agent: AgentConfig): string | null {
  if (agent.state && agent.state !== 'Active') {
    return `Agent '${agent.id}' is not active. Open Agents and reactivate or replace it before starting a session.`;
  }
  if (!agent.provider || !agent.provider.trim()) {
    return `Agent '${agent.name}' is missing a provider. Open Agents and configure its model connection.`;
  }
  if (!agent.model || !agent.model.trim()) {
    return `Agent '${agent.name}' is missing a model. Open Agents and configure its model connection.`;
  }
  if (!agent.apiUrl || !agent.apiUrl.trim()) {
    return `Agent '${agent.name}' is missing an API URL. Open Agents and configure its model connection.`;
  }
  return null;
}

export class AgentViewModel extends EventEmitter {
  agents: AgentConfig[] = [];
  selectedAgentId: string | null = null;
  lastError: string | null = null;
  private _wsUnsubscribe: (() => void) | null = null;
  private _loaded = false;
  private _loadingPromise: Promise<void> | null = null;

  /** Subscribe to real-time agent lifecycle events via WebSocket.
   *  Call once after WSClient connects. Keeps agent status in sync
   *  without polling. */
  subscribeToAgentEvents(wsClient: { on: (event: string, handler: (data: any) => void) => void; off: (event: string, handler: (data: any) => void) => void }): void {
    if (this._wsUnsubscribe) return;

    const onStatus = (data: { agentId: string; status: string; capabilities?: Record<string, unknown> }) => {
      if (!data?.agentId) return;
      const agent = this.getAgent(data.agentId);
      if (agent) {
        (agent as any)._status = data.status;
        this.emit('agentStatusChanged', data);
      }
      // If an agent was registered/created externally, reload
      if (data.status === 'registered') {
        this.loadAgents().catch(() => {});
      }
    };

    wsClient.on('agent_status', onStatus);

    // Listen for agent registered events to reload
    const onRegistered = () => this.loadAgents().catch(() => {});
    wsClient.on('agent_registered', onRegistered);

    // Listen for agent unregistered events to reload
    const onUnregistered = () => this.loadAgents().catch(() => {});
    wsClient.on('agent_unregistered', onUnregistered);

    // Listen for agent state/org/reload changes to refresh
    const onAgentChanged = () => this.loadAgents().catch(() => {});
    wsClient.on('agent_changed', onAgentChanged);

    // Listen for direct config updates from external API clients.
    const onAgentConfigUpdated = () => this.loadAgents().catch(() => {});
    wsClient.on('agent_config_updated', onAgentConfigUpdated);

    this._wsUnsubscribe = () => {
      wsClient.off('agent_status', onStatus);
      wsClient.off('agent_registered', onRegistered);
      wsClient.off('agent_unregistered', onUnregistered);
      wsClient.off('agent_changed', onAgentChanged);
      wsClient.off('agent_config_updated', onAgentConfigUpdated);
    };
  }

  unsubscribe(): void {
    if (this._wsUnsubscribe) {
      this._wsUnsubscribe();
      this._wsUnsubscribe = null;
    }
  }

  /** Load all agents from the backend */
  async loadAgents(): Promise<void> {
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = this._loadAgents();
    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  private async _loadAgents(): Promise<void> {
    try {
      const resp = await fetch('/api/v1/agents');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      // API returns {agents: [...], total: N}
      const data: AgentConfig[] = Array.isArray(raw) ? raw : (raw.agents || []);
      this.agents = data;
      this._loaded = true;
      this.emit('agentsLoaded', this.agents);
      ClientLogger.vm.info('Agents loaded', { count: this.agents.length });
    } catch (e) {
      ClientLogger.vm.error('Failed to load agents', { error: (e as Error).message });
      throw e;
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await this.loadAgents();
  }

  selectRunnableAgent(requestedAgentId?: string): AgentSelectionResult {
    const requested = (requestedAgentId || '').trim();

    if (requested) {
      const agent = this.getAgent(requested);
      if (!agent) {
        return {
          ok: false,
          message: `Agent '${requested}' is not configured. Open Agents and create or select a valid agent before starting a session.`,
        };
      }
      const problem = agentRunnableProblem(agent);
      if (problem) return { ok: false, message: problem };
      return { ok: true, agentId: agent.id };
    }

    const mainAgent = this.agents.find((agent) => agent.role === 'MainAgent');
    if (mainAgent && !agentRunnableProblem(mainAgent)) return { ok: true, agentId: mainAgent.id };

    const fallback = this.agents.find((agent) => !agentRunnableProblem(agent));
    if (fallback) return { ok: true, agentId: fallback.id };

    const anyAgent = this.agents[0];
    if (anyAgent) {
      return {
        ok: false,
        message: agentRunnableProblem(anyAgent) || 'No runnable agent is configured. Open Agents and configure a model connection before starting a session.',
      };
    }

    return {
      ok: false,
      message: 'No agents are configured. Open Agents, create a CEO/MainAgent, and configure its model connection before starting a session.',
    };
  }

  agentRunnableProblem(agent: AgentConfig): string | null {
    return agentRunnableProblem(agent);
  }

  /** Get a single agent by id */
  getAgent(id: string): AgentConfig | undefined {
    return this.agents.find((a) => a.id === id);
  }

  /** Get children of an agent (for org tree) */
  getChildren(parentId: string): AgentConfig[] {
    return this.agents.filter((a) => a.parentAgentId === parentId);
  }

  /** Get root-level agents */
  getRoots(): AgentConfig[] {
    return this.agents.filter((a) => !a.parentAgentId);
  }

  /** Select an agent for editing */
  selectAgent(id: string): void {
    this.selectedAgentId = id;
    const agent = this.getAgent(id);
    if (agent) {
      this.emit('agentSelected', agent);
    }
  }

  /** Create a new agent */
  async createAgent(config: Partial<AgentConfig> & { apiKey?: string }): Promise<AgentConfig | null> {
    try {
      this.lastError = null;
      const resp = await fetch('/api/v1/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!resp.ok) throw new Error(await this._responseError(resp));
      const created: AgentConfig = await resp.json();
      this.agents.push(created);
      this.emit('agentCreated', created);
      this.emit('agentsChanged', this.agents);
      return created;
    } catch (e) {
      this.lastError = (e as Error).message;
      ClientLogger.vm.error('Failed to create agent', { error: (e as Error).message });
      return null;
    }
  }

  async testConnection(config: AgentConnectionTestRequest): Promise<AgentConnectionTestResult> {
    try {
      const resp = await fetch('/api/v1/agents/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const body = await resp.json().catch(() => ({})) as { ok?: boolean; message?: string; durationMs?: number };
      if (!resp.ok || body.ok === false) {
        return {
          ok: false,
          message: body.message || `Connection test failed with HTTP ${resp.status}`,
          durationMs: body.durationMs,
        };
      }
      return {
        ok: true,
        message: body.message || 'Model connection verified',
        durationMs: body.durationMs,
      };
    } catch (e) {
      ClientLogger.vm.error('Failed to test agent connection', { error: (e as Error).message });
      return { ok: false, message: (e as Error).message || 'Connection test failed' };
    }
  }

  /** Update an existing agent */
  async updateAgent(id: string, patch: Partial<AgentConfig> & { apiKey?: string }): Promise<boolean> {
    try {
      this.lastError = null;
      const resp = await fetch(`/api/v1/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) throw new Error(await this._responseError(resp));

      const getResp = await fetch(`/api/v1/agents/${id}`);
      if (!getResp.ok) throw new Error(`HTTP ${getResp.status}`);
      const updated: AgentConfig = await getResp.json();

      const idx = this.agents.findIndex((a) => a.id === id);
      if (idx !== -1) {
        this.agents[idx] = updated;
      } else {
        this.agents.push(updated);
      }
        this.emit('agentUpdated', updated);
        this.emit('agentsChanged', this.agents);
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      ClientLogger.vm.error('Failed to update agent', { aid: id, error: (e as Error).message });
      return false;
    }
  }

  private async _responseError(resp: Response): Promise<string> {
    try {
      const body = await resp.json() as { message?: string; error?: string };
      return body.message || body.error || `HTTP ${resp.status}`;
    } catch {
      return `HTTP ${resp.status}`;
    }
  }

  /** Delete an agent. Use cascade=true to also delete all descendants. */
  async deleteAgent(id: string, cascade = false): Promise<boolean> {
    try {
      this.lastError = null;
      const url = cascade ? `/api/v1/agents/${id}?cascade=true` : `/api/v1/agents/${id}`;
      const resp = await fetch(url, { method: 'DELETE' });
      if (!resp.ok) throw new Error(await this._responseError(resp));
      const body = await resp.json().catch(() => ({})) as { deletedAgentIds?: string[] };
      const deletedIds = new Set<string>(body.deletedAgentIds || []);
      if (deletedIds.size === 0) deletedIds.add(id);

      if (cascade && deletedIds.size === 1) {
        // Collect all descendant IDs to remove from local state
        const collectDescendants = (parentId: string) => {
          for (const a of this.agents) {
            if (a.parentAgentId === parentId && !deletedIds.has(a.id)) {
              deletedIds.add(a.id);
              collectDescendants(a.id);
            }
          }
        };
        collectDescendants(id);
      }
      this.agents = this.agents.filter((a) => !deletedIds.has(a.id));
      if (this.selectedAgentId && deletedIds.has(this.selectedAgentId)) {
        this.selectedAgentId = null;
      }
      this.emit('agentDeleted', id);
      this.emit('agentsChanged', this.agents);
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      ClientLogger.vm.error('Failed to delete agent', { aid: String(id), error: (e as Error).message });
      return false;
    }
  }

  /** Build a tree structure from flat agent list */
  buildTree(): AgentConfig[] {
    const childrenMap = new Map<string, AgentConfig[]>();
    for (const agent of this.agents) {
      const pid = agent.parentAgentId || '__root__';
      const list = childrenMap.get(pid) || [];
      list.push(agent);
      childrenMap.set(pid, list);
    }
    // We don't nest into parent objects; return roots for rendering
    return childrenMap.get('__root__') || [];
  }

  get selectedAgent(): AgentConfig | undefined {
    if (!this.selectedAgentId) return undefined;
    return this.getAgent(this.selectedAgentId);
  }
}
