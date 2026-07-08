// ListEmployeesTool - list the current organization structure
// Returns the full org tree from the MainAgent down.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { OrgRole } from '../../../../shared/types/agent.js';
import type { Agent } from '../../agent/Agent.js';

interface EmployeeSummary {
  id: string;
  name: string;
  role: string;
  orgRole: OrgRole;
  parentAgentId: string | null;
  level: number;
  teamName: string;
  isActive: boolean;
  state: string;
  model: string;
  directReportCount: number;
  reportChain: string[];
  allowedTools: string[];
  enabledSkills: string[];
  mcpServers: string[];
}

interface EmployeeNode extends EmployeeSummary {
  children: EmployeeNode[];
  circularReference?: boolean;
}

export class ListEmployeesTool extends Tool {

  static category = 'Organization Management';
  static toolDescription = 'Lists all employees (agents) in the organization.';
  name(): string {
    return 'ListEmployees';
  }

  description(): string {
    return 'List the current organization structure. Shows the full agent hierarchy from the CEO down, including roles, teams, report chains, and agent status.';
  }

  prompt(): string {
    return '## ListEmployees Usage\n' +
      'See your organization chart. Shows all agents, their roles, teams, and reporting chains.\n\n' +
      '**When to use:** Before delegating (check who\'s available and what they specialize in). When planning team structure. When the user asks "who works for me?".\n\n' +
      'Use this BEFORE TaskAssign or HireEmployee. Know your team before you delegate or hire.';
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isReadOnly(): boolean {
    return true;
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const extraParams = Object.keys(params);
    if (extraParams.length > 0) {
      return this.makeError(`ListEmployees does not accept parameters: ${extraParams.join(', ')}`);
    }

    const registry = AgentRegistry.getInstance();
    const allAgents = registry.allAgents();
    const activeAgents = registry.activeAgents();
    const rootAgent = registry.mainAgent();
    const visited = new Set<string>();
    const cycleAgentIds = new Set<string>();
    const lines: string[] = [];
    let root: EmployeeNode | null = null;

    if (rootAgent) {
      root = this._buildOrgNode(rootAgent, registry, visited, cycleAgentIds);
      this._formatOrgNode(root, '', true, lines, new Set<string>());
    }

    const orphanedAgents = allAgents.filter((agent) => !visited.has(agent.id));
    if (orphanedAgents.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Orphaned or unreachable agents:');
      for (const agent of orphanedAgents) {
        const parent = agent.parentAgentId || '(none)';
        const active = agent.isActive ? '[active]' : '[destroyed]';
        lines.push(`- ${active} ${agent.name} (${agent.id}) parent=${parent} role=${agent.roleString}`);
      }
    }

    const summary =
      `Organization: ${allAgents.length} total agents` +
      ` (${activeAgents.length} active, ${allAgents.length - activeAgents.length} destroyed)` +
      `${rootAgent ? '' : ' - no MainAgent root registered'}` +
      `${orphanedAgents.length > 0 ? `, ${orphanedAgents.length} orphaned/unreachable` : ''}` +
      `${cycleAgentIds.size > 0 ? `, ${cycleAgentIds.size} circular reference(s) skipped` : ''}` +
      '\n\n';

    const content = lines.length > 0
      ? summary + lines.join('\n')
      : summary + '(organization is empty - no agents registered)';

    return this.makeResult(content, {
      structured: {
        totalAgents: allAgents.length,
        activeAgents: activeAgents.length,
        destroyedAgents: allAgents.length - activeAgents.length,
        hasMainAgent: Boolean(rootAgent),
        rootAgentId: rootAgent?.id ?? null,
        root,
        agents: allAgents.map((agent) => this._summarizeAgent(agent, registry)),
        orphanedAgents: orphanedAgents.map((agent) => this._summarizeAgent(agent, registry)),
        cycleAgentIds: [...cycleAgentIds],
        health: {
          orphanedCount: orphanedAgents.length,
          cycleCount: cycleAgentIds.size,
          status: !rootAgent
            ? 'missing_root'
            : orphanedAgents.length > 0 || cycleAgentIds.size > 0
              ? 'needs_attention'
              : 'ok',
        },
      },
    });
  }

  private _buildOrgNode(
    agent: Agent,
    registry: AgentRegistry,
    visited: Set<string>,
    cycleAgentIds: Set<string>,
  ): EmployeeNode {
    if (visited.has(agent.id)) {
      cycleAgentIds.add(agent.id);
      return {
        ...this._summarizeAgent(agent, registry),
        children: [],
        circularReference: true,
      };
    }

    visited.add(agent.id);
    const children = registry
      .agentsByParent(agent.id)
      .map((child) => this._buildOrgNode(child, registry, visited, cycleAgentIds));

    return {
      ...this._summarizeAgent(agent, registry),
      children,
    };
  }

  private _summarizeAgent(
    agent: Agent,
    registry: AgentRegistry,
  ): EmployeeSummary {
    return {
      id: agent.id,
      name: agent.name,
      role: agent.roleString,
      orgRole: registry.orgRole(agent.id),
      parentAgentId: agent.parentAgentId,
      level: agent.level,
      teamName: agent.teamName,
      isActive: agent.isActive,
      state: agent.state,
      model: agent.modelName,
      directReportCount: registry.agentsByParent(agent.id).length,
      reportChain: this._safeReportChain(agent, registry),
      allowedTools: agent.allowedTools(),
      enabledSkills: agent.enabledSkills(),
      mcpServers: agent.mcpServers(),
    };
  }

  private _safeReportChain(agent: Agent, registry: AgentRegistry): string[] {
    const chain: string[] = [];
    const seen = new Set<string>([agent.id]);
    let current: Agent | undefined = agent;

    while (current?.parentAgentId) {
      const parentId = current.parentAgentId;
      chain.unshift(parentId);

      if (seen.has(parentId)) break;
      seen.add(parentId);

      current = registry.agent(parentId);
      if (!current) break;
    }

    return chain;
  }

  private _formatOrgNode(
    node: EmployeeNode,
    prefix: string,
    isLast: boolean,
    lines: string[],
    visited: Set<string>,
  ): void {
    if (visited.has(node.id)) {
      lines.push(`${prefix}${isLast ? '`-- ' : '|-- '}${node.id} (circular reference - skipped)`);
      return;
    }
    visited.add(node.id);

    const status = node.isActive ? '[active]' : '[destroyed]';
    const connector = isLast ? '`-- ' : '|-- ';
    const roleLabel = node.orgRole === OrgRole.Manager ? '[Manager]' : '[Member]';
    const teamStr = node.teamName ? ` (${node.teamName})` : '';

    lines.push(
      `${prefix}${connector}${status} ${node.name} ${roleLabel}${teamStr} id=${node.id}`,
    );

    const childPrefix = prefix + (isLast ? '    ' : '|   ');

    for (let i = 0; i < node.children.length; i++) {
      const childNode = node.children[i];
      this._formatOrgNode(
        childNode,
        childPrefix,
        i === node.children.length - 1,
        lines,
        visited,
      );
    }
  }
}
