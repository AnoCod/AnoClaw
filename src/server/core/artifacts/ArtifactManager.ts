import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactFile,
  ArtifactKind,
  ArtifactListFilters,
  ArtifactPreview,
  ArtifactRecord,
  ArtifactStatus,
  CreateArtifactInput,
  UpdateArtifactInput,
} from '../../../shared/types/artifact.js';
import { TypedEventBus } from '../events/TypedEventBus.js';

const DEFAULT_ROOT = path.join(process.cwd(), 'data', 'artifacts');

export class ArtifactManager {
  private static _instance: ArtifactManager | null = null;

  static getInstance(): ArtifactManager {
    if (!this._instance) this._instance = new ArtifactManager();
    return this._instance;
  }

  static resetInstance(): void {
    this._instance = null;
  }

  constructor(private readonly _rootDir = DEFAULT_ROOT) {}

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const now = new Date().toISOString();
    const artifact: ArtifactRecord = {
      id: makeArtifactId(),
      sessionId: requireText(input.sessionId, 'sessionId'),
      title: requireText(input.title, 'title'),
      kind: requireKind(input.kind),
      status: input.status || 'draft',
      createdAt: now,
      updatedAt: now,
      doneAt: isDoneStatus(input.status) ? now : undefined,
      capabilityId: cleanOptionalText(input.capabilityId),
      taskId: cleanOptionalText(input.taskId),
      description: cleanOptionalText(input.description),
      files: normalizeFiles(input.files || []),
      preview: input.preview ? normalizePreview(input.preview, now) : undefined,
      versions: [],
      metadata: isRecord(input.metadata) ? input.metadata : {},
    };
    artifact.versions.push(createVersion(artifact, 'Initial artifact'));
    await this._write(artifact);
    TypedEventBus.emit('artifact:created', { sessionId: artifact.sessionId, artifactId: artifact.id, artifact });
    if (artifact.preview) {
      TypedEventBus.emit('artifact:preview', { sessionId: artifact.sessionId, artifactId: artifact.id, artifact, preview: artifact.preview });
    }
    if (isDoneStatus(artifact.status)) {
      TypedEventBus.emit('artifact:done', { sessionId: artifact.sessionId, artifactId: artifact.id, artifact });
    }
    return artifact;
  }

  async update(sessionId: string, artifactId: string, input: UpdateArtifactInput): Promise<ArtifactRecord> {
    const artifact = await this.get(sessionId, artifactId);
    const now = new Date().toISOString();
    if (typeof input.title === 'string' && input.title.trim()) artifact.title = input.title.trim();
    if (input.status) artifact.status = input.status;
    if (typeof input.description === 'string') artifact.description = input.description.trim() || undefined;
    if (input.files) artifact.files = normalizeFiles(input.files);
    if (input.preview) artifact.preview = normalizePreview(input.preview, now);
    if (isRecord(input.metadata)) artifact.metadata = { ...artifact.metadata, ...input.metadata };
    if (input.error === null) delete artifact.error;
    else if (typeof input.error === 'string') artifact.error = input.error;
    artifact.updatedAt = now;
    artifact.doneAt = isDoneStatus(artifact.status) ? (artifact.doneAt || now) : undefined;
    if (input.createVersion !== false) {
      artifact.versions.push(createVersion(artifact, input.versionSummary));
    }
    await this._write(artifact);
    TypedEventBus.emit('artifact:updated', { sessionId: artifact.sessionId, artifactId: artifact.id, artifact });
    if (artifact.preview) {
      TypedEventBus.emit('artifact:preview', { sessionId: artifact.sessionId, artifactId: artifact.id, artifact, preview: artifact.preview });
    }
    if (isDoneStatus(artifact.status)) {
      TypedEventBus.emit('artifact:done', { sessionId: artifact.sessionId, artifactId: artifact.id, artifact });
    }
    return artifact;
  }

  async get(sessionId: string, artifactId: string): Promise<ArtifactRecord> {
    const file = this._artifactFile(sessionId, artifactId);
    const raw = await fs.readFile(file, 'utf8').catch(() => {
      throw new Error(`Artifact '${artifactId}' not found`);
    });
    return JSON.parse(raw) as ArtifactRecord;
  }

  async list(filters: ArtifactListFilters = {}): Promise<ArtifactRecord[]> {
    const limit = Math.max(1, Math.min(500, filters.limit || 100));
    const sessionIds = filters.sessionId ? [filters.sessionId] : await this._sessionIds();
    const artifacts: ArtifactRecord[] = [];
    for (const sessionId of sessionIds) {
      const dir = this._sessionDir(sessionId);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const artifact = await this.get(sessionId, entry.name);
          if (filters.kind && artifact.kind !== filters.kind) continue;
          if (filters.status && artifact.status !== filters.status) continue;
          artifacts.push(artifact);
        } catch {
          // Ignore incomplete artifact folders.
        }
      }
    }
    return artifacts
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  private async _write(artifact: ArtifactRecord): Promise<void> {
    const dir = this._artifactDir(artifact.sessionId, artifact.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  }

  private async _sessionIds(): Promise<string[]> {
    const entries = await fs.readdir(this._rootDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  private _sessionDir(sessionId: string): string {
    return path.join(this._rootDir, safeSegment(sessionId));
  }

  private _artifactDir(sessionId: string, artifactId: string): string {
    return path.join(this._sessionDir(sessionId), safeSegment(artifactId));
  }

  private _artifactFile(sessionId: string, artifactId: string): string {
    return path.join(this._artifactDir(sessionId, artifactId), 'artifact.json');
  }
}

function createVersion(artifact: ArtifactRecord, summary?: string): ArtifactRecord['versions'][number] {
  return {
    id: `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    version: artifact.versions.length + 1,
    createdAt: new Date().toISOString(),
    title: artifact.title,
    summary,
    filePaths: artifact.files.map((file) => file.path),
    preview: artifact.preview,
    metadata: artifact.metadata,
  };
}

function normalizePreview(preview: Omit<ArtifactPreview, 'createdAt'> & { createdAt?: string }, fallbackCreatedAt: string): ArtifactPreview {
  return {
    type: preview.type,
    content: cleanOptionalText(preview.content),
    path: cleanOptionalText(preview.path),
    mimeType: cleanOptionalText(preview.mimeType),
    createdAt: preview.createdAt || fallbackCreatedAt,
    metadata: isRecord(preview.metadata) ? preview.metadata : undefined,
  };
}

function normalizeFiles(files: ArtifactFile[]): ArtifactFile[] {
  return files
    .filter((file) => typeof file.path === 'string' && file.path.trim())
    .map((file) => ({
      path: file.path.trim(),
      label: cleanOptionalText(file.label),
      mimeType: cleanOptionalText(file.mimeType),
      sizeBytes: typeof file.sizeBytes === 'number' && Number.isFinite(file.sizeBytes) ? file.sizeBytes : undefined,
      role: file.role,
    }));
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function requireKind(value: unknown): ArtifactKind {
  const allowed = new Set<ArtifactKind>([
    'presentation',
    'document',
    'spreadsheet',
    'pdf',
    'image',
    'web_report',
    'table_analysis',
    'mindmap',
    'automation_result',
    'other',
  ]);
  if (typeof value === 'string' && allowed.has(value as ArtifactKind)) return value as ArtifactKind;
  throw new Error('kind is required');
}

function cleanOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isDoneStatus(status: ArtifactStatus | undefined): boolean {
  return status === 'done' || status === 'ready';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function makeArtifactId(): string {
  return `art-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
