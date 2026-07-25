import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { V3DomainError } from '../domain/DomainError.js';
import { assertNoSensitiveFields } from '../domain/SensitiveFields.js';

export const V3_MEMORY_SCOPES = [
  'company',
  'team',
  'agent',
  'workspace',
  'work',
  'mission',
] as const;

export type V3MemoryScope = (typeof V3_MEMORY_SCOPES)[number];
export type V3MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface V3MemoryTarget {
  scope: V3MemoryScope;
  targetId: string;
}

export interface V3MemoryEntry extends V3MemoryTarget {
  id: string;
  type: V3MemoryType;
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface V3MemorySaveInput extends V3MemoryTarget {
  type: V3MemoryType;
  name: string;
  description?: string;
  content: string;
  idempotencyKey?: string;
}

export interface V3MemoryDeleteInput extends V3MemoryTarget {
  idOrName: string;
  idempotencyKey?: string;
}

export interface V3MemorySearchInput extends V3MemoryTarget {
  query: string;
  limit?: number;
}

type V3MemoryEvent =
  | {
    type: 'memory_saved';
    fingerprint: string;
    entry: V3MemoryEntry;
  }
  | {
    type: 'memory_deleted';
    fingerprint: string;
    entryId: string;
    name: string;
    deleted: true;
  };

interface V3MemoryEnvelope {
  schemaVersion: 3;
  eventId: string;
  scope: V3MemoryScope;
  targetId: string;
  revision: number;
  occurredAt: string;
  event: V3MemoryEvent;
}

interface MemoryProjection {
  byId: Map<string, V3MemoryEntry>;
  byName: Map<string, string>;
}

const SAFE_TARGET_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_CONTENT_CHARS = 50_000;
const activeLocks = new Map<string, Promise<void>>();

/**
 * Append-only v3 memory storage.
 *
 * Every scope target owns an independent JSONL stream below memory/v3.
 * Target IDs are strict path components and callers must obtain them from
 * server-owned execution context rather than model-supplied parameters.
 */
export class V3ScopedMemoryService {
  private static instance: V3ScopedMemoryService | null = null;

  static getInstance(): V3ScopedMemoryService {
    if (!this.instance) this.instance = new V3ScopedMemoryService();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  readonly rootDir: string;

  constructor(rootDir = path.resolve('memory', 'v3')) {
    this.rootDir = path.resolve(rootDir);
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.rootDir, { recursive: true });
  }

  async save(input: V3MemorySaveInput): Promise<V3MemoryEntry> {
    this.assertTarget(input);
    assertNoSensitiveFields(input);
    const type = requireMemoryType(input.type);
    const name = requireText(input.name, 'name', MAX_NAME_CHARS);
    const description = input.description === undefined
      ? name
      : requireText(input.description, 'description', MAX_DESCRIPTION_CHARS);
    const content = requireText(input.content, 'content', MAX_CONTENT_CHARS);
    assertNoSecretMaterial(description);
    assertNoSecretMaterial(content);
    const eventId = normalizeIdempotencyKey(input.idempotencyKey) ?? randomUUID();
    const fingerprint = operationFingerprint({
      operation: 'save',
      scope: input.scope,
      targetId: input.targetId,
      type,
      name,
      description,
      content,
    });
    const streamPath = this.streamPath(input);

    return withSequentialLock(streamPath, async () => {
      const events = await this.scanStream(input, true);
      const replay = this.replayIdempotentSave(events, eventId, fingerprint);
      if (replay) return replay;

      const projection = project(events);
      const existingId = projection.byName.get(normalizeName(name));
      const existing = existingId ? projection.byId.get(existingId) : undefined;
      const occurredAt = new Date().toISOString();
      const entry: V3MemoryEntry = {
        id: existing?.id ?? randomUUID(),
        scope: input.scope,
        targetId: input.targetId,
        type,
        name,
        description,
        content,
        createdAt: existing?.createdAt ?? occurredAt,
        updatedAt: occurredAt,
      };
      await this.append(streamPath, {
        schemaVersion: 3,
        eventId,
        scope: input.scope,
        targetId: input.targetId,
        revision: events.length + 1,
        occurredAt,
        event: {
          type: 'memory_saved',
          fingerprint,
          entry,
        },
      });
      return cloneEntry(entry);
    });
  }

  async search(input: V3MemorySearchInput): Promise<V3MemoryEntry[]> {
    this.assertTarget(input);
    const query = requireQuery(input.query);
    const limit = normalizeLimit(input.limit);
    const entries = [...project(await this.scanStream(input, false)).byId.values()];
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((candidate) => terms.length === 0 || candidate.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || right.entry.updatedAt.localeCompare(left.entry.updatedAt)
        || left.entry.name.localeCompare(right.entry.name))
      .slice(0, limit)
      .map(({ entry }) => cloneEntry(entry));
  }

