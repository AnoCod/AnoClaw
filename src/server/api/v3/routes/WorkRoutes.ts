import type { V3WorkApi } from '../Contracts.js';
import { validationError } from '../ApiError.js';
import {
  assertAllowedFields,
  assertNonEmptyPatch,
  optionalBoolean,
  optionalNonNegativeInteger,
  optionalObject,
  optionalString,
  optionalStringArray,
  parseAfterRevision,
  parseExpectedRevision,
  parseNonNegativeQuery,
  readJsonObject,
  requestInput,
  requirePositiveInteger,
  requireString,
  type JsonObject,
} from '../HttpContract.js';
import type { V3Route } from '../Route.js';
import { resultResponse } from '../RouteSupport.js';

const WORK_CREATE_FIELDS = [
  'workspaceId',
  'primarySessionId',
  'agentId',
  'title',
  'objective',
  'status',
] as const;
const WORK_UPDATE_FIELDS = [
  'workspaceId',
  'focusMissionId',
  'title',
  'objective',
  'status',
] as const;
const MISSION_FIELDS = [
  'title',
  'objective',
  'acceptanceCriteria',
  'priority',
  'verificationPolicy',
  'status',
  'teamId',
  'ownerAgentId',
] as const;
const TASK_FIELDS = [
  'title',
  'description',
  'acceptanceCriteria',
  'status',
  'priority',
  'teamId',
  'assignedAgentId',
  'dependsOnTaskIds',
  'readOnly',
  'writeScope',
  'dueAt',
] as const;
const MESSAGE_FIELDS = [
  'id',
  'role',
  'content',
  'agentId',
  'toolCallId',
  'toolName',
  'metadata',
] as const;

