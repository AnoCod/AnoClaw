import type {
  Company,
  CompanyEventEnvelope,
  Mission,
  Revisioned,
  Session,
  ShellSnapshot,
  Task,
  Team,
  TeamMembership,
  TranscriptEntry,
  Work,
  WorkDetail,
  WorkEventEnvelope,
  Workspace,
  Agent,
  VerificationCriterionResult,
  VerificationRecord,
} from '../model.js';
import { findPrimarySession } from '../app/sessionTransparency.js';

interface V3ErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class V3ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'V3ApiError';
  }
}

export class V3ApiClient {
  constructor(private readonly basePath = '/api/v3') {}

  async loadShell(): Promise<ShellSnapshot> {
    const [
      company,
      workspaces,
      teams,
      agents,
      works,
      companyEvents,
    ] = await Promise.all([
      this.optional<Company>('/company'),
      this.list<Workspace>('/workspaces'),
      this.list<Team>('/teams'),
      this.list<Agent>('/agents'),
      this.list<Work>('/works'),
      this.list<CompanyEventEnvelope>('/company/events?afterRevision=0'),
    ]);

    const memberships = await Promise.all(
      teams.data.map((team) =>
        this.optionalList<TeamMembership>(`/teams/${encodeURIComponent(team.id)}/members`)
      ),
    );

    return {
      company: company?.data ?? null,
      companyRevision: Math.max(
        company?.revision ?? 0,
        workspaces.revision,
        teams.revision,
        ...memberships.map((result) => result.revision),
        agents.revision,
        companyEvents.revision,
      ),
      workspaces: workspaces.data,
      teams: teams.data,
      memberships: memberships.flatMap((result) => result.data),
      agents: agents.data,
      works: works.data,
      worksRevision: works.revision,
      companyEvents: companyEvents.data,
    };
  }

  async loadWork(work: Work): Promise<WorkDetail> {
    const [missionsResult, sessionsResult, eventsResult] = await Promise.all([
      this.optionalList<Mission>(`/works/${encodeURIComponent(work.id)}/missions`),
      this.optionalList<Session>(`/works/${encodeURIComponent(work.id)}/sessions`),
      this.optionalList<WorkEventEnvelope>(
        `/works/${encodeURIComponent(work.id)}/events?afterRevision=0`,
      ),
    ]);
    const missions = missionsResult.data;
    const taskResults = await Promise.all(
      missions.map((mission) =>
        this.optionalList<Task>(`/missions/${encodeURIComponent(mission.id)}/tasks`)
      ),
    );
    const sessions = sessionsResult.data;
    const verifications = latestVerifications(eventsResult.data);
    const session = findPrimarySession(work, sessions);
    const transcript = session
      ? await this.loadSessionTranscript(session.id)
      : { data: [], revision: 0 };

    return {
      missions,
      tasks: taskResults.flatMap((result) => result.data),
      sessions,
      transcript: transcript.data,
      events: eventsResult.data,
      verifications,
      revision: Math.max(
        eventsResult.revision,
        missionsResult.revision,
        sessionsResult.revision,
        ...taskResults.map((result) => result.revision),
      ),
      transcriptRevision: transcript.revision,
    };
  }

  createCompany(
    name: string,
    description?: string,
    defaultLocale?: Company['defaultLocale'],
  ): Promise<Revisioned<Company>> {
    return this.mutate('/company', 'POST', {
      name,
      ...(description ? { description } : {}),
      ...(defaultLocale ? { defaultLocale } : {}),
    }, 0);
  }

  updateCompanyLocale(
    defaultLocale: Company['defaultLocale'],
    expectedRevision: number,
  ): Promise<Revisioned<Company>> {
    return this.mutate(
      '/company',
      'PATCH',
      { defaultLocale },
      expectedRevision,
    );
  }

  createWorkspace(
    input: Pick<Workspace, 'name' | 'rootPath'> & { description?: string },
    expectedRevision: number,
  ): Promise<Revisioned<Workspace>> {
    return this.mutate('/workspaces', 'POST', input, expectedRevision);
  }

