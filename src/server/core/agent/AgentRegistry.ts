// AgentRegistry — singleton registry for all Agent instances
// Extends EventEmitter. Provides CRUD, query, org tree, and persistence.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './Agent.js';
import { loadAgentConfig, saveAgentConfig } from './AgentConfig.js';
import type { OrgNode } from '../../../shared/types/agent.js';
import { AgentRole, OrgRole } from '../../../shared/types/agent.js';
import { AgentRegistryEvents } from '../../../shared/types/events.js';
import { PATHS } from '../../../shared/constants.js';
import { createLogger } from '../logger.js';
import type { ILogger } from '../interfaces/ILogger.js';

export class AgentRegistry extends EventEmitter {
  private _logger: ILogger | null = null;

  /** Inject a logger. When set, all log calls use this instead of LogManager singleton. */
  setLogger(logger: ILogger): void {
    this._logger = logger;
  }

  private get log(): ILogger {
    return this._logger || createLogger('anochat.agent');
  }
  // ── Singleton ──
  private static _instance: AgentRegistry | null = null;

  static getInstance(): AgentRegistry {
    if (!AgentRegistry._instance) {
      AgentRegistry._instance = new AgentRegistry();
    }
    return AgentRegistry._instance;
  }

  /** Reset the singleton (primarily for testing). */
  static resetInstance(): void {
    AgentRegistry._instance = null;
  }

  // ── Internal storage ──
  private _agents: Map<string, Agent> = new Map();

  private constructor() {
    super();
  }

  // ── CRUD ──

  /**
   * Register an Agent instance. Emits 'agentRegistered'. If an agent with the
   * same id already exists, it is replaced (emits 'agentUnregistered' for old, then 'agentRegistered' for new).
   */
  registerAgent(agent: Agent): void {
    const existing = this._agents.get(agent.id);
    if (existing) {
      // Clean up old instance
      existing.removeAllListeners();
      this.emit(AgentRegistryEvents.AgentUnregistered, { agentId: agent.id, previous: existing });
    }

    this._agents.set(agent.id, agent);
    this.emit(AgentRegistryEvents.AgentRegistered, { agentId: agent.id, agent });

    this.log.info('Agent registered', { aid: agent.id, name: agent.name, role: agent.role });

    // Listen to the agent's own events and re-emit relevant ones at registry level
    agent.on('statusChanged', (sessionId: string, status: string) => {
      this.emit(AgentRegistryEvents.AgentStatusChanged, {
        agentId: agent.id,
        sessionId,
        status,
      });
    });

    this.emit(AgentRegistryEvents.OrgTreeChanged);
  }

  /**
   * Unregister an agent by id. Emits 'agentUnregistered'.
   * Returns true if the agent was found and removed.
   */
  unregisterAgent(agentId: string): boolean {
    const agent = this._agents.get(agentId);
    if (!agent) return false;

    agent.removeAllListeners();
    this._agents.delete(agentId);
    this.emit(AgentRegistryEvents.AgentUnregistered, { agentId, previous: agent });
    this.emit(AgentRegistryEvents.OrgTreeChanged);
    this.log.info('Agent unregistered', { aid: agentId });
    return true;
  }

  /** Get an agent by id. */
  agent(agentId: string): Agent | undefined {
    return this._agents.get(agentId);
  }

  /**
   * Find an agent by ID first, then by name. The LLM may pass human-readable
   * names (e.g. "Research-Manager") rather than internal IDs ("manager-research").
   */
  findAgent(idOrName: string): Agent | undefined {
    // Try exact ID match first
    const byId = this._agents.get(idOrName);
    if (byId) return byId;
    // Try case-insensitive name match
    const lower = idOrName.toLowerCase();
    for (const a of this._agents.values()) {
      if (a.name.toLowerCase() === lower) return a;
    }
    return undefined;
  }

  /** Get all registered agents. */
  allAgents(): Agent[] {
    return Array.from(this._agents.values());
  }

  /** Get all active (non-destroyed) agents. */
  activeAgents(): Agent[] {
    return this.allAgents().filter((a) => a.isActive);
  }

  /** Number of registered agents. */
  get size(): number {
    return this._agents.size;
  }

  // ── Query ──

  /** Get agents directly reporting to the given parent. */
  agentsByParent(parentAgentId: string): Agent[] {
    return this.allAgents().filter(
      (a) => a.parentAgentId === parentAgentId,
    );
  }

  /** Get agents with a specific role. */
  agentsByRole(role: AgentRole): Agent[] {
    return this.allAgents().filter((a) => a.role === role);
  }

  /** Get the MainAgent, if any. */
  mainAgent(): Agent | undefined {
    return this.agentsByRole(AgentRole.MainAgent)[0] ?? undefined;
  }

  /** Check if an agent id exists in the registry. */
  hasAgent(agentId: string): boolean {
    return this._agents.has(agentId);
  }

  // ── Organization tree ──

  /** Build the full org tree starting from the MainAgent. */
  buildOrgTree(): OrgNode | null {
    const main = this.mainAgent();
    if (!main) return null;

    return this._buildOrgNode(main);
  }

  /** Get full report chain (from the given agent up to the CEO). */
  reportChain(agentId: string): string[] {
    const chain: string[] = [];
    let current = this._agents.get(agentId);
    while (current && current.parentAgentId) {
      chain.unshift(current.parentAgentId);
      current = this._agents.get(current.parentAgentId);
    }
    return chain;
  }

  /** Check whether an agent has any direct reports. */
  isManager(agentId: string): boolean {
    return this.agentsByParent(agentId).length > 0;
  }

  /** Get the org role (Manager | Member) for an agent based on whether they have reports. */
  orgRole(agentId: string): OrgRole {
    return this.isManager(agentId) ? OrgRole.Manager : OrgRole.Member;
  }

  // ── Persistence ──

  /**
   * Load all agent configs from data/agents/*.json into the registry.
   * Existing entries are replaced.
   */
  async loadFromDirectory(dirPath: string = path.resolve(process.cwd(), PATHS.agents)): Promise<void> {
    // Ensure directory exists
    await fs.promises.mkdir(dirPath, { recursive: true });

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      // Directory doesn't exist yet — nothing to load
      return;
    }

    const loadPromises = entries
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map(async (d) => {
        const agentId = d.name.replace(/\.json$/, '');
        try {
          const config = await loadAgentConfig(agentId);
          const agent = new Agent(config);
          this.registerAgent(agent);
        } catch (err) {
          this.log.warn('Failed to load agent config', { aid: agentId, error: (err as Error).message });
        }
      });

    await Promise.allSettled(loadPromises);
    this.log.info('Agents loaded from directory', { dir: dirPath, count: this._agents.size });
  }

  /**
   * Save an agent's config to data/agents/{agentId}.json.
   */
  async saveAgent(agentId: string): Promise<void> {
    const agent = this._agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found in registry: ${agentId}`);
    }
    const config = agent.toConfig();
    await saveAgentConfig(config);
    this.log.debug('Agent config saved', { aid: agentId });
  }

  // ── Private helpers ──

  private _buildOrgNode(agent: Agent): OrgNode {
    const children = this.agentsByParent(agent.id);
    return {
      agentId: agent.id,
      parentAgentId: agent.parentAgentId,
      level: agent.level,
      orgRole: children.length > 0 ? OrgRole.Manager : OrgRole.Member,
      teamName: agent.teamName,
      reportChain: this.reportChain(agent.id),
    };
  }
}
