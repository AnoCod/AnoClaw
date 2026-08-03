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
  | 'config'
  | 'structured'
  | 'notebook'
  | 'archive'
  | 'font'
  | 'psd'
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
const CONFIG_EXTENSIONS = new Set([
  'ini', 'cfg', 'conf', 'config', 'cnf', 'toml', 'properties', 'prop', 'env', 'dotenv',
  'editorconfig', 'npmrc', 'yarnrc', 'browserslistrc', 'gitconfig', 'gitmodules',
  'desktop', 'service', 'socket', 'mount', 'target', 'timer', 'inf', 'reg', 'url',
]);
const STRUCTURED_EXTENSIONS = new Set([
  'json', 'jsonc', 'json5', 'geojson', 'topojson', 'webmanifest', 'map', 'jsonl', 'ndjson',
]);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'jar', 'war', 'ear', 'epub', 'apk', 'vsix', 'nupkg']);
const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const WORD_EXTENSIONS = new Set(['doc', 'docx', 'odt']);
const SHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm', 'ods']);
const SLIDE_EXTENSIONS = new Set(['ppt', 'pptx', 'pptm', 'odp']);
const PSD_EXTENSIONS = new Set(['psd', 'psb']);
const BINARY_EXTENSIONS = new Set([
  // Generic blobs, firmware, disk and memory images
  'bin', 'raw', 'rom', 'img', 'iso', 'dmg', 'vhd', 'vhdx', 'vmdk', 'qcow', 'qcow2',
  // Executables, bytecode, libraries and compiler output
  'exe', 'dll', 'sys', 'com', 'msi', 'class', 'wasm', 'pyc', 'pyo', 'o', 'a', 'lib',
  'so', 'dylib', 'dmp', 'core',
  // Databases and analytical/model containers
  'db', 'db3', 'sqlite', 'sqlite3', 'parquet', 'arrow', 'feather', 'avro', 'orc',
  'safetensors', 'pt', 'pth', 'onnx', 'pkl', 'pickle', 'npy', 'npz', 'mat',
  'h5', 'hdf', 'hdf5', 'h4', 'nc', 'cdf', 'fits', 'fit', 'fts',
  // 3D/CAD and specialist binary documents
  'blend', 'glb', '3ds', 'dwg', 'dicom', 'dcm', 'xcf',
  // Non-ZIP archives, packages and ebook containers
  '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', 'deb', 'rpm',
  'mobi', 'azw', 'azw3', 'cab', 'pcap', 'pcapng', 'dex', 'luac', 'ser',
]);

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
  if (CONFIG_EXTENSIONS.has(ext)) return { type: 'config', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (STRUCTURED_EXTENSIONS.has(ext)) return { type: 'structured', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (ext === 'ipynb') return { type: 'notebook', modes: ['preview', 'source'], defaultMode: 'preview' };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { type: 'archive', modes: ['preview'], defaultMode: 'preview' };
  if (FONT_EXTENSIONS.has(ext)) return { type: 'font', modes: ['preview'], defaultMode: 'preview' };
  if (WORD_EXTENSIONS.has(ext)) return { type: 'docx', modes: ['preview'], defaultMode: 'preview' };
  if (SHEET_EXTENSIONS.has(ext)) return { type: 'xlsx', modes: ['preview'], defaultMode: 'preview' };
  if (SLIDE_EXTENSIONS.has(ext)) return { type: 'pptx', modes: ['preview'], defaultMode: 'preview' };
  if (PSD_EXTENSIONS.has(ext)) return { type: 'psd', modes: ['preview'], defaultMode: 'preview' };
  if (BINARY_EXTENSIONS.has(ext)) return { type: 'binary', modes: ['preview'], defaultMode: 'preview' };
  return SOURCE_ONLY;
}

export function workspaceSupportsSource(type: WorkspaceFileType): boolean {
  return ['text', 'svg', 'markdown', 'html', 'csv', 'config', 'structured', 'notebook'].includes(type);
}

export function workspaceSupportsPreview(type: WorkspaceFileType): boolean {
  return type !== 'text' && type !== 'browser';
}
