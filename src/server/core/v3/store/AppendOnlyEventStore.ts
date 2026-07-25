import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CompanyEvent,
  CompanyEventEnvelope,
  DomainEventEnvelope,
  EventActor,
  ProjectionCheckpoint,
  WorkEvent,
  WorkEventEnvelope,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import { assertNoSensitiveFields } from '../domain/SensitiveFields.js';
import { V3EventHub } from '../events/V3EventHub.js';

type ScopeType = 'company' | 'work';
type StoredEnvelope = DomainEventEnvelope<ScopeType, unknown>;

export interface EventDraft<TEvent> {
  eventId: string;
  occurredAt: string;
  actor?: EventActor;
  correlationId?: string;
  causationId?: string;
  event: TEvent;
}

const activeLocks = new Map<string, Promise<void>>();
const SAFE_SCOPE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Strict append-only JSONL storage for v3 company and work event streams.
 * Event streams are the source of truth; projection files are disposable
 * checkpoints and can always be rebuilt from the stream.
 */
export class AppendOnlyEventStore {
  readonly rootDir: string;

  constructor(rootDir = path.resolve('data', 'v3')) {
    this.rootDir = path.resolve(rootDir);
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.rootDir, { recursive: true });
  }

  async appendCompanyEvent(
    scopeId: string,
    draft: EventDraft<CompanyEvent>,
    expectedRevision: number,
  ): Promise<CompanyEventEnvelope> {
    return this.append('company', scopeId, draft, expectedRevision);
  }

  async appendWorkEvent(
    workId: string,
    draft: EventDraft<WorkEvent>,
    expectedRevision: number,
  ): Promise<WorkEventEnvelope> {
    return this.append('work', workId, draft, expectedRevision);
  }

  async readCompanyEvents(scopeId: string): Promise<CompanyEventEnvelope[]> {
    return this.readEvents('company', scopeId);
  }

  async readWorkEvents(workId: string): Promise<WorkEventEnvelope[]> {
    return this.readEvents('work', workId);
  }

  async listWorkIds(): Promise<string[]> {
    const workRoot = path.join(this.rootDir, 'work');
    const entries = await fsp.readdir(workRoot, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_SCOPE_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async readCheckpoint<TProjection>(
    scopeType: ScopeType,
    scopeId: string,
  ): Promise<ProjectionCheckpoint<TProjection> | null> {
    const checkpointPath = path.join(this.scopeDir(scopeType, scopeId), 'projection.json');
    try {
      const parsed = JSON.parse(await fsp.readFile(checkpointPath, 'utf-8')) as
        ProjectionCheckpoint<TProjection>;
      if (
        parsed.schemaVersion !== 3
        || parsed.scopeType !== scopeType
        || parsed.scopeId !== scopeId
        || !Number.isSafeInteger(parsed.revision)
        || parsed.revision < 0
      ) {
        return null;
      }
      assertNoSensitiveFields(parsed.projection);
      return parsed;
    } catch (error) {
      if (error instanceof V3DomainError) throw error;
      return null;
    }
  }

  async writeCheckpoint<TProjection>(
    checkpoint: ProjectionCheckpoint<TProjection>,
  ): Promise<void> {
    this.assertScopeId(checkpoint.scopeId);
    assertNoSensitiveFields(checkpoint.projection);
    const dir = this.scopeDir(checkpoint.scopeType, checkpoint.scopeId);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'projection.json');
    await withSequentialLock(target, async () => {
      const temporary = path.join(dir, `.projection-${randomUUID()}.tmp`);
      const handle = await fsp.open(temporary, 'wx');
      try {
        await handle.writeFile(JSON.stringify(checkpoint, null, 2), { encoding: 'utf-8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Windows does not reliably replace an existing file with rename().
      // Projection checkpoints are disposable caches, so remove only this
      // validated target while holding its process-local writer lock.
      await fsp.rm(target, { force: true });
      await fsp.rename(temporary, target);
    });
  }

  private async append<
    TScopeType extends ScopeType,
    TEvent,
  >(
    scopeType: TScopeType,
    scopeId: string,
    draft: EventDraft<TEvent>,
    expectedRevision: number,
  ): Promise<DomainEventEnvelope<TScopeType, TEvent>> {
    this.assertScopeId(scopeId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new V3DomainError('INVALID_ARGUMENT', 'expectedRevision must be a non-negative integer');
    }
    if (!draft.eventId.trim()) {
      throw new V3DomainError('INVALID_ARGUMENT', 'eventId is required');
    }
    assertNoSensitiveFields(draft.event);

    const streamPath = this.streamPath(scopeType, scopeId);
    return withSequentialLock(streamPath, async () => {
      await fsp.mkdir(path.dirname(streamPath), { recursive: true });
      const events = await this.scanStream<TScopeType, TEvent>(
        scopeType,
        scopeId,
        true,
      );
      const existing = events.find((event) => event.eventId === draft.eventId);
      if (existing) return existing;

      const currentRevision = events.at(-1)?.revision ?? 0;
      if (expectedRevision !== currentRevision) {
        throw new V3DomainError(
          'REVISION_CONFLICT',
          `Expected revision ${expectedRevision}, current revision is ${currentRevision}`,
          { expectedRevision, currentRevision, scopeType, scopeId },
        );
      }

      const envelope: DomainEventEnvelope<TScopeType, TEvent> = {
        schemaVersion: 3,
        eventId: draft.eventId,
        scopeType,
        scopeId,
        revision: currentRevision + 1,
        occurredAt: draft.occurredAt,
        ...(draft.actor ? { actor: draft.actor } : {}),
        ...(draft.correlationId ? { correlationId: draft.correlationId } : {}),
        ...(draft.causationId ? { causationId: draft.causationId } : {}),
        event: draft.event,
      };
      const handle = await fsp.open(streamPath, 'a');
      try {
        await handle.writeFile(`${JSON.stringify(envelope)}\n`, { encoding: 'utf-8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Publish only after the append is durable. The hub is a latency
      // optimization; consumers still recover from this JSONL stream.
      V3EventHub.getInstance().publish(
        envelope as CompanyEventEnvelope | WorkEventEnvelope,
      );
      return envelope;
    });
  }

  private async readEvents<
    TScopeType extends ScopeType,
    TEvent,
  >(
    scopeType: TScopeType,
    scopeId: string,
  ): Promise<Array<DomainEventEnvelope<TScopeType, TEvent>>> {
    this.assertScopeId(scopeId);
    return this.scanStream(scopeType, scopeId, false);
  }

  private async scanStream<
    TScopeType extends ScopeType,
    TEvent,
  >(
    scopeType: TScopeType,
    scopeId: string,
    repairTruncatedTail: boolean,
  ): Promise<Array<DomainEventEnvelope<TScopeType, TEvent>>> {
    const streamPath = this.streamPath(scopeType, scopeId);
    let raw: string;
    try {
      raw = await fsp.readFile(streamPath, 'utf-8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
    if (!raw) return [];

    const hasTrailingNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    if (hasTrailingNewline) lines.pop();
    const events: Array<DomainEventEnvelope<TScopeType, TEvent>> = [];
    const eventIds = new Set<string>();
    let truncatedTail = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.replace(/\r$/, '') ?? '';
      const isFinalUnterminatedRecord = index === lines.length - 1 && !hasTrailingNewline;
      if (!line) {
        throw this.corruption(scopeType, scopeId, index + 1, 'empty record');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (isFinalUnterminatedRecord) {
          truncatedTail = true;
          break;
        }
        throw this.corruption(scopeType, scopeId, index + 1, 'invalid JSON');
      }

      const envelope = parsed as Partial<StoredEnvelope>;
      const expectedRevision = events.length + 1;
      if (
        envelope.schemaVersion !== 3
        || envelope.scopeType !== scopeType
        || envelope.scopeId !== scopeId
        || envelope.revision !== expectedRevision
        || typeof envelope.eventId !== 'string'
        || !envelope.eventId
        || typeof envelope.occurredAt !== 'string'
        || typeof envelope.event !== 'object'
        || envelope.event === null
      ) {
        throw this.corruption(scopeType, scopeId, index + 1, 'invalid envelope or revision gap');
      }
      if (eventIds.has(envelope.eventId)) {
        throw this.corruption(scopeType, scopeId, index + 1, 'duplicate eventId');
      }
      assertNoSensitiveFields(envelope.event);
      eventIds.add(envelope.eventId);
      events.push(envelope as DomainEventEnvelope<TScopeType, TEvent>);
    }

    if (truncatedTail && repairTruncatedTail) {
      const lastNewline = raw.lastIndexOf('\n');
      await fsp.truncate(streamPath, lastNewline < 0 ? 0 : Buffer.byteLength(
        raw.slice(0, lastNewline + 1),
        'utf-8',
      ));
    } else if (!hasTrailingNewline && repairTruncatedTail) {
      // A crash after a complete JSON write but before its delimiter leaves a
      // durable event. Preserve it and restore the delimiter before appending.
      await fsp.appendFile(streamPath, '\n', 'utf-8');
    }
    return events;
  }

  private streamPath(scopeType: ScopeType, scopeId: string): string {
    return path.join(this.scopeDir(scopeType, scopeId), 'events.jsonl');
  }

  private scopeDir(scopeType: ScopeType, scopeId: string): string {
    this.assertScopeId(scopeId);
    return scopeType === 'company'
      ? path.join(this.rootDir, 'company')
      : path.join(this.rootDir, 'work', scopeId);
  }

  private assertScopeId(scopeId: string): void {
    if (!SAFE_SCOPE_ID.test(scopeId) || scopeId === '.' || scopeId === '..') {
      throw new V3DomainError('INVALID_ARGUMENT', `Invalid v3 scope id: ${scopeId}`);
    }
  }

  private corruption(
    scopeType: ScopeType,
    scopeId: string,
    line: number,
    reason: string,
  ): V3DomainError {
    return new V3DomainError(
      'CORRUPT_EVENT_STREAM',
      `Corrupt ${scopeType} event stream ${scopeId} at line ${line}: ${reason}`,
      { scopeType, scopeId, line, reason },
    );
  }
}

async function withSequentialLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = activeLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  activeLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (activeLocks.get(key) === tail) activeLocks.delete(key);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
