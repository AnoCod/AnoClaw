import { randomUUID } from 'node:crypto';
import type {
  Agent,
  CompanyProjection,
  Session,
  SessionTranscriptRecord,
  Team,
  TeamMembership,
  TranscriptMessage,
  WorkProjection,
} from '../../../../shared/types/v3/index.js';
import { createLogger } from '../../logger.js';
import {
  CompanyRepository,
  SessionTranscriptRepository,
  WorkRepository,
} from '../store/index.js';
import {
  V3AgentRuntimeBridge,
  type V3PrimaryTurnInput,
  type V3PrimaryTurnResult,
  type V3TeamPacket,
} from './V3AgentRuntimeBridge.js';
import { V3ToolExecutionRegistry } from '../runtime/V3ToolExecutionRegistry.js';

export interface V3PrimaryTurnExecutor {
  executePrimaryTurn(input: V3PrimaryTurnInput): Promise<V3PrimaryTurnResult>;
}

export interface V3PrimaryTurnCoordinatorOptions {
  companyRepository: CompanyRepository;
  workRepository: WorkRepository;
  transcriptRepository: SessionTranscriptRepository;
  executor?: V3PrimaryTurnExecutor;
  clock?: () => string;
  idFactory?: () => string;
  toolRegistry?: V3ToolExecutionRegistry;
}

export interface QueuePrimaryTurnInput {
  workId: string;
  sessionId: string;
  messageId: string;
}

/**
 * FIFO primary-session turn queue.
 *
 * The REST command durably appends the user message first, then enqueues this
 * coordinator. A failed process may safely enqueue the same messageId again;
 * the deterministic assistant entry id suppresses duplicate transcript output.
 */
export class V3PrimaryTurnCoordinator {
  private readonly companyRepository: CompanyRepository;
  private readonly workRepository: WorkRepository;
  private readonly transcriptRepository: SessionTranscriptRepository;
  private readonly executor: V3PrimaryTurnExecutor;
  private readonly clock: () => string;
  private readonly idFactory: () => string;
  private readonly toolRegistry: V3ToolExecutionRegistry;
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly logger = createLogger('anoclaw.v3.primary-turn');

  constructor(options: V3PrimaryTurnCoordinatorOptions) {
    this.companyRepository = options.companyRepository;
    this.workRepository = options.workRepository;
    this.transcriptRepository = options.transcriptRepository;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.toolRegistry = options.toolRegistry ?? V3ToolExecutionRegistry.getInstance();
    this.executor = options.executor ?? V3AgentRuntimeBridge.production({
      transcriptSink: {
        persistToolMessage: async (sessionId, message) => {
          await this.appendTranscriptAndSynchronize(sessionId, message);
        },
      },
    });
  }

