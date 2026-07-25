import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SessionTranscriptRecord,
  TranscriptEntry,
} from '../../../../shared/types/v3/index.js';
import { V3DomainError } from '../domain/DomainError.js';
import { assertNoSensitiveFields } from '../domain/SensitiveFields.js';

export interface AppendTranscriptOptions {
  expectedSequence: number;
  entryId?: string;
  occurredAt?: string;
}

const activeLocks = new Map<string, Promise<void>>();
const SAFE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Stores only the ordered transcript for a Session. Run/task lifecycle state
 * belongs to WorkRepository and is intentionally excluded from these files.
 */
export class SessionTranscriptRepository {
  readonly rootDir: string;
  private readonly clock: () => string;

  constructor(
    rootDir = path.resolve('data', 'v3'),
    options: { clock?: () => string } = {},
  ) {
    this.rootDir = path.resolve(rootDir);
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async append(
    sessionId: string,
    entry: TranscriptEntry,
    options: AppendTranscriptOptions,
  ): Promise<SessionTranscriptRecord> {
    this.assertSessionId(sessionId);
    if (!Number.isSafeInteger(options.expectedSequence) || options.expectedSequence < 0) {
      throw new V3DomainError(
        'INVALID_ARGUMENT',
        'expectedSequence must be a non-negative integer',
      );
    }
    assertNoSensitiveFields(entry);
    const entryId = options.entryId ?? entry.id;
    if (!entryId.trim()) throw new V3DomainError('INVALID_ARGUMENT', 'entryId is required');
    const transcriptPath = this.transcriptPath(sessionId);

    return withSequentialLock(transcriptPath, async () => {
      await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });
      const records = await this.scan(sessionId, true);
      const existing = records.find((record) => record.entryId === entryId);
      if (existing) return existing;
      const currentSequence = records.at(-1)?.sequence ?? 0;
      if (options.expectedSequence !== currentSequence) {
        throw new V3DomainError(
          'REVISION_CONFLICT',
          `Expected transcript sequence ${options.expectedSequence}, current sequence is ${currentSequence}`,
          { expectedSequence: options.expectedSequence, currentSequence, sessionId },
        );
      }
      const record: SessionTranscriptRecord = {
        schemaVersion: 3,
        sessionId,
        sequence: currentSequence + 1,
        entryId,
        occurredAt: options.occurredAt ?? this.clock(),
        entry,
      };
      const handle = await fsp.open(transcriptPath, 'a');
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf-8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      return record;
    });
  }

  async read(sessionId: string): Promise<SessionTranscriptRecord[]> {
    this.assertSessionId(sessionId);
    return this.scan(sessionId, false);
  }

  private async scan(
    sessionId: string,
    repairTruncatedTail: boolean,
  ): Promise<SessionTranscriptRecord[]> {
    const transcriptPath = this.transcriptPath(sessionId);
    let raw: string;
    try {
      raw = await fsp.readFile(transcriptPath, 'utf-8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
    if (!raw) return [];

    const hasTrailingNewline = raw.endsWith('\n');
    const lines = raw.split('\n');
    if (hasTrailingNewline) lines.pop();
    const records: SessionTranscriptRecord[] = [];
    const entryIds = new Set<string>();
    let truncatedTail = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.replace(/\r$/, '') ?? '';
      const isFinalUnterminatedRecord = index === lines.length - 1 && !hasTrailingNewline;
      if (!line) throw this.corruption(sessionId, index + 1, 'empty record');
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (isFinalUnterminatedRecord) {
          truncatedTail = true;
          break;
        }
        throw this.corruption(sessionId, index + 1, 'invalid JSON');
      }
      const record = parsed as Partial<SessionTranscriptRecord>;
      if (
        record.schemaVersion !== 3
        || record.sessionId !== sessionId
        || record.sequence !== records.length + 1
        || typeof record.entryId !== 'string'
        || !record.entryId
        || typeof record.occurredAt !== 'string'
        || typeof record.entry !== 'object'
        || record.entry === null
      ) {
        throw this.corruption(sessionId, index + 1, 'invalid record or sequence gap');
      }
      if (entryIds.has(record.entryId)) {
        throw this.corruption(sessionId, index + 1, 'duplicate entryId');
      }
      assertNoSensitiveFields(record.entry);
      entryIds.add(record.entryId);
      records.push(record as SessionTranscriptRecord);
    }

    if (truncatedTail && repairTruncatedTail) {
      const lastNewline = raw.lastIndexOf('\n');
      await fsp.truncate(transcriptPath, lastNewline < 0 ? 0 : Buffer.byteLength(
        raw.slice(0, lastNewline + 1),
        'utf-8',
      ));
    } else if (!hasTrailingNewline && repairTruncatedTail) {
      await fsp.appendFile(transcriptPath, '\n', 'utf-8');
    }
    return records;
  }

  private transcriptPath(sessionId: string): string {
    return path.join(this.rootDir, 'session', sessionId, 'transcript.jsonl');
  }

  private assertSessionId(sessionId: string): void {
    if (!SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
      throw new V3DomainError('INVALID_ARGUMENT', `Invalid session id: ${sessionId}`);
    }
  }

  private corruption(sessionId: string, line: number, reason: string): V3DomainError {
    return new V3DomainError(
      'CORRUPT_EVENT_STREAM',
      `Corrupt session transcript ${sessionId} at line ${line}: ${reason}`,
      { sessionId, line, reason },
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
