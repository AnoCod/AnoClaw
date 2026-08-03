export type WorkspaceFileType =
  | 'text'
  | 'image'
  | 'svg'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'structured'
  | 'notebook'
  | 'archive'
  | 'font'
  | 'binary'
  | 'browser'
  | 'docx'
  | 'xlsx'
  | 'pptx';

export type WorkspaceViewMode = 'preview' | 'source';

export interface WorkspaceFileCapability {
  type: WorkspaceFileType;
  modes: readonly WorkspaceViewMode[];
  defaultMode: WorkspaceViewMode;
}

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif',
  'heic', 'heif', 'jfif', 'pjpeg', 'pjp', 'apng', 'jxl', 'jpe',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);
const TABLE_EXTENSIONS = new Set(['csv', 'tsv']);
const STRUCTURED_EXTENSIONS = new Set([
  'json', 'jsonc', 'json5', 'geojson', 'topojson', 'webmanifest', 'map', 'jsonl', 'ndjson',
]);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'jar', 'war', 'ear', 'epub', 'apk', 'vsix', 'nupkg']);
const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const WORD_EXTENSIONS = new Set(['doc', 'docx', 'odt']);
const SHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm', 'ods']);
const SLIDE_EXTENSIONS = new Set(['ppt', 'pptx', 'pptm', 'odp']);

const SOURCE_ONLY: WorkspaceFileCapability = { type: 'text', modes: ['source'], defaultMode: 'source' };

export function workspaceFileExtension(name: string): string {
  const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > -1 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Classifies a file by the preview capability exposed by the read-only Workspace.
 * Unknown files start as text and may be changed to `binary` after content sampling.
 */
export function workspaceFileCapability(name: string): WorkspaceFileCapability {
  const ext = workspaceFileExtension(name);
  if (ext === 'svg') return { type: 'svg', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (IMAGE_EXTENSIONS.has(ext)) return { type: 'image', modes: ['preview'], defaultMode: 'preview' };
  if (AUDIO_EXTENSIONS.has(ext)) return { type: 'audio', modes: ['preview'], defaultMode: 'preview' };
  if (VIDEO_EXTENSIONS.has(ext)) return { type: 'video', modes: ['preview'], defaultMode: 'preview' };
  if (ext === 'pdf') return { type: 'pdf', modes: ['preview'], defaultMode: 'preview' };
  if (MARKDOWN_EXTENSIONS.has(ext)) return { type: 'markdown', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (HTML_EXTENSIONS.has(ext)) return { type: 'html', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (TABLE_EXTENSIONS.has(ext)) return { type: 'csv', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (STRUCTURED_EXTENSIONS.has(ext)) return { type: 'structured', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (ext === 'ipynb') return { type: 'notebook', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { type: 'archive', modes: ['preview'], defaultMode: 'preview' };
  if (FONT_EXTENSIONS.has(ext)) return { type: 'font', modes: ['preview'], defaultMode: 'preview' };
  if (WORD_EXTENSIONS.has(ext)) return { type: 'docx', modes: ['preview'], defaultMode: 'preview' };
  if (SHEET_EXTENSIONS.has(ext)) return { type: 'xlsx', modes: ['preview'], defaultMode: 'preview' };
  if (SLIDE_EXTENSIONS.has(ext)) return { type: 'pptx', modes: ['preview'], defaultMode: 'preview' };
  return SOURCE_ONLY;
}

export function workspaceSupportsSource(type: WorkspaceFileType): boolean {
  return ['text', 'svg', 'markdown', 'html', 'csv', 'structured', 'notebook'].includes(type);
}

export function workspaceSupportsPreview(type: WorkspaceFileType): boolean {
  return type !== 'text' && type !== 'binary' && type !== 'browser';
}