  enqueue(input: QueuePrimaryTurnInput): void {
    const previous = this.sessionTails.get(input.sessionId) ?? Promise.resolve();
    const current: Promise<void> = previous
      .catch(() => {})
      .then(async () => {
        await this.execute(input);
      })
      .catch((error) => {
        this.logger.error('Primary turn failed', {
          sid: input.sessionId,
          workId: input.workId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.sessionTails.get(input.sessionId) === current) {
          this.sessionTails.delete(input.sessionId);
        }
      });
    this.sessionTails.set(input.sessionId, current);
  }

  async execute(input: QueuePrimaryTurnInput): Promise<V3PrimaryTurnResult> {
    const projection = await this.requireWork(input.workId);
    const session = requirePrimarySession(projection, input.sessionId);
    const transcript = await this.transcriptRepository.read(input.sessionId);
    const userRecord = transcript.find((record) => record.entryId === input.messageId);
    if (!userRecord || userRecord.entry.kind !== 'message' || userRecord.entry.role !== 'user') {
      throw new Error(`User transcript message not found: ${input.messageId}`);
    }

    const company = await this.requireCompany();
    const agent = requireAgent(company, session.agentId);
    const teamPacket = buildTeamPacket(company, session, agent);
    const mission = session.missionId ? projection.missions[session.missionId] : undefined;
    const task = session.taskId ? projection.tasks[session.taskId] : undefined;
    const controller = new AbortController();
    const primaryExecutionId = `primary-${session.id}`;
    const workspace = projection.work.workspaceId
      ? company.workspaces[projection.work.workspaceId]
      : undefined;
    this.controllers.set(input.sessionId, controller);
    this.toolRegistry.register({
      companyId: company.company.id,
      teamId: teamPacket.id,
      workId: projection.work.id,
      missionId: session.missionId ?? projection.work.focusMissionId ?? '',
      taskId: session.taskId ?? '',
      runId: primaryExecutionId,
      sessionId: session.id,
      agentId: agent.id,
      ...(workspace
        ? { workspaceId: workspace.id, workspaceRoot: workspace.rootPath }
        : {}),
      // The conversational MainAgent coordinates through v3 domain tools.
      // Filesystem/process mutations must be delegated to a leased Task Run.
      readOnly: true,
      writeScope: [],
      fencingToken: 1,
      activeLeases: [],
      allowedTools: [...agent.allowedTools],
    });

    let result: V3PrimaryTurnResult;
    try {
      await this.updateSessionStatus(input.workId, input.sessionId, 'active');
      result = await this.executor.executePrimaryTurn({
        session: { ...session, status: 'active' },
        agent,
        content: userRecord.entry.content,
        packet: {
          company: company.company
            ? {
              id: company.company.id,
              name: company.company.name,
              ...(company.company.description
                ? { description: company.company.description }
                : {}),
            }
            : undefined,
          work: projection.work,
          ...(mission ? { mission } : {}),
          ...(task ? { task } : {}),
          team: teamPacket,
        },
        ...(workspace ? { workspaceRoot: workspace.rootPath } : {}),
        transcript,
        messageId: input.messageId,
        signal: controller.signal,
        permissionMode: 'autoEdit',
      });

      const content = result.assistantText.trim()
        || (result.status === 'cancelled'
          ? 'This turn was stopped.'
          : result.status === 'failed'
            ? `The turn failed: ${result.error ?? 'unknown error'}`
            : 'The turn completed without a text response.');
      await this.appendTranscriptAndSynchronize(input.sessionId, {
        kind: 'message',
        id: `assistant-for-${input.messageId}`,
        role: 'assistant',
        content,
        agentId: agent.id,
        metadata: {
          runtimeStatus: result.status,
          done: result.done,
          turnCount: result.turnCount,
          toolCount: result.toolCount,
          totalTokens: result.tokenUsage.totalTokens,
        },
      });
      return result;
    } finally {
      this.controllers.delete(input.sessionId);
      this.toolRegistry.unregister(input.sessionId, primaryExecutionId);
      await this.updateSessionStatus(input.workId, input.sessionId, 'idle');
    }
  }

  stopSession(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async waitForIdle(sessionId: string): Promise<void> {
    await this.sessionTails.get(sessionId);
  }

  private async appendTranscriptAndSynchronize(
    sessionId: string,
    message: TranscriptMessage,
  ): Promise<SessionTranscriptRecord> {
    const found = await this.findSession(sessionId);
    if (!found) throw new Error(`Session not found: ${sessionId}`);
    const currentRecords = await this.transcriptRepository.read(sessionId);
    const record = await this.transcriptRepository.append(sessionId, message, {
      expectedSequence: currentRecords.at(-1)?.sequence ?? 0,
      entryId: message.id,
      occurredAt: this.clock(),
    });
    await this.synchronizeTranscriptRevision(found.workId, sessionId, record.sequence);
    return record;
  }

  private async updateSessionStatus(
    workId: string,
    sessionId: string,
    status: Session['status'],
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const projection = await this.workRepository.getProjection(workId);
      const current = projection.sessions[sessionId];
      if (!current || current.status === status) return;
      try {
        await this.workRepository.updateSession(
          workId,
          sessionId,
          { status },
          {
            expectedRevision: projection.revision,
            eventId: `primary-session-${sessionId}-${status}-${this.idFactory()}`,
          },
        );
        return;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    throw new Error(`Could not mark Session ${sessionId} as ${status}`);
  }

  private async synchronizeTranscriptRevision(
    workId: string,
    sessionId: string,
    transcriptRevision: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const projection = await this.workRepository.getProjection(workId);
      const session = projection.sessions[sessionId];
      if (!session || session.transcriptRevision >= transcriptRevision) return;
      try {
        await this.workRepository.updateSession(
          workId,
          sessionId,
          { transcriptRevision },
          {
            expectedRevision: projection.revision,
            eventId: `transcript-${sessionId}-${transcriptRevision}`,
          },
        );
        return;
      } catch (error) {
        if (!isRevisionConflict(error)) throw error;
      }
    }
    throw new Error(`Could not synchronize transcript revision for ${sessionId}`);
  }

  private async requireCompany(): Promise<CompanyProjection & { company: NonNullable<CompanyProjection['company']> }> {
    const projection = await this.companyRepository.getProjection();
    if (!projection.company) throw new Error('Company does not exist');
    return projection as CompanyProjection & { company: NonNullable<CompanyProjection['company']> };
  }

  private async requireWork(workId: string): Promise<WorkProjection & { work: NonNullable<WorkProjection['work']> }> {
    const projection = await this.workRepository.getProjection(workId);
    if (!projection.work) throw new Error(`Work not found: ${workId}`);
    return projection as WorkProjection & { work: NonNullable<WorkProjection['work']> };
  }

  private async findSession(
    sessionId: string,
  ): Promise<{ workId: string; session: Session } | null> {
    for (const workId of await this.workRepository.listWorkIds()) {
      const projection = await this.workRepository.getProjection(workId);
      const session = projection.sessions[sessionId];
      if (session) return { workId, session };
    }
    return null;
  }
}

function requirePrimarySession(projection: WorkProjection, sessionId: string): Session {
  const session = projection.sessions[sessionId];
  if (!session || session.kind !== 'primary' || session.status === 'closed') {
    throw new Error(`Active primary Session not found: ${sessionId}`);
  }
  return session;
}

function requireAgent(company: CompanyProjection, agentId: string): Agent {
  const agent = company.agents[agentId];
  if (!agent || agent.status !== 'active') throw new Error(`Active Agent not found: ${agentId}`);
  return agent;
}

function buildTeamPacket(
  company: CompanyProjection,
  session: Session,
  agent: Agent,
): V3TeamPacket {
  const memberships = Object.values(company.memberships).filter(
    (membership) => membership.agentId === agent.id && !membership.removedAt,
  );
  const membership = memberships.find((entry) => entry.teamId === session.actorSnapshot.teamId)
    ?? memberships.find((entry) => entry.isPrimary)
    ?? memberships[0];
  if (!membership) throw new Error(`Agent has no active Team membership: ${agent.id}`);
  const team = company.teams[membership.teamId];
  if (!team || team.archivedAt) throw new Error(`Active Team not found: ${membership.teamId}`);
  const teamMemberships = Object.values(company.memberships).filter(
    (entry) => entry.teamId === team.id && !entry.removedAt,
  );
  return {
    id: team.id,
    name: team.name,
    ...(team.description ? { description: team.description } : {}),
    members: teamMemberships.flatMap((entry) => {
      const member = company.agents[entry.agentId];
      return member && member.status === 'active'
        ? [{
          agentId: member.id,
          name: member.name,
          membershipRole: entry.role,
          capabilities: [...member.capabilities],
        }]
        : [];
    }),
  };
}

function isRevisionConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && error.code === 'REVISION_CONFLICT';
}
