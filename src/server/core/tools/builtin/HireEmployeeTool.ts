// HireEmployeeTool — create a new Agent in the organization
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

export class HireEmployeeTool extends Tool {

  static category = 'Organization Management';
  static toolDescription = 'Creates a new employee agent with specified role and configuration.';

  name(): string {
    return 'HireEmployee';
  }

  description(): string {
    return 'Create a new Agent (employee) in the organization. Only CEO and Managers can hire. '
      + 'Model, API URL, API key, provider, and context window are ALL inherited from you (the hiring agent) '
      + '— you do NOT need to specify them. The new agent gets your exact LLM connection config.';
  }

  prompt(): string {
    return '## HireEmployee — Creating Team Members\n'
      + '### Inheritance (automatic — you do NOT set these)\n'
      + 'Model, API URL, API key, provider, and context window are all inherited from you. '
      + 'The new agent connects to the same LLM backend with the same credentials.\n\n'
      + '### Naming Guidelines\n'
      + '- Use professional role-based names: "Frontend Engineer", "Security Auditor", "DevOps Lead"\n'
      + '- NOT generic names: "agent1", "helper", "worker"\n'
      + '- Name should reflect the agent\'s specialty and rank: "Senior Data Analyst", "QA Tester"\n\n'
      + '### Agent Prompt (system instructions)\n'
      + '- Write a clear role definition: "You are a senior frontend engineer specializing in React/TS."\n'
      + '- Define the agent\'s scope: what it CAN do and what it should NOT do\n'
      + '- Set expectations: quality bar, when to escalate, communication style\n'
      + '- Keep it focused — 3-8 lines. Overlong prompts confuse the agent.\n'
      + '- Example: "You are a QA tester. Your job is to write and run tests. You do NOT modify source code. '
      + 'Report bugs clearly with reproduction steps. Escalate if you find a security issue."\n\n'
      + '### Tool Allocation\n'
      + '- Give agents ONLY the tools they need for their job. Do NOT give every tool.\n'
      + '- Read-only agents (QA, reviewer, researcher): Read, Glob, Grep, WebFetch, WebSearch\n'
      + '- Code-writing agents (engineer, developer): add Write, Edit, Bash\n'
      + '- Team-lead agents (manager, architect): add TaskAssign, TaskList, TaskOutput, TaskStop\n'
      + '- NEVER give destructive tools (Bash rm -rf, etc.) to junior agents\n'
      + '- NEVER give HireEmployee or SubAgentSpawn to Members — only Managers may delegate\n\n'
      + '### Skills & MCP Servers\n'
      + '- Skills: assign relevant skills by name. Check available skills before assigning.\n'
      + '- MCP servers: only assign if the agent needs external API access (Slack, GitHub, etc.)\n'
      + '- When in doubt, leave enabledSkills and mcpServers empty — agents can ask for more later.\n\n'
      + '### Team Name\n'
      + '- Use descriptive team names: "Engineering", "QA", "Design", "Operations"\n'
      + '- Agents in the same team share a SharedContextStore for state sharing.';
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
          description: 'Your own agent ID — the new agent reports to you in the org tree',
        },
        model: {
          type: 'string',
          description: 'OPTIONAL. Leave blank to inherit your model. Only set this if the new agent '
            + 'needs a different model (e.g., cheaper model for simple tasks).',
        },
        agentPrompt: {
          type: 'string',
          description: 'System prompt defining the agent\'s identity and behavior. Must include: '
            + '(1) Role definition — who they are, (2) Scope — what they can/cannot do, '
            + '(3) Quality expectations, (4) Escalation rules. Keep it 3-8 lines — overlong prompts confuse agents. '
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
      return this.makeError(`Parent agent '${parentAgentId}' is destroyed — cannot hire under it`);
    }

    // Validate parent can manage subordinates
    if (!parent.isManagerRole()) {
      return this.makeError(
        `Agent '${parent.name}' (role: ${parent.roleString}) cannot have subordinates. Only MainAgent and Manager roles can hire.`,
      );
    }

    // Manager→Manager restriction ──
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

    // Build the agent config — inherit model/connection from parent
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
      const memDir = path.resolve(process.cwd(), 'memory', 'agents', agentId);
      await fs.promises.mkdir(memDir, { recursive: true });
      const memFile = path.join(memDir, 'MEMORY.md');
      await fs.promises.writeFile(
        memFile,
        `# ${name} — Memory\n\n*Created: ${new Date().toISOString()}*\n\n## Preferences\n\n## Learnings\n\n## References\n`,
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
