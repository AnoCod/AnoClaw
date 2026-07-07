// HireEmployeeTool - create a new Agent in the organization
// Only CEO and Managers can hire. Creates an Agent, registers with
// AgentRegistry, and persists config to disk.

import { Tool, RiskLevel, InterruptBehavior } from '../Tool.js';
import type { ToolResult } from '../Tool.js';
import type { ExecutionContext } from '../../../../shared/types/session.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { Agent } from '../../agent/Agent.js';
import { AgentRole, AgentState } from '../../../../shared/types/agent.js';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../logger.js';
import { writablePath } from '../../../infra/WritablePath.js';

export class HireEmployeeTool extends Tool {

  static category = 'Organization Management';
  static toolDescription = 'Creates a durable Manager or Member agent in the organization.';

  name(): string {
    return 'HireEmployee';
  }

  description(): string {
    return 'Create a durable employee agent. Use this only when the organization needs persistent specialist or manager capacity. LLM connection settings are inherited from the hiring agent unless explicitly overridden.';
  }

  prompt(): string {
    return [
      '## HireEmployee Usage',
      'Hire only for durable responsibilities, not for a one-off task. Use SubAgentSpawn for temporary helpers and TaskAssign for existing employees.',
      '',
      'Good hires have:',
      '- A professional role-based name, such as Frontend Engineer, QA Tester, or Security Auditor.',
      '- A narrow durable specialty and clear scope boundaries.',
      '- A concise agentPrompt: identity, scope, quality bar, escalation rules, and communication style.',
      '- Only the tools and skills needed for the role.',
      '',
      'Org rules:',
      '- MainAgent may hire Managers or Members.',
      '- Managers should hire Members, not other Managers.',
      '- Members execute work and should not receive organization-management tools.',
      '',
      'Tool allocation guidance:',
      '- Read-only reviewers: Read, Glob, Grep, WebFetch, WebSearch.',
      '- Code implementers: add Write, Edit, Bash where appropriate.',
      '- Team leads: add TaskAssign, TaskList, TaskOutput, TaskStop.',
      '- Avoid broad destructive capability unless the role truly needs it.',
    ].join('\n');
  }

