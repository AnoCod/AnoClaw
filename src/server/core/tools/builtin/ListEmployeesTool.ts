// ListEmployeesTool - list the current organization structure
// Returns the full org tree from the MainAgent down.

import { Tool, RiskLevel } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { OrgRole } from '../../../../shared/types/agent.js';

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
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.Safe;
  }

  isReadOnly(): boolean {
    return true;
  }

  async execute(
    _params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const registry = AgentRegistry.getInstance();
    const root = registry.buildOrgTree();

    if (!root) {
      return this.makeResult(
        '(organization is empty - no MainAgent registered)',
      );
    }

    // Build a readable text tree
    const lines: string[] = [];
    this._formatOrgNode(root, registry, '', true, lines, new Set<string>());

    const allAgents = registry.allAgents();
    const summary =
      `Organization: ${allAgents.length} total agents` +
      ` (${registry.activeAgents().length} active, ${allAgents.length - registry.activeAgents().length} destroyed)\n\n`;

    return this.makeResult(summary + lines.join('\n'));
  }

  private _formatOrgNode(
    node: any,
    registry: AgentRegistry,
    prefix: string,
    isLast: boolean,
    lines: string[],
    visited: Set<string>,
  ): void {
    if (visited.has(node.agentId)) {
      lines.push(`${prefix}${isLast ? '`-- ' : '|-- '}${node.agentId} (circular reference - skipped)`);
      return;
    }
    visited.add(node.agentId);

    const agent = registry.agent(node.agentId);
    const status = agent?.isActive ? '[active]' : '◌';
    const connector = isLast ? '`-- ' : '|-- ';
    const roleLabel = node.orgRole === OrgRole.Manager ? '[Manager]' : '[Member]';
    const teamStr = node.teamName ? ` (${node.teamName})` : '';

    lines.push(
      `${prefix}${connector}${status} ${agent?.name ?? node.agentId} ${roleLabel}${teamStr}`,
    );

    const children = registry.agentsByParent(node.agentId);
    const childPrefix = prefix + (isLast ? '    ' : '|   ');

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childNode = {
        agentId: child.id,
        parentAgentId: child.parentAgentId,
        level: child.level,
        orgRole: registry.orgRole(child.id),
        teamName: child.teamName,
        reportChain: registry.reportChain(child.id),
      };
      this._formatOrgNode(
        childNode,
        registry,
        childPrefix,
        i === children.length - 1,
        lines,
        visited,
      );
    }
  }
}
