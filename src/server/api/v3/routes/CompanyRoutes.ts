import type { V3CompanyApi } from '../Contracts.js';
import {
  assertAllowedFields,
  assertNonEmptyPatch,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  parseAfterRevision,
  parseExpectedRevision,
  readJsonObject,
  requestInput,
  requireOneString,
  requireString,
  type JsonObject,
} from '../HttpContract.js';
import type { V3Route } from '../Route.js';
import { resultResponse } from '../RouteSupport.js';
import { validationError } from '../ApiError.js';

const COMPANY_CREATE_FIELDS = ['name', 'description', 'defaultLocale'] as const;
const COMPANY_UPDATE_FIELDS = ['name', 'description', 'defaultLocale'] as const;
const TEAM_FIELDS = ['name', 'description', 'parentTeamId'] as const;
const MEMBER_FIELDS = ['agentId', 'membershipId', 'role', 'isPrimary'] as const;
const MEMBER_REMOVE_FIELDS = ['agentId', 'membershipId', 'force'] as const;
const AGENT_FIELDS = [
  'name',
  'description',
  'instructions',
  'status',
  'provider',
  'model',
  'credentialRef',
  'capabilities',
  'enabledSkills',
  'allowedTools',
] as const;
const WORKSPACE_FIELDS = ['name', 'rootPath', 'description'] as const;

