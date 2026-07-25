import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Company,
  Task,
  TranscriptMessage,
  VerificationRecord,
  Work,
} from '../../../../shared/types/v3/index.js';
import type { V3ApiServices, V3CompanyApi, V3WorkApi } from '../Contracts.js';
import { createV3Router, type V3Router } from '../V3Router.js';

const company: Company = {
  id: 'company-1',
  name: 'AnoClaw',
  mainAgentId: 'agent-main',
  rootTeamId: 'team-root',
  defaultLocale: 'zh-CN',
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
};

const work: Work = {
  id: 'work-1',
  companyId: company.id,
  primarySessionId: 'session-primary',
  title: 'Ship v3',
  objective: 'Replace the old product contract',
  status: 'active',
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
};

const task: Task = {
  id: 'task-1',
  workId: work.id,
  missionId: 'mission-1',
  title: 'Build API',
  acceptanceCriteria: ['API tests pass'],
  status: 'ready',
  priority: 'high',
  dependsOnTaskIds: [],
  readOnly: false,
  writeScope: ['src/server/api/v3'],
  version: 1,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
};

describe('v3 raw HTTP router', () => {
  let server: Server;
  let baseUrl: string;
  let router: V3Router;
  let companyApi: Partial<V3CompanyApi>;
  let workApi: Partial<V3WorkApi>;

  beforeEach(async () => {
    companyApi = {
      getCompany: vi.fn(async () => ({ data: company, revision: 7 })),
    };
    workApi = {};
    router = createV3Router({
      company: companyApi as V3CompanyApi,
      work: workApi as V3WorkApi,
    });
    server = createServer((req, res) => {
      void router.handle(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it('publishes only the frozen single-company v3 route family', () => {
    expect(router.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/v3/company',
      'POST /api/v3/company',
      'PATCH /api/v3/company',
      'GET /api/v3/company/events',
      'GET /api/v3/teams',
      'POST /api/v3/teams',
      'GET /api/v3/teams/:teamId',
      'PATCH /api/v3/teams/:teamId',
      'POST /api/v3/teams/:teamId/archive',
      'GET /api/v3/teams/:teamId/members',
      'POST /api/v3/teams/:teamId/members',
      'DELETE /api/v3/teams/:teamId/members',
      'PATCH /api/v3/teams/:teamId/members',
      'GET /api/v3/agents',
      'POST /api/v3/agents',
      'GET /api/v3/agents/:agentId',
      'PATCH /api/v3/agents/:agentId',
      'POST /api/v3/agents/:agentId/archive',
      'GET /api/v3/workspaces',
      'POST /api/v3/workspaces',
      'GET /api/v3/workspaces/:workspaceId',
      'PATCH /api/v3/workspaces/:workspaceId',
      'GET /api/v3/works',
      'POST /api/v3/works',
      'GET /api/v3/works/:workId',
      'PATCH /api/v3/works/:workId',
      'GET /api/v3/works/:workId/events',
      'GET /api/v3/works/:workId/missions',
      'POST /api/v3/works/:workId/missions',
      'GET /api/v3/missions/:missionId',
      'PATCH /api/v3/missions/:missionId',
      'GET /api/v3/missions/:missionId/tasks',
      'POST /api/v3/missions/:missionId/tasks',
      'GET /api/v3/tasks/:taskId',
      'PATCH /api/v3/tasks/:taskId',
      'POST /api/v3/tasks/:taskId/assign',
      'POST /api/v3/tasks/:taskId/claim',
      'POST /api/v3/tasks/:taskId/retry',
      'POST /api/v3/tasks/:taskId/stop',
      'POST /api/v3/tasks/:taskId/verify',
      'GET /api/v3/works/:workId/sessions',
      'GET /api/v3/sessions/:sessionId',
      'GET /api/v3/sessions/:sessionId/messages',
      'POST /api/v3/sessions/:sessionId/messages',
    ]);
  });

  it('returns revision in the body and as a strong ETag', async () => {
    const response = await request('/api/v3/company');

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"7"');
    expect(await response.json()).toEqual({ data: company, revision: 7 });
  });

  it('accepts If-Match, strips transport metadata, and forwards the expected revision', async () => {
    companyApi.updateCompany = vi.fn(async () => ({
      data: { ...company, name: 'AnoClaw 3' },
      revision: 8,
    }));

    const response = await request('/api/v3/company', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"7"',
      },
      body: JSON.stringify({ name: 'AnoClaw 3' }),
    });

    expect(response.status).toBe(200);
    expect(companyApi.updateCompany).toHaveBeenCalledWith({ name: 'AnoClaw 3' }, 7);
    expect(response.headers.get('etag')).toBe('"8"');
  });

  it('accepts body expectedRevision and rejects contradictory preconditions', async () => {
    companyApi.updateCompany = vi.fn(async () => ({ data: company, revision: 9 }));
    const accepted = await request('/api/v3/company', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'v3', expectedRevision: 8 }),
    });
    expect(accepted.status).toBe(200);
    expect(companyApi.updateCompany).toHaveBeenCalledWith({ description: 'v3' }, 8);

    const rejected = await request('/api/v3/company', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"7"',
      },
      body: JSON.stringify({ description: 'v3', expectedRevision: 8 }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: {
        code: 'bad_request',
        message: 'If-Match and expectedRevision must identify the same revision',
      },
    });
  });

  it('uses one envelope for malformed JSON, validation, and missing preconditions', async () => {
    const invalidJson = await request('/api/v3/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":',
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({
      error: {
        code: 'invalid_json',
        message: 'Request body is not valid JSON',
      },
    });

    const validation = await request('/api/v3/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, legacyManagerId: 'agent-1' }),
    });
    expect(validation.status).toBe(422);
    expect(await validation.json()).toMatchObject({
      error: {
        code: 'validation_failed',
        details: { fields: ['legacyManagerId'] },
      },
    });

    const precondition = await request('/api/v3/company', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No revision' }),
    });
    expect(precondition.status).toBe(428);
    expect(await precondition.json()).toMatchObject({
      error: { code: 'precondition_required' },
    });
  });

  it('maps store revision conflicts to 409', async () => {
    companyApi.updateCompany = vi.fn(async () => {
      throw Object.assign(new Error('Expected revision 3 but current revision is 4'), {
        code: 'REVISION_CONFLICT',
        details: { expectedRevision: 3, actualRevision: 4 },
      });
    });

    const response = await request('/api/v3/company', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"3"',
      },
      body: JSON.stringify({ name: 'stale' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'revision_conflict',
        message: 'Expected revision 3 but current revision is 4',
        details: { expectedRevision: 3, actualRevision: 4 },
      },
    });
  });

  it('hides cross-scope misses behind the same generic 404', async () => {
    workApi.listMissions = vi.fn(async () => null);
    workApi.getTask = vi.fn(async () => {
      throw Object.assign(new Error('Task exists under work-secret'), {
        code: 'NOT_FOUND',
      });
    });

    const parentMiss = await request('/api/v3/works/work-from-other-company/missions');
    expect(parentMiss.status).toBe(404);
    expect(await parentMiss.json()).toEqual({
      error: { code: 'not_found', message: 'Work not found' },
    });

    const childMiss = await request('/api/v3/tasks/task-from-other-company');
    expect(childMiss.status).toBe(404);
    expect(await childMiss.json()).toEqual({
      error: { code: 'not_found', message: 'Resource not found' },
    });
  });

  it('routes task claim input and maps business state errors to 422', async () => {
    workApi.claimTask = vi.fn(async () => {
      throw Object.assign(new Error('Task must be ready before it can be claimed'), {
        code: 'invalid_transition',
      });
    });

    const response = await request('/api/v3/tasks/task-1/claim', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '12',
      },
      body: JSON.stringify({
        agentId: 'agent-1',
        sessionId: 'session-1',
        maxTurns: 20,
      }),
    });

    expect(workApi.claimTask).toHaveBeenCalledWith('task-1', {
      agentId: 'agent-1',
      sessionId: 'session-1',
      maxTurns: 20,
    }, 12);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_transition',
        message: 'Task must be ready before it can be claimed',
      },
    });

    workApi.updateTask = vi.fn(async () => {
      throw Object.assign(new Error('A task cannot depend on itself'), {
        code: 'CONFLICT',
      });
    });
    const repositoryConflict = await request('/api/v3/tasks/task-1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"12"',
      },
      body: JSON.stringify({ dependsOnTaskIds: ['task-1'] }),
    });
    expect(repositoryConflict.status).toBe(422);
    expect(await repositoryConflict.json()).toEqual({
      error: {
        code: 'invalid_state',
        message: 'A task cannot depend on itself',
      },
    });
  });

  it('routes explicit user verification with the Work revision precondition', async () => {
    const verification: VerificationRecord = {
      id: 'verification-1',
      workId: work.id,
      missionId: task.missionId,
      taskId: task.id,
      runId: 'run-1',
      mode: 'user',
      workerAgentId: 'agent-worker',
      outcome: 'approved',
      summary: 'Accepted by user',
      criteria: [{
        criterion: 'API tests pass',
        passed: true,
        evidence: ['Reviewed in UI'],
      }],
      revisionAttempt: 0,
      createdAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:01:00.000Z',
    };
    workApi.verifyTask = vi.fn(async () => ({
      data: { task: { ...task, status: 'completed' as const }, verification },
      revision: 15,
    }));

    const response = await request('/api/v3/tasks/task-1/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"14"',
      },
      body: JSON.stringify({
        outcome: 'approved',
        summary: 'Accepted by user',
        criteria: verification.criteria,
      }),
    });

    expect(response.status).toBe(200);
    expect(workApi.verifyTask).toHaveBeenCalledWith(
      'task-1',
      {
        outcome: 'approved',
        summary: 'Accepted by user',
        criteria: verification.criteria,
      },
      14,
    );
  });

  it('separates company and work event streams and validates cursors', async () => {
    companyApi.listCompanyEvents = vi.fn(async () => ({ data: [], revision: 11 }));
    workApi.listWorkEvents = vi.fn(async () => ({ data: [], revision: 4 }));

    const companyEvents = await request('/api/v3/company/events?afterRevision=9');
    expect(companyEvents.status).toBe(200);
    expect(companyApi.listCompanyEvents).toHaveBeenCalledWith(9);
    expect(companyEvents.headers.get('etag')).toBe('"11"');

    const workEvents = await request('/api/v3/works/work-1/events?afterRevision=3');
    expect(workEvents.status).toBe(200);
    expect(workApi.listWorkEvents).toHaveBeenCalledWith('work-1', 3);
    expect(workEvents.headers.get('etag')).toBe('"4"');

    const invalidCursor = await request('/api/v3/works/work-1/events?afterRevision=-1');
    expect(invalidCursor.status).toBe(422);
    expect(await invalidCursor.json()).toMatchObject({
      error: { code: 'validation_failed', details: { field: 'afterRevision' } },
    });
  });

  it('uses transcript revision for session message reads and appends', async () => {
    const message: TranscriptMessage = {
      kind: 'message',
      id: 'message-1',
      role: 'user',
      content: 'Continue',
    };
    workApi.listTranscript = vi.fn(async () => ({ data: [message], revision: 2 }));
    workApi.appendMessage = vi.fn(async () => ({ data: message, revision: 3 }));

    const read = await request('/api/v3/sessions/session-1/messages?afterSequence=1');
    expect(read.status).toBe(200);
    expect(workApi.listTranscript).toHaveBeenCalledWith('session-1', 1);
    expect(read.headers.get('etag')).toBe('"2"');

    const append = await request('/api/v3/sessions/session-1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': 'W/"2"',
      },
      body: JSON.stringify({ role: 'user', content: 'Continue' }),
    });
    expect(append.status).toBe(201);
    expect(workApi.appendMessage).toHaveBeenCalledWith(
      'session-1',
      { role: 'user', content: 'Continue' },
      2,
    );
    expect(append.headers.get('etag')).toBe('"3"');
  });

  it('returns false without writing for non-v3 URLs', async () => {
    const response = await request('/api/v1/health');
    expect(response.status).toBe(404);
  });

  function request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, init);
  }
});
