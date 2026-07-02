// AnoClaw Frontend — Agent ViewModel
// Manages agent list, selection, creation, deletion. Talks to /api/agents endpoints.

import { EventEmitter } from '../EventEmitter.js';
import type { AgentConfig } from '../types.js';
import { ClientLogger } from '../ClientLogger.js';

export class AgentViewModel extends EventEmitter {
  agents: AgentConfig[] = [];
  selectedAgentId: string | null = null;
  private _wsUnsubscribe: (() => void) | null = null;

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
        this.loadAgents();
      }
    };

    wsClient.on('agent_status', onStatus);

    this._wsUnsubscribe = () => {
      wsClient.off('agent_status', onStatus);
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
    try {
      const resp = await fetch('/api/v1/agents');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw = await resp.json();
      // API returns {agents: [...], total: N}
      const data: AgentConfig[] = Array.isArray(raw) ? raw : (raw.agents || []);
      this.agents = data;
      this.emit('agentsLoaded', this.agents);
      ClientLogger.vm.info('Agents loaded', { count: this.agents.length });
    } catch (e) {
      ClientLogger.vm.error('Failed to load agents', { error: (e as Error).message });
    }
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
      const resp = await fetch('/api/v1/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const created: AgentConfig = await resp.json();
      this.agents.push(created);
      this.emit('agentCreated', created);
      this.emit('agentsChanged', this.agents);
      return created;
    } catch (e) {
      ClientLogger.vm.error('Failed to create agent', { error: (e as Error).message });
      return null;
    }
  }

  /** Update an existing agent */
  async updateAgent(id: string, patch: Partial<AgentConfig> & { apiKey?: string }): Promise<boolean> {
    try {
      const resp = await fetch(`/api/v1/agents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const updated: AgentConfig = await resp.json();
      const idx = this.agents.findIndex((a) => a.id === id);
      if (idx !== -1) {
        this.agents[idx] = updated;
        this.emit('agentUpdated', updated);
        this.emit('agentsChanged', this.agents);
      }
      return true;
    } catch (e) {
      ClientLogger.vm.error('Failed to update agent', { aid: id, error: (e as Error).message });
      return false;
    }
  }

  /** Delete an agent. Use cascade=true to also delete all descendants. */
  async deleteAgent(id: string, cascade = false): Promise<boolean> {
    try {
      const url = cascade ? `/api/v1/agents/${id}?cascade=true` : `/api/v1/agents/${id}`;
      const resp = await fetch(url, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      if (cascade) {
        // Collect all descendant IDs to remove from local state
        const descendantIds = new Set<string>();
        const collectDescendants = (parentId: string) => {
          for (const a of this.agents) {
            if (a.parentAgentId === parentId && !descendantIds.has(a.id)) {
              descendantIds.add(a.id);
              collectDescendants(a.id);
            }
          }
        };
        collectDescendants(id);
        descendantIds.add(id);
        this.agents = this.agents.filter((a) => !descendantIds.has(a.id));
      } else {
        this.agents = this.agents.filter((a) => a.id !== id);
      }
      if (this.selectedAgentId === id) {
        this.selectedAgentId = null;
      }
      this.emit('agentDeleted', id);
      this.emit('agentsChanged', this.agents);
      return true;
    } catch (e) {
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
