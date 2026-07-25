import { Tool, RiskLevel } from '../Tool.js';
import type { ExecutionContext, ToolResult } from '../Tool.js';
import {
  InternalV3OrganizationApiAdapter,
  type NewPersistentAgent,
  type V3OrganizationApi,
} from '../v3/V3OrganizationApiAdapter.js';
import { RETIRED_ORGANIZATION_TOOL_NAMES } from '../v3/RetiredOrganizationTools.js';
import {
  assertAllowedKeys,
  membershipRole,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  organizationToolFailure,
  requiredObject,
  requiredString,
  V3OrganizationToolInputError,
} from '../v3/V3OrganizationToolSupport.js';

const NEW_AGENT_FIELDS = [
  'name',
  'description',
  'instructions',
  'provider',
  'model',
  'credentialRef',
  'capabilities',
  'enabledSkills',
  'allowedTools',
] as const;

export class TeamMemberAddTool extends Tool {
  static category = 'Persistent Teams';
  static toolDescription = 'Adds an existing Agent or creates and joins one persistent Agent.';

  constructor(private readonly api: V3OrganizationApi = new InternalV3OrganizationApiAdapter()) {
    super();
  }

  name(): string { return 'TeamMemberAdd'; }

  description(): string {
    return 'Add an existing persistent Agent to a Team, or create one Agent and immediately add its primary membership.';
  }

  prompt(): string {
    return [
      'Pass agentId to add an existing persistent Agent.',
      'Pass newAgent instead to create exactly one persistent Agent and its primary Team membership as one tool action.',
      'Do not pass an organization role, parent agent, reporting line, or hierarchy level.',
    ].join('\n');
  }

  riskLevel(): RiskLevel { return RiskLevel.Medium; }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        teamId: { type: 'string', minLength: 1, maxLength: 200 },
        agentId: { type: 'string', minLength: 1, maxLength: 200 },
        newAgent: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', minLength: 1, maxLength: 4000 },
            instructions: { type: 'string', minLength: 1, maxLength: 16000 },
            provider: { type: 'string', minLength: 1, maxLength: 200 },
            model: { type: 'string', minLength: 1, maxLength: 200 },
            credentialRef: { type: 'string', minLength: 1, maxLength: 500 },
            capabilities: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 200 },
              maxItems: 100,
            },
            enabledSkills: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 200 },
              maxItems: 100,
            },
            allowedTools: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 200 },
              maxItems: 200,
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
        membershipRole: { type: 'string', enum: ['leader', 'member'] },
        isPrimary: {
          type: 'boolean',
          description: 'Existing Agent membership only. New Agents always receive a primary membership.',
        },
      },
      required: ['teamId'],
      oneOf: [
        { required: ['agentId'], not: { required: ['newAgent'] } },
        { required: ['newAgent'], not: { required: ['agentId'] } },
      ],
      additionalProperties: false,
    };
  }

  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<ToolResult> {
    try {
      const teamId = requiredString(params.teamId, 'teamId', 200);
      const agentId = optionalString(params.agentId, 'agentId', 200);
      const newAgentValue = params.newAgent;
      if ((!agentId && newAgentValue == null) || (agentId && newAgentValue != null)) {
        throw new V3OrganizationToolInputError(
          'Provide exactly one of agentId or newAgent',
          { fields: ['agentId', 'newAgent'] },
        );
      }
      const role = membershipRole(params.membershipRole);

      if (agentId) {
        const isPrimary = optionalBoolean(params.isPrimary, 'isPrimary') ?? false;
        const result = await this.api.addTeamMember(teamId, {
          agentId,
          role,
          isPrimary,
        });
        return this.makeResult(`Agent ${agentId} added to persistent Team ${teamId}.`, {
          structured: {
            membership: result.data,
            revision: result.revision,
            createdAgent: false,
          },
        });
      }

      if (params.isPrimary === false) {
        throw new V3OrganizationToolInputError(
          'A newly created Agent must receive a primary Team membership',
          { field: 'isPrimary' },
        );
      }
      const newAgent = parseNewAgent(requiredObject(newAgentValue, 'newAgent'));
      const result = await this.api.createAgentWithPrimaryMembership(teamId, newAgent, role);
      return this.makeResult(
        `Persistent Agent "${result.agent.name}" created and joined to Team ${teamId}.`,
        {
          structured: {
            agent: result.agent,
            membership: result.membership,
            revision: result.revision,
            createdAgent: true,
          },
        },
      );
    } catch (error) {
      return organizationToolFailure(error);
    }
  }
}

function parseNewAgent(input: Record<string, unknown>): NewPersistentAgent {
  assertAllowedKeys(input, NEW_AGENT_FIELDS, 'newAgent');
  const allowedTools = optionalStringArray(input.allowedTools, 'newAgent.allowedTools', {
    maxItems: 200,
    maxLength: 200,
  });
  const retiredTools = allowedTools?.filter((name) =>
    RETIRED_ORGANIZATION_TOOL_NAMES.has(name)
  ) ?? [];
  if (retiredTools.length > 0) {
    throw new V3OrganizationToolInputError(
      `newAgent.allowedTools contains retired tools: ${retiredTools.join(', ')}`,
      { field: 'newAgent.allowedTools', retiredTools },
    );
  }
  return {
    name: requiredString(input.name, 'newAgent.name', 120),
    ...optionalField(input, 'description', 4_000),
    ...optionalField(input, 'instructions', 16_000),
    ...optionalField(input, 'provider', 200),
    ...optionalField(input, 'model', 200),
    ...optionalField(input, 'credentialRef', 500),
    ...optionalArrayField(input, 'capabilities', 100),
    ...optionalArrayField(input, 'enabledSkills', 100),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

function optionalField(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): Record<string, string> {
  const value = optionalString(input[field], `newAgent.${field}`, maxLength);
  return value ? { [field]: value } : {};
}

function optionalArrayField(
  input: Record<string, unknown>,
  field: string,
  maxItems: number,
): Record<string, string[]> {
  const value = optionalStringArray(input[field], `newAgent.${field}`, {
    maxItems,
    maxLength: 200,
  });
  return value ? { [field]: value } : {};
}