  async get(target: V3MemoryTarget, idOrName: string): Promise<V3MemoryEntry | null> {
    this.assertTarget(target);
    const lookup = requireText(idOrName, 'idOrName', MAX_NAME_CHARS);
    const projection = project(await this.scanStream(target, false));
    const byId = projection.byId.get(lookup);
    if (byId) return cloneEntry(byId);
    const id = projection.byName.get(normalizeName(lookup));
    return id ? cloneEntry(projection.byId.get(id) ?? null) : null;
  }

  async delete(input: V3MemoryDeleteInput): Promise<boolean> {
    this.assertTarget(input);
    assertNoSensitiveFields(input);
    const idOrName = requireText(input.idOrName, 'idOrName', MAX_NAME_CHARS);
    const eventId = normalizeIdempotencyKey(input.idempotencyKey) ?? randomUUID();
    const fingerprint = operationFingerprint({
      operation: 'delete',
      scope: input.scope,
      targetId: input.targetId,
      idOrName,
    });
    const streamPath = this.streamPath(input);

    return withSequentialLock(streamPath, async () => {
      const events = await this.scanStream(input, true);
      const replay = this.replayIdempotentDelete(events, eventId, fingerprint);
      if (replay !== null) return replay;

      const projection = project(events);
      const existing = projection.byId.get(idOrName)
        ?? projection.byId.get(projection.byName.get(normalizeName(idOrName)) ?? '');
      if (!existing) return false;
      const occurredAt = new Date().toISOString();
      await this.append(streamPath, {
        schemaVersion: 3,
        eventId,
        scope: input.scope,
        targetId: input.targetId,
        revision: events.length + 1,
        occurredAt,
        event: {
          type: 'memory_deleted',
          fingerprint,
          entryId: existing.id,
          name: existing.name,
          deleted: true,
        },
      });
      return true;
    });
  }

  private assertTarget(target: V3MemoryTarget): void {
    if (!V3_MEMORY_SCOPES.includes(target.scope)) {
      throw new V3DomainError('INVALID_ARGUMENT', `Invalid v3 memory scope: ${String(target.scope)}`);
    }
    if (
      typeof target.targetId !== 'string'
      || !SAFE_TARGET_ID.test(target.targetId)
      || target.targetId === '.'
      || target.targetId === '..'
    ) {
      throw new V3DomainError('INVALID_ARGUMENT', 'Memory targetId must be a safe ID');
    }
  }

  private streamPath(target: V3MemoryTarget): string {
    this.assertTarget(target);
    const targetDir = path.resolve(this.rootDir, target.scope, target.targetId);
    const expectedParent = path.resolve(this.rootDir, target.scope);
    if (path.dirname(targetDir) !== expectedParent) {
      throw new V3DomainError('INVALID_ARGUMENT', 'Memory target resolves outside its scope');
    }
    return path.join(targetDir, 'events.jsonl');
  }