export function companyRoutes(service: V3CompanyApi): V3Route[] {
  return [
    {
      method: 'GET',
      path: '/api/v3/company',
      async handle() {
        return resultResponse(await service.getCompany(), 200, 'Company');
      },
    },
    {
      method: 'POST',
      path: '/api/v3/company',
      async handle({ req }) {
        const body = await readJsonObject(req);
        validateCompany(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.createCompany(requestInput(body), expectedRevision),
          201,
          'Company',
        );
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/company',
      async handle({ req }) {
        const body = await readJsonObject(req);
        validateCompany(body, false);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateCompany(requestInput(body), expectedRevision),
          200,
          'Company',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/company/events',
      async handle({ url }) {
        return resultResponse(
          await service.listCompanyEvents(parseAfterRevision(url)),
          200,
          'Company',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/teams',
      async handle() {
        return resultResponse(await service.listTeams());
      },
    },
    {
      method: 'POST',
      path: '/api/v3/teams',
      async handle({ req }) {
        const body = await readJsonObject(req);
        validateTeam(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.createTeam(requestInput(body), expectedRevision),
          201,
          'Team',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/teams/:teamId',
      async handle({ params }) {
        return resultResponse(await service.getTeam(params.teamId), 200, 'Team');
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/teams/:teamId',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateTeam(body, false);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateTeam(params.teamId, requestInput(body), expectedRevision),
          200,
          'Team',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/teams/:teamId/archive',
      async handle({ req, params }) {
        const body = await readJsonObject(req, { allowEmpty: true });
        assertAllowedFields(body, ['reason', 'force']);
        optionalString(body, 'reason');
        optionalBoolean(body, 'force');
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.archiveTeam(params.teamId, requestInput(body), expectedRevision),
          200,
          'Team',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/teams/:teamId/members',
      async handle({ params }) {
        return resultResponse(
          await service.listTeamMembers(params.teamId),
          200,
          'Team',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/teams/:teamId/members',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateMember(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.addTeamMember(params.teamId, requestInput(body), expectedRevision),
          201,
          'Team',
        );
      },
    },
    {
      method: 'DELETE',
      path: '/api/v3/teams/:teamId/members',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        assertAllowedFields(body, MEMBER_REMOVE_FIELDS);
        optionalString(body, 'membershipId');
        optionalString(body, 'agentId');
        optionalBoolean(body, 'force');
        requireOneString(body, ['membershipId', 'agentId']);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.removeTeamMember(params.teamId, requestInput(body), expectedRevision),
          200,
          'Team',
        );
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/teams/:teamId/members',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateMember(body, false);
        requireOneString(body, ['membershipId', 'agentId']);
        if (body.role === undefined && body.isPrimary === undefined) {
          throw validationError('Team membership update requires role or isPrimary');
        }
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateTeamMember(params.teamId, requestInput(body), expectedRevision),
          200,
          'Team',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/agents',
      async handle() {
        return resultResponse(await service.listAgents());
      },
    },
    {
      method: 'POST',
      path: '/api/v3/agents',
      async handle({ req }) {
        const body = await readJsonObject(req);
        validateAgent(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.createAgent(requestInput(body), expectedRevision),
          201,
          'Agent',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/agents/:agentId',
      async handle({ params }) {
        return resultResponse(await service.getAgent(params.agentId), 200, 'Agent');
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/agents/:agentId',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateAgent(body, false);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateAgent(params.agentId, requestInput(body), expectedRevision),
          200,
          'Agent',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/agents/:agentId/archive',
      async handle({ req, params }) {
        const body = await readJsonObject(req, { allowEmpty: true });
        assertAllowedFields(body, ['reason']);
        optionalString(body, 'reason');
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.archiveAgent(params.agentId, requestInput(body), expectedRevision),
          200,
          'Agent',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/workspaces',
      async handle() {
        return resultResponse(await service.listWorkspaces());
      },
    },
    {
      method: 'POST',
      path: '/api/v3/workspaces',
      async handle({ req }) {
        const body = await readJsonObject(req);
        validateWorkspace(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.createWorkspace(requestInput(body), expectedRevision),
          201,
          'Workspace',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/workspaces/:workspaceId',
      async handle({ params }) {
        return resultResponse(
          await service.getWorkspace(params.workspaceId),
          200,
          'Workspace',
        );
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/workspaces/:workspaceId',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateWorkspace(body, false);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateWorkspace(
            params.workspaceId,
            requestInput(body),
            expectedRevision,
          ),
          200,
          'Workspace',
        );
      },
    },
  ];
}

function validateCompany(body: JsonObject, create: boolean): void {
  assertAllowedFields(body, create ? COMPANY_CREATE_FIELDS : COMPANY_UPDATE_FIELDS);
  if (create) requireString(body, 'name');
  else assertNonEmptyPatch(body);
  optionalString(body, 'name');
  optionalString(body, 'description');
  optionalString(body, 'defaultLocale');
}

function validateTeam(body: JsonObject, create: boolean): void {
  assertAllowedFields(body, TEAM_FIELDS);
  if (create) requireString(body, 'name');
  else assertNonEmptyPatch(body);
  for (const field of TEAM_FIELDS) optionalString(body, field);
}

function validateMember(body: JsonObject, add: boolean): void {
  assertAllowedFields(body, MEMBER_FIELDS);
  if (add) requireString(body, 'agentId');
  for (const field of ['agentId', 'membershipId', 'role']) optionalString(body, field);
  optionalBoolean(body, 'isPrimary');
}

function validateAgent(body: JsonObject, create: boolean): void {
  assertAllowedFields(body, AGENT_FIELDS);
  if (create) requireString(body, 'name');
  else assertNonEmptyPatch(body);
  for (const field of [
    'name',
    'description',
    'instructions',
    'status',
    'provider',
    'model',
    'credentialRef',
  ]) {
    optionalString(body, field);
  }
  for (const field of ['capabilities', 'enabledSkills', 'allowedTools']) {
    optionalStringArray(body, field);
  }
}

function validateWorkspace(body: JsonObject, create: boolean): void {
  assertAllowedFields(body, WORKSPACE_FIELDS);
  if (create) {
    requireString(body, 'name');
    requireString(body, 'rootPath');
  } else {
    assertNonEmptyPatch(body);
  }
  for (const field of WORKSPACE_FIELDS) optionalString(body, field);
}
