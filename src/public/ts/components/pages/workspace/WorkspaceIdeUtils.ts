export interface WorkspaceReadResult {
  truncated?: boolean;
  size?: number;
}

export function workspaceModelUri(
  sessionId: string,
  workspacePath: string,
  persistenceScope: string,
  filePath: string,
): string {
  const identity = `${sessionId}\0${workspacePath}\0${persistenceScope}`;
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const authority = `workspace-${(hash >>> 0).toString(16)}`;
  const normalizedPath = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `anoclaw-workspace://${authority}/${normalizedPath}`;
}

export function workspaceReadOnlyReason(result: WorkspaceReadResult): string | undefined {
  if (!result.truncated) return undefined;
  const size = Number(result.size || 0);
  const label = size > 0 ? ` (${formatBytes(size)})` : '';
  return `Read-only preview${label}: only the first 100 KB was loaded.`;
}

export function hasExternalContentChange(diskContent: string, editorContent: string): boolean {
  return diskContent !== editorContent;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