  createWork(
    input: Pick<Work, 'title' | 'objective'> & { workspaceId?: string },
  ): Promise<Revisioned<Work>> {
    return this.mutate('/works', 'POST', input, 0);
  }

  updateWork(
    workId: string,
    patch: Partial<Pick<Work, 'title' | 'objective' | 'status' | 'workspaceId'>>,
    expectedRevision: number,
  ): Promise<Revisioned<Work>> {
    return this.mutate(
      `/works/${encodeURIComponent(workId)}`,
      'PATCH',
      patch,
      expectedRevision,
    );
  }

  verifyTask(
    taskId: string,
    input: {
      outcome: 'approved' | 'revision_required';
      summary: string;
      criteria: VerificationCriterionResult[];
    },
    expectedRevision: number,
  ): Promise<Revisioned<{ task: Task; verification: VerificationRecord }>> {
    return this.mutate(
      `/tasks/${encodeURIComponent(taskId)}/verify`,
      'POST',
      input,
      expectedRevision,
    );
  }

  appendUserMessage(
    sessionId: string,
    content: string,
    expectedRevision: number,
  ): Promise<Revisioned<TranscriptEntry>> {
    return this.mutate(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      'POST',
      { role: 'user', content },
      expectedRevision,
    );
  }

  loadSessionTranscript(sessionId: string): Promise<Revisioned<TranscriptEntry[]>> {
    return this.optionalList<TranscriptEntry>(
      `/sessions/${encodeURIComponent(sessionId)}/messages?afterSequence=0`,
    );
  }

  private async list<T>(path: string): Promise<Revisioned<T[]>> {
    return (await this.optionalList<T>(path));
  }

  private async optionalList<T>(path: string): Promise<Revisioned<T[]>> {
    const response = await this.request<T[]>(path, undefined, true);
    return response ?? { data: [], revision: 0 };
  }

  private async optional<T>(path: string): Promise<Revisioned<T> | null> {
    return this.request<T>(path, undefined, true);
  }

  private mutate<T>(
    path: string,
    method: 'POST' | 'PATCH',
    input: object,
    expectedRevision: number,
  ): Promise<Revisioned<T>> {
    return this.request<T>(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${expectedRevision}"`,
      },
      body: JSON.stringify(input),
    }).then((result) => {
      if (!result) throw new V3ApiError(404, 'not_found', 'Resource not found');
      return result;
    });
  }

  private async request<T>(
    path: string,
    init?: RequestInit,
    allowNotFound = false,
  ): Promise<Revisioned<T> | null> {
    const response = await fetch(`${this.basePath}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...init?.headers,
      },
    });
    if (allowNotFound && response.status === 404) return null;

    const body = await readBody(response);
    if (!response.ok) {
      const error = body as V3ErrorBody;
      throw new V3ApiError(
        response.status,
        error.error?.code ?? 'request_failed',
        error.error?.message ?? `Request failed (${response.status})`,
        error.error?.details,
      );
    }
    if (!isRevisioned<T>(body)) {
      throw new V3ApiError(
        response.status,
        'invalid_response',
        'AnoClaw returned an invalid v3 response envelope',
      );
    }
    return body;
  }
}

function latestVerifications(events: WorkEventEnvelope[]): VerificationRecord[] {
  const byId = new Map<string, VerificationRecord>();
  for (const envelope of events) {
    const event = envelope.event;
    if (
      event.type === 'verification.recorded'
      || event.type === 'verification.updated'
      || event.type === 'execution.verification_gated'
    ) {
      byId.set(event.verification.id, event.verification);
    }
  }
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new V3ApiError(response.status, 'invalid_response', 'AnoClaw returned invalid JSON');
  }
}

function isRevisioned<T>(value: unknown): value is Revisioned<T> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Revisioned<T>>;
  return 'data' in candidate
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision ?? -1) >= 0;
}