export function workRoutes(service: V3WorkApi): V3Route[] {
  return [
    {
      method: 'GET',
      path: '/api/v3/works',
      async handle() {
        return resultResponse(await service.listWorks());
      },
    },
    {
      method: 'POST',
      path: '/api/v3/works',
      async handle({ req }) {
        const body = await readJsonObject(req);
        validateWork(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.createWork(requestInput(body), expectedRevision),
          201,
          'Work',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/works/:workId',
      async handle({ params }) {
        return resultResponse(await service.getWork(params.workId), 200, 'Work');
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/works/:workId',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateWork(body, false);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateWork(params.workId, requestInput(body), expectedRevision),
          200,
          'Work',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/works/:workId/events',
      async handle({ params, url }) {
        return resultResponse(
          await service.listWorkEvents(params.workId, parseAfterRevision(url)),
          200,
          'Work',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/works/:workId/missions',
      async handle({ params }) {
        return resultResponse(
          await service.listMissions(params.workId),
          200,
          'Work',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/works/:workId/missions',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateMission(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.createMission(params.workId, requestInput(body), expectedRevision),
          201,
          'Work',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/missions/:missionId',
      async handle({ params }) {
        return resultResponse(
          await service.getMission(params.missionId),
          200,
          'Mission',
        );
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/missions/:missionId',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateMission(body, false);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateMission(
            params.missionId,
            requestInput(body),
            expectedRevision,
          ),
          200,
          'Mission',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/missions/:missionId/tasks',
      async handle({ params }) {
        return resultResponse(
          await service.listTasks(params.missionId),
          200,
          'Mission',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/missions/:missionId/tasks',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateTask(body, true);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.createTask(params.missionId, requestInput(body), expectedRevision),
          201,
          'Mission',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/tasks/:taskId',
      async handle({ params }) {
        return resultResponse(await service.getTask(params.taskId), 200, 'Task');
      },
    },
    {
      method: 'PATCH',
      path: '/api/v3/tasks/:taskId',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateTask(body, false);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.updateTask(params.taskId, requestInput(body), expectedRevision),
          200,
          'Task',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/tasks/:taskId/assign',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        assertAllowedFields(body, ['agentId']);
        requireString(body, 'agentId');
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.assignTask(params.taskId, requestInput(body), expectedRevision),
          200,
          'Task',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/tasks/:taskId/claim',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        assertAllowedFields(body, ['agentId', 'sessionId', 'maxTurns']);
        requireString(body, 'agentId');
        requireString(body, 'sessionId');
        requirePositiveInteger(body, 'maxTurns');
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.claimTask(params.taskId, requestInput(body), expectedRevision),
          200,
          'Task',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/tasks/:taskId/retry',
      async handle({ req, params }) {
        const body = await readJsonObject(req, { allowEmpty: true });
        assertAllowedFields(body, ['agentId', 'sessionId', 'maxTurns']);
        optionalString(body, 'agentId');
        optionalString(body, 'sessionId');
        if (body.maxTurns !== undefined) requirePositiveInteger(body, 'maxTurns');
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.retryTask(params.taskId, requestInput(body), expectedRevision),
          200,
          'Task',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/tasks/:taskId/stop',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        assertAllowedFields(body, ['runId', 'reason']);
        requireString(body, 'runId');
        optionalString(body, 'reason');
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.stopTask(params.taskId, requestInput(body), expectedRevision),
          200,
          'Task',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/tasks/:taskId/verify',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        assertAllowedFields(body, ['outcome', 'summary', 'criteria']);
        requireString(body, 'outcome');
        requireString(body, 'summary');
        if (!Array.isArray(body.criteria)) {
          throw validationError('criteria must be an array', { field: 'criteria' });
        }
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.verifyTask(params.taskId, requestInput(body), expectedRevision),
          200,
          'Task',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/works/:workId/sessions',
      async handle({ params }) {
        return resultResponse(
          await service.listSessions(params.workId),
          200,
          'Work',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/sessions/:sessionId',
      async handle({ params }) {
        return resultResponse(
          await service.getSession(params.sessionId),
          200,
          'Session',
        );
      },
    },
    {
      method: 'GET',
      path: '/api/v3/sessions/:sessionId/messages',
      async handle({ params, url }) {
        return resultResponse(
          await service.listTranscript(
            params.sessionId,
            parseNonNegativeQuery(url, 'afterSequence'),
          ),
          200,
          'Session',
        );
      },
    },
    {
      method: 'POST',
      path: '/api/v3/sessions/:sessionId/messages',
      async handle({ req, params }) {
        const body = await readJsonObject(req);
        validateMessage(body);
        const expectedRevision = parseExpectedRevision(req, body);
        return resultResponse(
          await service.appendMessage(
            params.sessionId,
            requestInput(body),
            expectedRevision,
          ),
          201,
          'Session',
        );
      },
    },
  ];
}

function validateWork(body: JsonObject, create: boolean): void {
  const fields = create ? WORK_CREATE_FIELDS : WORK_UPDATE_FIELDS;
  assertAllowedFields(body, fields);
  if (create) {
    requireString(body, 'title');
    requireString(body, 'objective');
  } else {
    assertNonEmptyPatch(body);
  }
  for (const field of fields) optionalString(body, field);
}

function validateMission(body: JsonObject, create: boolean): void {
  assertAllowedFields(body, MISSION_FIELDS);
  if (create) {
    requireString(body, 'title');
    requireString(body, 'objective');
  } else {
    assertNonEmptyPatch(body);
  }
  for (const field of ['title', 'objective', 'priority', 'status', 'teamId', 'ownerAgentId']) {
    optionalString(body, field);
  }
  optionalStringArray(body, 'acceptanceCriteria');
  const policy = optionalObject(body, 'verificationPolicy');
  if (policy) validateVerificationPolicy(policy);
}

function validateTask(body: JsonObject, create: boolean): void {
  assertAllowedFields(body, TASK_FIELDS);
  if (create) requireString(body, 'title');
  else assertNonEmptyPatch(body);
  for (const field of [
    'title',
    'description',
    'status',
    'priority',
    'teamId',
    'assignedAgentId',
    'dueAt',
  ]) {
    optionalString(body, field);
  }
  optionalStringArray(body, 'acceptanceCriteria');
  optionalStringArray(body, 'dependsOnTaskIds');
  optionalBoolean(body, 'readOnly');
  optionalStringArray(body, 'writeScope');
}

function validateMessage(body: JsonObject): void {
  assertAllowedFields(body, MESSAGE_FIELDS);
  requireString(body, 'role');
  requireString(body, 'content');
  for (const field of ['id', 'agentId', 'toolCallId', 'toolName']) {
    optionalString(body, field);
  }
  optionalObject(body, 'metadata');
}

function validateVerificationPolicy(body: JsonObject): void {
  assertAllowedFields(body, [
    'mode',
    'reviewerAgentId',
    'requireDifferentAgent',
    'maxRevisionAttempts',
    'requiredEvidence',
  ]);
  requireString(body, 'mode');
  optionalString(body, 'reviewerAgentId');
  if (body.requireDifferentAgent === undefined) {
    throw validationError('requireDifferentAgent is required', {
      field: 'requireDifferentAgent',
    });
  }
  optionalBoolean(body, 'requireDifferentAgent');
  if (body.maxRevisionAttempts === undefined) {
    throw validationError('maxRevisionAttempts is required', {
      field: 'maxRevisionAttempts',
    });
  }
  optionalNonNegativeInteger(body, 'maxRevisionAttempts');
  optionalStringArray(body, 'requiredEvidence');
}
