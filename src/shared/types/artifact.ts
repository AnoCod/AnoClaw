export type ArtifactKind =
  | 'presentation'
  | 'document'
  | 'spreadsheet'
  | 'pdf'
  | 'image'
  | 'web_report'
  | 'table_analysis'
  | 'mindmap'
  | 'automation_result'
  | 'other';

export type ArtifactStatus =
  | 'draft'
  | 'working'
  | 'ready'
  | 'done'
  | 'failed'
  | 'archived';

export type ArtifactPreviewType =
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'table'
  | 'json';

export interface ArtifactFile {
  path: string;
  label?: string;
  mimeType?: string;
  sizeBytes?: number;
  role?: 'primary' | 'preview' | 'source' | 'export' | 'attachment';
}

export interface ArtifactPreview {
  type: ArtifactPreviewType;
  content?: string;
  path?: string;
  mimeType?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  createdAt: string;
  title?: string;
  summary?: string;
  filePaths: string[];
  preview?: ArtifactPreview;
  metadata?: Record<string, unknown>;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  title: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
  capabilityId?: string;
  taskId?: string;
  description?: string;
  files: ArtifactFile[];
  preview?: ArtifactPreview;
  versions: ArtifactVersion[];
  metadata: Record<string, unknown>;
  error?: string;
}

export interface CreateArtifactInput {
  sessionId: string;
  title: string;
  kind: ArtifactKind;
  status?: ArtifactStatus;
  capabilityId?: string;
  taskId?: string;
  description?: string;
  files?: ArtifactFile[];
  preview?: Omit<ArtifactPreview, 'createdAt'> & { createdAt?: string };
  metadata?: Record<string, unknown>;
}

export interface UpdateArtifactInput {
  title?: string;
  status?: ArtifactStatus;
  description?: string;
  files?: ArtifactFile[];
  preview?: Omit<ArtifactPreview, 'createdAt'> & { createdAt?: string };
  metadata?: Record<string, unknown>;
  error?: string | null;
  createVersion?: boolean;
  versionSummary?: string;
}

export interface ArtifactListFilters {
  sessionId?: string;
  kind?: ArtifactKind;
  status?: ArtifactStatus;
  limit?: number;
}