  private async append(streamPath: string, envelope: V3MemoryEnvelope): Promise<void> {
    await fsp.mkdir(path.dirname(streamPath), { recursive: true });
    const handle = await fsp.open(streamPath, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(envelope)}\n`, { encoding: 'utf-8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async scanStream(
    target: V3MemoryTarget,
    repairTruncatedTail: boolean,
  ): Promise<V3MemoryEnvelope[]> {
    const streamPath = this.streamPath(target);
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
    const events: V3MemoryEnvelope[] = [];
    const eventIds = new Set<string>();
    let validBytes = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.replace(/\r$/, '') ?? '';
      const finalUnterminated = index === lines.length - 1 && !hasTrailingNewline;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (finalUnterminated) {
          if (repairTruncatedTail) await fsp.truncate(streamPath, validBytes);
          break;
        }
        throw corruptStream(target, index + 1, 'invalid JSON');
      }
      if (!isValidEnvelope(parsed, target, events.length + 1)) {
        throw corruptStream(target, index + 1, 'invalid envelope or revision gap');
      }
      if (eventIds.has(parsed.eventId)) {
        throw corruptStream(target, index + 1, 'duplicate eventId');
      }
      eventIds.add(parsed.eventId);
      events.push(parsed);
      validBytes += Buffer.byteLength(`${lines[index]}\n`, 'utf-8');
    }
    return events;
  }

  private replayIdempotentSave(
    events: V3MemoryEnvelope[],
    eventId: string,
    fingerprint: string,
  ): V3MemoryEntry | null {
    const existing = events.find((event) => event.eventId === eventId);
    if (!existing) return null;
    if (existing.event.type !== 'memory_saved' || existing.event.fingerprint !== fingerprint) {
      throw idempotencyConflict(eventId);
    }
    return cloneEntry(existing.event.entry);
  }

  private replayIdempotentDelete(
    events: V3MemoryEnvelope[],
    eventId: string,
    fingerprint: string,
  ): boolean | null {
    const existing = events.find((event) => event.eventId === eventId);
    if (!existing) return null;
    if (existing.event.type !== 'memory_deleted' || existing.event.fingerprint !== fingerprint) {
      throw idempotencyConflict(eventId);
    }
    return existing.event.deleted;
  }
}

function project(events: V3MemoryEnvelope[]): MemoryProjection {
  const byId = new Map<string, V3MemoryEntry>();
  const byName = new Map<string, string>();
  for (const envelope of events) {
    if (envelope.event.type === 'memory_saved') {
      const previous = byId.get(envelope.event.entry.id);
      if (previous) byName.delete(normalizeName(previous.name));
      const entry = cloneEntry(envelope.event.entry);
      byId.set(entry.id, entry);
      byName.set(normalizeName(entry.name), entry.id);
      continue;
    }
    const existing = byId.get(envelope.event.entryId);
    if (existing) {
      byName.delete(normalizeName(existing.name));
      byId.delete(existing.id);
    }
  }
  return { byId, byName };
}

function scoreEntry(entry: V3MemoryEntry, terms: string[]): number {
  if (terms.length === 0) return 1;
  const name = entry.name.toLocaleLowerCase();
  const description = entry.description.toLocaleLowerCase();
  const content = entry.content.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.includes(term)) score += 50;
    if (description.includes(term)) score += 20;
    if (content.includes(term)) score += 10;
  }
  return score;
}

function requireMemoryType(value: unknown): V3MemoryType {
  if (value === 'user' || value === 'feedback' || value === 'project' || value === 'reference') {
    return value;
  }
  throw new V3DomainError('INVALID_ARGUMENT', 'Invalid memory type');
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new V3DomainError('INVALID_ARGUMENT', `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new V3DomainError('INVALID_ARGUMENT', `${field} must not be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new V3DomainError('INVALID_ARGUMENT', `${field} must be ${maxLength} characters or less`);
  }
  return trimmed;
}

function requireQuery(value: unknown): string {
  if (typeof value !== 'string') {
    throw new V3DomainError('INVALID_ARGUMENT', 'query must be a string');
  }
  return value.trim();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new V3DomainError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 100');
  }
  return value;
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = requireText(value, 'idempotencyKey', 200);
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new V3DomainError('INVALID_ARGUMENT', 'idempotencyKey cannot contain control characters');
  }
  return trimmed;
}

function assertNoSecretMaterial(value: string): void {
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\bsk-[a-zA-Z0-9_-]{16,}\b/u,
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*\S{8,}/iu,
    /\bauthorization\s*:\s*bearer\s+\S+/iu,
  ];
  if (secretPatterns.some((pattern) => pattern.test(value))) {
    throw new V3DomainError(
      'SENSITIVE_FIELD',
      'Secrets and credentials must not be stored in v3 memory',
    );
  }
}

function operationFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase();
}

function cloneEntry(entry: V3MemoryEntry): V3MemoryEntry;
function cloneEntry(entry: V3MemoryEntry | null): V3MemoryEntry | null;
function cloneEntry(entry: V3MemoryEntry | null): V3MemoryEntry | null {
  return entry ? { ...entry } : null;
}

function isValidEnvelope(
  value: unknown,
  target: V3MemoryTarget,
  revision: number,
): value is V3MemoryEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<V3MemoryEnvelope>;
  if (
    envelope.schemaVersion !== 3
    || envelope.scope !== target.scope
    || envelope.targetId !== target.targetId
    || envelope.revision !== revision
    || typeof envelope.eventId !== 'string'
    || !envelope.eventId
    || typeof envelope.occurredAt !== 'string'
    || !envelope.event
  ) {
    return false;
  }
  if (envelope.event.type === 'memory_saved') {
    const entry = envelope.event.entry;
    return typeof envelope.event.fingerprint === 'string'
      && typeof entry === 'object'
      && entry !== null
      && entry.scope === target.scope
      && entry.targetId === target.targetId
      && typeof entry.id === 'string'
      && typeof entry.name === 'string'
      && typeof entry.description === 'string'
      && typeof entry.content === 'string'
      && typeof entry.createdAt === 'string'
      && typeof entry.updatedAt === 'string';
  }
  return envelope.event.type === 'memory_deleted'
    && typeof envelope.event.fingerprint === 'string'
    && typeof envelope.event.entryId === 'string'
    && typeof envelope.event.name === 'string'
    && envelope.event.deleted === true;
}

function corruptStream(target: V3MemoryTarget, line: number, reason: string): V3DomainError {
  return new V3DomainError(
    'CORRUPT_EVENT_STREAM',
    `Corrupt v3 memory stream ${target.scope}/${target.targetId} at line ${line}: ${reason}`,
  );
}

function idempotencyConflict(eventId: string): V3DomainError {
  return new V3DomainError(
    'REVISION_CONFLICT',
    `Idempotency key "${eventId}" was already used for a different memory operation`,
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function withSequentialLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = activeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (activeLocks.get(key) === current) activeLocks.delete(key);
  }
}