  minRole(): string { return 'Manager'; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Professional role-based display name. Use job titles like "Frontend Engineer", '
            + '"Security Auditor", "DevOps Lead". NOT generic "agent1" or "helper".',
        },
        role: {
          type: 'string',
          enum: ['Manager', 'Member'],
          description: 'Organization role: Manager (can hire and assign tasks) or Member (executes work)',
        },
        parentAgentId: {
          type: 'string',
          description: 'Your own agent ID - the new agent reports to you in the org tree',
        },
        model: {
          type: 'string',
          description: 'OPTIONAL. Leave blank to inherit your model. Only set this if the new agent '
            + 'needs a different model (e.g., cheaper model for simple tasks).',
        },
        agentPrompt: {
          type: 'string',
          description: 'System prompt defining the agent\'s identity and behavior. Must include: '
            + '(1) Role definition - who they are, (2) Scope - what they can/cannot do, '
            + '(3) Quality expectations, (4) Escalation rules. Keep it 3-8 lines - overlong prompts confuse agents. '
            + 'Example: "You are a senior QA tester. Write and run tests. Do NOT modify source code. '
            + 'Report bugs with reproduction steps. Escalate security issues immediately."',
        },
        teamName: {
          type: 'string',
          description: 'Team name for grouping. Defaults to your team. '
            + 'Use descriptive names: "Engineering", "QA", "Design".',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tools the agent can use. Give ONLY what\'s needed for their job. '
            + 'Read-only roles: Read, Glob, Grep, WebFetch, WebSearch. '
            + 'Code roles: add Write, Edit, Bash. '
            + 'Team leads: add TaskAssign, TaskList, TaskOutput, TaskStop. '
            + 'NEVER give HireEmployee/SubAgentSpawn to Members. '
            + 'Defaults to your tools if left empty.',
        },
        enabledSkills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skill names to enable. Check available skills first. Leave empty if unsure.',
        },
        mcpServers: {
          type: 'array',
          items: { type: 'string' },
          description: 'MCP server names for external API access. Leave empty unless the agent needs external services.',
        },
        reason: {
          type: 'string',
          description: 'Business justification: what this agent will do and why they\'re needed',
        },
      },
      required: ['name', 'role', 'parentAgentId', 'agentPrompt', 'reason'],
    };
  }

  riskLevel(): RiskLevel {
    return RiskLevel.High;
  }

  interruptBehavior(): InterruptBehavior {
    return InterruptBehavior.Block;
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const name = params.name as string;
    const roleStr = params.role as string;
    const parentAgentId = params.parentAgentId as string;
    const agentPrompt = params.agentPrompt as string;
    const reason = params.reason as string;
    const teamName = (params.teamName as string) || '';
    const registry = AgentRegistry.getInstance();

    // Validate parent exists
    const parent = registry.findAgent(parentAgentId);
    if (!parent) {
      return this.makeError(`Parent agent '${parentAgentId}' not found in registry`);
    }

    // Model: inherit from parent if not specified
    const model = (params.model as string) || parent.modelName;

    const allowedTools = (params.allowedTools as string[])?.length
      ? (params.allowedTools as string[])
      : [...parent.allowedTools()];
    const enabledSkills = (params.enabledSkills as string[]) || [];
    const mcpServers = (params.mcpServers as string[]) || [];

    if (!parent.isActive) {
      return this.makeError(`Parent agent '${parentAgentId}' is destroyed - cannot hire under it`);
    }

    // Validate parent can manage subordinates
    if (!parent.isManagerRole()) {
      return this.makeError(
        `Agent '${parent.name}' (role: ${parent.roleString}) cannot have subordinates. Only MainAgent and Manager roles can hire.`,
      );
    }

    // Manager->Manager restriction ──
    // Only the CEO (MainAgent) can create Managers. Managers can only create Members.
    if (roleStr === 'Manager' && parent.role !== AgentRole.MainAgent) {
      return this.makeError(
        `Only the CEO (MainAgent) can create Manager-level agents. ` +
        `'${parent.name}' is a ${parent.roleString}, not the MainAgent.`,
      );
    }

    // Determine agent role
    const role: AgentRole =
      roleStr === 'Manager' ? AgentRole.Manager : AgentRole.Member;

    // Generate a unique ID
    const agentId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // Determine level based on parent
    const level = parent.level + 1;

    // Build the agent config - inherit model/connection from parent
    const config = {
      id: agentId,
      name,
      role,
      parentAgentId,
      level,
      teamName: teamName || parent.teamName,
      provider: parent.provider,
      apiUrl: parent.apiUrl,
      apiKey: parent.apiKey,
      model,
      contextWindow: parent.contextWindow,
      maxTurns: parent.maxTurns,
      temperature: parent.temperature,
      agentPrompt,
      preferredLanguage: parent.preferredLanguage,
      conversationLanguage: parent.conversationLanguage,
      allowedTools,
      enabledSkills,
      mcpServers,
      state: AgentState.Active,
      createdAt: new Date().toISOString(),
    };

    // Create and register the new agent
    const agent = new Agent(config);
    registry.registerAgent(agent);

    // Persist config to disk
    try {
      await registry.saveAgent(agentId);
    } catch (err) {
      // Rollback registration on persistence failure
      registry.unregisterAgent(agentId);
      const msg = err instanceof Error ? err.message : String(err);
      return this.makeError(`Failed to persist agent config: ${msg}`);
    }

    // Initialize memory directory ──
    try {
      const memDir = writablePath('memory', 'agents', agentId);
      await fs.promises.mkdir(memDir, { recursive: true });
      const memFile = path.join(memDir, 'MEMORY.md');
      await fs.promises.writeFile(
        memFile,
        `# ${name} - Memory\n\n*Created: ${new Date().toISOString()}*\n\n## Preferences\n\n## Learnings\n\n## References\n`,
        'utf-8',
      );
    } catch (err) {
      // Non-fatal: agent is created, memory init can be retried later
      createLogger('anochat.tools').warn('Failed to init memory for hired agent', { aid: agentId, error: (err as Error).message });
    }

    const inherited = model === parent.modelName
      ? ` (inherited: provider=${parent.provider}, model=${model}, contextWindow=${parent.contextWindow}, apiUrl=${parent.apiUrl})`
      : ` (model overridden: ${model}. Inherited: provider=${parent.provider}, contextWindow=${parent.contextWindow}, apiUrl=${parent.apiUrl})`;

    const orgRoleLabel = role === AgentRole.Manager ? 'Manager' : 'Member';
    return this.makeResult(
      `Agent "${name}" (${orgRoleLabel}) hired successfully under "${parent.name}".\n` +
        `ID: ${agentId}\n` +
        `Reason: ${reason}\n` +
        `Team: ${teamName || parent.teamName || '(none)'}` +
        inherited,
    );
  }
}
