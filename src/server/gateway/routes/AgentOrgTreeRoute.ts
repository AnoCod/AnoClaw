// AgentOrgTreeRoute — returns full agent organization tree
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiToken } from '../ApiAuth.js';
import { sendJson } from '../RouteHelpers.js';
import { AgentRegistry } from '../../core/agent/AgentRegistry.js';
import type { Agent } from '../../core/agent/Agent.js';

interface TreeNode {
  agentId: string;
  parentAgentId: string | null;
  name: string;
  role: string;
  level: number;
  teamName: string;
  isActive: boolean;
  children: TreeNode[];
}

export class AgentOrgTreeRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/agents/org-tree';
  category = 'Agents';
  description = 'Get agent organization tree (CEO → Manager → Member)';

  handle(_match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): boolean {
    try {
      const reg = AgentRegistry.getInstance();
      const main = reg.mainAgent();
      if (!main) {
        sendJson(res, 200, null);
        return true;
      }
      const tree = this._buildNode(main, reg);
      sendJson(res, 200, tree);
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to build org tree', message: (err as Error).message });
    }
    return true;
  }

  private _buildNode(agent: Agent, reg: AgentRegistry): TreeNode {
    const children = reg.agentsByParent(agent.id);
    return {
      agentId: agent.id,
      parentAgentId: agent.parentAgentId,
      name: agent.name,
      role: agent.role,
      level: agent.level ?? 0,
      teamName: agent.teamName ?? '',
      isActive: agent.isActive,
      children: children.map(c => this._buildNode(c, reg)),
    };
  }
}
