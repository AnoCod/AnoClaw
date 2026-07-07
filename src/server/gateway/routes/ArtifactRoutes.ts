import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import type { ApiToken } from '../ApiAuth.js';
import { readBody, sendJson } from '../RouteHelpers.js';
import { ArtifactManager } from '../../core/artifacts/ArtifactManager.js';
import type {
  ArtifactKind,
  ArtifactStatus,
  CreateArtifactInput,
  UpdateArtifactInput,
} from '../../../shared/types/artifact.js';

function parseLimit(value: string | null): number {
  const parsed = Number(value || 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class ListArtifactsRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/artifacts';
  category = 'Artifacts';
  description = 'List generated artifacts, optionally filtered by session, kind, or status';

  constructor(private readonly _manager = ArtifactManager.getInstance()) {}

  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const artifacts = await this._manager.list({
      sessionId: text(match.query.get('sessionId')),
      kind: text(match.query.get('kind')) as ArtifactKind | undefined,
      status: text(match.query.get('status')) as ArtifactStatus | undefined,
      limit: parseLimit(match.query.get('limit')),
    });
    sendJson(res, 200, { artifacts, total: artifacts.length });
    return true;
  }
}

export class CreateArtifactRoute implements RouteHandler {
  method = 'POST' as const;
  path = '/api/v1/artifacts';
  category = 'Artifacts';
  description = 'Create an artifact record for a generated user-facing deliverable';

  constructor(private readonly _manager = ArtifactManager.getInstance()) {}

  async handle(_match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const body = await readBody(req);
    const input: CreateArtifactInput = {
      sessionId: text(body.sessionId) || '',
      title: text(body.title) || '',
      kind: text(body.kind) as ArtifactKind,
      status: text(body.status) as ArtifactStatus | undefined,
      capabilityId: text(body.capabilityId),
      taskId: text(body.taskId),
      description: text(body.description),
      files: Array.isArray(body.files) ? body.files as CreateArtifactInput['files'] : undefined,
      preview: isRecord(body.preview) ? body.preview as CreateArtifactInput['preview'] : undefined,
      metadata: isRecord(body.metadata) ? body.metadata : undefined,
    };
    try {
      const artifact = await this._manager.create(input);
      sendJson(res, 201, { artifact });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return true;
  }
}

export class GetArtifactRoute implements RouteHandler {
  method = 'GET' as const;
  path = '/api/v1/artifacts/:sessionId/:artifactId';
  category = 'Artifacts';
  description = 'Get one artifact by session and artifact id';

  constructor(private readonly _manager = ArtifactManager.getInstance()) {}

  async handle(match: RouteMatch, _req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    try {
      const artifact = await this._manager.get(match.params.sessionId, match.params.artifactId);
      sendJson(res, 200, { artifact });
    } catch (err) {
      sendJson(res, 404, { error: (err as Error).message });
    }
    return true;
  }
}

export class UpdateArtifactRoute implements RouteHandler {
  method = 'PATCH' as const;
  path = '/api/v1/artifacts/:sessionId/:artifactId';
  category = 'Artifacts';
  description = 'Update an artifact record, preview, files, status, or version';

  constructor(private readonly _manager = ArtifactManager.getInstance()) {}

  async handle(match: RouteMatch, req: IncomingMessage, res: ServerResponse, _token: ApiToken | null): Promise<boolean> {
    const body = await readBody(req);
    const input: UpdateArtifactInput = {
      title: text(body.title),
      status: text(body.status) as ArtifactStatus | undefined,
      description: text(body.description),
      files: Array.isArray(body.files) ? body.files as UpdateArtifactInput['files'] : undefined,
      preview: isRecord(body.preview) ? body.preview as UpdateArtifactInput['preview'] : undefined,
      metadata: isRecord(body.metadata) ? body.metadata : undefined,
      error: body.error === null ? null : text(body.error),
      createVersion: typeof body.createVersion === 'boolean' ? body.createVersion : undefined,
      versionSummary: text(body.versionSummary),
    };
    try {
      const artifact = await this._manager.update(match.params.sessionId, match.params.artifactId, input);
      sendJson(res, 200, { artifact });
    } catch (err) {
      sendJson(res, 404, { error: (err as Error).message });
    }
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
