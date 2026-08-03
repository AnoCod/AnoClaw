// WorkspaceHandlers — read-only workspace browsing, binding, and preview handlers.
// Part of the AnoClaw v2.0 rewrite: Gateway system (SA-10)

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'node:crypto';
import micromatch from 'micromatch';
import type { IncomingMessage, ServerResponse } from 'http';
import { SessionManager } from '../../core/session/SessionManager.js';
import { requireWs } from '../WsRequired.js';
import type { SendJson, ReadBody } from '../RouteHelpers.js';
import { createPsdPreview, PsdPreviewError } from './WorkspacePsdPreview.js';

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers — path resolution + gitignore filtering
// ---------------------------------------------------------------------------

/**
 * Resolve a relative or absolute path against a base (workspace root),
 * enforcing that the result does not escape the base directory.
 *
 * @param base  - Absolute workspace root directory.
 * @param rel   - User-supplied path (may be relative or absolute).
 * @returns Absolute, validated path within the base directory.
 * @throws  If the resolved path escapes the base directory.
 */
export function resolveWorkspacePath(base: string, rel: string): string {
  const absBase = path.resolve(base);
  const rawRel = rel || '';
  let absPath: string;
  if (rawRel === '/' || rawRel === '\\') {
    absPath = absBase;
  } else if (process.platform === 'win32' && /^[/\\]+/.test(rawRel) && !/^[a-zA-Z]:[\\/]/.test(rawRel)) {
    // Browser file-tree paths use POSIX-style workspace-relative paths. On
    // Windows, treat a leading slash as "workspace root", not the drive root.
    absPath = path.resolve(absBase, rawRel.replace(/^[/\\]+/, ''));
  } else if (path.isAbsolute(rawRel)) {
    absPath = path.resolve(rawRel);
  } else {
    absPath = path.resolve(absBase, rawRel);
  }
  const relative = path.relative(absBase, absPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes workspace root');
  }
  assertRealWorkspaceBoundary(absBase, absPath);
  return absPath;
}

function assertRealWorkspaceBoundary(absBase: string, absPath: string): void {
  if (!canLstat(absBase)) return;
  const realBase = fs.realpathSync.native(absBase);
  const existingPath = nearestExistingPath(absPath);
  let realExistingPath: string;
  try {
    realExistingPath = fs.realpathSync.native(existingPath);
  } catch {
    // A broken symlink/reparse point must not be treated as a safe new path.
    throw new Error('Path escapes workspace root');
  }
  const realRelative = path.relative(realBase, realExistingPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('Path escapes workspace root');
  }
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!canLstat(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function canLstat(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Simple path resolution against cwd (legacy mutation handlers without session scope).
 *  Throws on path escape — callers should catch and return 403. */
function workspaceRootForSession(sessionId: string): string {
  if (!sessionId) return process.cwd();
  const session = SessionManager.getInstance().session(sessionId);
  if (!session) {
    throw new Error(`Session '${sessionId}' not found`);
  }
  return path.resolve(session.workspace || process.cwd());
}

function sendWorkspaceError(err: unknown, res: ServerResponse, sendJson: SendJson, fallback: string): void {
  if (err instanceof Error && err.message === 'Path escapes workspace root') {
    sendJson(res, 403, { error: 'Forbidden', message: err.message });
    return;
  }
  if (err instanceof Error && /^Session '.+' not found$/.test(err.message)) {
    sendJson(res, 404, { error: 'Not Found', message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: fallback, message });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Operation timed out')), ms)),
  ]);
}

const RAW_MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.apk': 'application/vnd.android.package-archive',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ear': 'application/java-archive',
  '.epub': 'application/epub+zip',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.topojson': 'application/json; charset=utf-8',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jar': 'application/java-archive',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jxl': 'image/jxl',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.mov': 'video/quicktime',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.nupkg': 'application/zip',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.opus': 'audio/opus',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.pjp': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.psb': 'image/vnd.adobe.photoshop',
  '.psd': 'image/vnd.adobe.photoshop',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ttf': 'font/ttf',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.vsix': 'application/zip',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wav': 'audio/wav',
  '.war': 'application/java-archive',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
};

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

function decodeWorkspaceText(buffer: Buffer): { content: string; encoding: string } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { content: buffer.subarray(3).toString('utf8'), encoding: 'UTF-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { content: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'UTF-16 LE' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { content: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'UTF-16 BE' };
  }
  return { content: buffer.toString('utf8'), encoding: 'UTF-8' };
}

function mimeTypeForFile(filePath: string): string {
  return RAW_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function wantsRawFile(url: URL): boolean {
  const raw = (url.searchParams.get('raw') || '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function rawPreviewCsp(mimeType: string): string | null {
  const mime = mimeType.split(';', 1)[0].toLowerCase();
  if (mime === 'text/html' || mime === 'image/svg+xml' || mime === 'application/xml' || mime === 'text/xml') {
    return [
      'sandbox',
      "default-src 'self' data: blob:",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'none'",
    ].join('; ');
  }
  return null;
}

function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  if (size <= 0) return 'invalid';

  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

async function sendRawWorkspaceFile(req: IncomingMessage, res: ServerResponse, absPath: string, stat: fs.Stats): Promise<void> {
  const mimeType = mimeTypeForFile(absPath);
  const rangeHeader = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
  const range = parseByteRange(rangeHeader, stat.size);

  if (range === 'invalid') {
    res.writeHead(416, {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${stat.size}`,
    });
    res.end();
    return;
  }

  const headers: Record<string, string | number> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': mimeType,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(absPath))}`,
  };
  const csp = rawPreviewCsp(mimeType);
  if (csp) headers['Content-Security-Policy'] = csp;

  if (stat.size === 0) {
    headers['Content-Length'] = 0;
    res.writeHead(200, headers);
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  headers['Content-Length'] = end - start + 1;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absPath, { start, end });
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    stream.on('error', done);
    res.on('finish', () => done());
    res.on('close', () => done());
    stream.pipe(res);
  });
}

/** Load .gitignore patterns from workspace root */
function loadGitignore(workspaceRoot: string): string[] {
  const gitignorePath = path.join(workspaceRoot, '.gitignore');
  try {
    if (!fs.existsSync(gitignorePath)) return [];
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    return content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/** Check if relative path matches root .gitignore patterns used by the file tree. */
export function isGitignored(relPath: string, isDir: boolean, patterns: string[]): boolean {
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return false;

  const segments = rel.split('/').filter(Boolean);
  const matchOptions = { dot: true, nocase: process.platform === 'win32' };

  let ignored = false;
  for (const rawPattern of patterns) {
    const negated = rawPattern.startsWith('!');
    const pattern = (negated ? rawPattern.slice(1) : rawPattern).replace(/\\/g, '/').replace(/^\/+/, '');
    const directoryOnly = pattern.endsWith('/');
    const pat = pattern.replace(/\/+$/, '');
    if (!pat) continue;

    if (!pat.includes('/')) {
      for (let i = 0; i < segments.length; i++) {
        if (!micromatch.isMatch(segments[i], pat, matchOptions)) continue;
        if (!directoryOnly || i < segments.length - 1 || isDir) ignored = !negated;
      }
      continue;
    }

    if (micromatch.isMatch(rel, pat, matchOptions)) {
      if (!directoryOnly || isDir) ignored = !negated;
    }

    if (directoryOnly && micromatch.isMatch(rel, `${pat}/**`, matchOptions)) {
      ignored = !negated;
    }

  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Exported handler functions
// ---------------------------------------------------------------------------

/** GET /api/v1/workspace/browse — List workspace directory contents */
export async function handleBrowseWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  try {
    const baseUrl = 'http://' + host + ':' + port;
    const url = new URL(req.url || '/', baseUrl);
    const sessionId = url.searchParams.get('sessionId') || '';
    const browsePath = url.searchParams.get('path') || '/';

    const workspaceRoot = workspaceRootForSession(sessionId);

    let absPath: string;
    try { absPath = resolveWorkspacePath(workspaceRoot, browsePath); }
    catch { sendJson(res, 403, { error: 'Forbidden', message: 'Path escapes workspace root' }); return; }

    let rootStat: fs.Stats;
    try { rootStat = await fsp.stat(absPath); }
    catch {
      sendJson(res, 404, { error: 'Not Found', message: `Path '${browsePath}' not found` });
      return;
    }
    if (!rootStat.isDirectory()) {
      // Return single file info
      sendJson(res, 200, {
        path: browsePath,
        nodes: [{
          name: path.basename(absPath),
          path: browsePath,
          isDirectory: false,
          size: rootStat.size,
          modifiedAt: rootStat.mtime.toISOString(),
        }],
      });
      return;
    }

    // Load .gitignore patterns
    const gitignorePatterns = loadGitignore(workspaceRoot);

    // Read directory (single level only — lazy loading)
    const entries = await fsp.readdir(absPath, { withFileTypes: true });
    const visibleEntries = entries.filter(entry => {
        const relPath = browsePath === '/'
          ? entry.name
          : `${browsePath.replace(/\/$/, '')}/${entry.name}`;
        return !isGitignored(relPath, entry.isDirectory(), gitignorePatterns);
      });
    const nodes = (await mapWithConcurrency(visibleEntries, 32, async entry => {
        const fullPath = path.join(absPath, entry.name);
        const relPath = browsePath === '/'
          ? entry.name
          : `${browsePath.replace(/\/$/, '')}/${entry.name}`;
        let stat: fs.Stats | null = null;
        try { stat = await fsp.stat(fullPath); } catch { /* permission denied */ }
        return {
          name: entry.name,
          path: relPath,
          isDirectory: entry.isDirectory(),
          size: stat ? stat.size : 0,
          modifiedAt: stat ? stat.mtime.toISOString() : '',
        };
      })).sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    sendJson(res, 200, { path: browsePath, workspaceRoot, nodes });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Browse failed');
  }
}

/** GET /api/v1/workspace/read — Read file contents */
export async function handleReadWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  try {
    const baseUrl = 'http://' + host + ':' + port;
    const url = new URL(req.url || '/', baseUrl);
    const sessionId = url.searchParams.get('sessionId') || '';
    const filePath = url.searchParams.get('path') || '';

    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" query param' });
      return;
    }

    const workspaceRoot = workspaceRootForSession(sessionId);

    let absPath: string;
    try { absPath = resolveWorkspacePath(workspaceRoot, filePath); }
    catch { sendJson(res, 403, { error: 'Forbidden', message: 'Path escapes workspace root' }); return; }

    if (!fs.existsSync(absPath)) {
      sendJson(res, 404, { error: 'Not Found', message: `File '${filePath}' not found` });
      return;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Path is a directory, not a file' });
      return;
    }

    if (wantsRawFile(url)) {
      await sendRawWorkspaceFile(req, res, absPath, stat);
      return;
    }

    const previewBytes = Math.min(stat.size, MAX_TEXT_PREVIEW_BYTES);
    const fd = fs.openSync(absPath, 'r');
    const buffer = Buffer.alloc(previewBytes);
    let bytesRead = 0;
    try {
      bytesRead = previewBytes > 0 ? fs.readSync(fd, buffer, 0, previewBytes, 0) : 0;
    } finally {
      fs.closeSync(fd);
    }
    const decoded = decodeWorkspaceText(buffer.subarray(0, bytesRead));
    const content = decoded.content;
    const truncated = stat.size > MAX_TEXT_PREVIEW_BYTES;

    // Detect language from extension
    const ext = path.extname(absPath).toLowerCase();
    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript',
      '.jsx': 'javascriptreact', '.json': 'json', '.md': 'markdown',
      '.css': 'css', '.html': 'html', '.yaml': 'yaml', '.yml': 'yaml',
      '.py': 'python', '.rs': 'rust', '.go': 'go', '.rb': 'ruby',
      '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
      '.sh': 'bash', '.bash': 'bash', '.txt': 'text', '.svg': 'xml',
      '.xml': 'xml', '.toml': 'toml', '.sql': 'sql',
    };

    sendJson(res, 200, {
      path: filePath,
      content,
      size: stat.size,
      truncated,
      previewBytes: bytesRead,
      encoding: decoded.encoding,
      language: langMap[ext] || 'text',
      modifiedAt: stat.mtime.toISOString(),
      sha256: await fileSha256(absPath),
    });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Read failed');
  }
}

const WORKSPACE_READ_ONLY_RESPONSE = Object.freeze({
  error: 'Method Not Allowed',
  code: 'WORKSPACE_READ_ONLY',
  message: 'Workspace is a read-only file browser. Files and directories cannot be modified from this API.',
});

function rejectWorkspaceMutation(res: ServerResponse, sendJson: SendJson): void {
  sendJson(res, 405, WORKSPACE_READ_ONLY_RESPONSE);
}

/** Legacy mutation endpoint retained only to return a stable read-only response. */
export async function handleCreateWorkspaceDir(
  _req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  _readBody: ReadBody,
): Promise<void> {
  rejectWorkspaceMutation(res, sendJson);
}

/** PATCH /api/v1/sessions/:id/bind-workspace — Bind workspace path */
export async function handleBindWorkspace(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWs(sessionId, res, sendJson)) return;
  try {
    const body = await readBody(req);
    const workspacePath = body.path as string;
    if (!workspacePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" field' });
      return;
    }

    const absPath = path.resolve(workspacePath);

    // Validate absolute path format
    if (process.platform === 'win32') {
      const driveMatch = absPath.match(/^([A-Za-z]):\\/);
      if (!driveMatch) {
        sendJson(res, 400, { error: 'Bad Request', message: 'Path must be absolute (e.g. D:\\projects)' });
        return;
      }
    }

    // Binding is metadata-only. Never create a directory from the Workspace surface.
    let stat: fs.Stats;
    try { stat = await withTimeout(fsp.stat(absPath), 5000, 'bind-stat'); }
    catch (err2: any) {
      sendJson(res, 400, { error: 'Bad Request', message: `Directory must already exist and be readable: ${err2.message || err2}` });
      return;
    }

    if (!stat.isDirectory()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Path is not a directory' });
      return;
    }
    try {
      await withTimeout(fsp.access(absPath, fs.constants.R_OK), 5000, 'bind-access');
    } catch (err2: any) {
      sendJson(res, 400, { error: 'Bad Request', message: `Directory is not readable: ${err2.message || err2}` });
      return;
    }

    // Update session workspace via SessionManager
    const sessionManager = SessionManager.getInstance();
    const session = sessionManager.session(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Not Found', message: `Session '${sessionId}' not found` });
      return;
    }
    await sessionManager.setWorkspace(sessionId, absPath);

    sendJson(res, 200, { sessionId, workspace: absPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Bind failed', message });
  }
}

// ---------------------------------------------------------------------------
// Disabled mutation handlers
// ---------------------------------------------------------------------------

/** Disabled legacy delete endpoint. */
export async function handleDeleteWorkspaceFile(
  _req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  _host: string,
  _port: number,
): Promise<void> {
  rejectWorkspaceMutation(res, sendJson);
}

/** Disabled legacy rename endpoint. */
export async function handleRenameWorkspaceFile(
  _req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  _readBody: ReadBody,
): Promise<void> {
  rejectWorkspaceMutation(res, sendJson);
}

/** Disabled legacy file-creation endpoint. */
export async function handleCreateWorkspaceFile(
  _req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  _readBody: ReadBody,
): Promise<void> {
  rejectWorkspaceMutation(res, sendJson);
}

/** Disabled legacy move endpoint. */
export async function handleMoveWorkspaceFile(
  _req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  _readBody: ReadBody,
): Promise<void> {
  rejectWorkspaceMutation(res, sendJson);
}

/** GET /api/v1/sessions/:id/workspace — Get current workspace path */
export function handleGetWorkspace(
  sessionId: string,
  res: ServerResponse,
  sendJson: SendJson,
): void {
  const session = SessionManager.getInstance().session(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  sendJson(res, 200, {
    sessionId,
    workspace: session.workspace || '',
    defaultWorkspace: path.resolve(process.cwd(), 'workspace', sessionId),
  });
}

/** Disabled legacy file-write endpoint. */
export async function handleWriteWorkspaceFile(
  _req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  _readBody: ReadBody,
): Promise<void> {
  rejectWorkspaceMutation(res, sendJson);
}

// ═══════════════════════════════════════════════════════════════════════
// Office document conversion
// ═══════════════════════════════════════════════════════════════════════

/** Minimal ZIP entry info we extract from central directory. */
export interface ZipEntry {
  name: string;
  /** Byte offset of the local file header (where raw data begins). */
  offset: number;
  /** Compressed size from the central directory record. */
  compSize: number;
  /** Uncompressed (original) size. 0 if stored without compression. */
  uncompSize: number;
  /** Compression method: 0 = stored (no compression), 8 = deflate. */
  method: number;
}

const MAX_OFFICE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_OFFICE_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_OFFICE_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_OFFICE_ZIP_ENTRIES = 3000;
const MAX_OFFICE_COMPRESSION_RATIO = 1000;

class OfficePreviewLimitError extends Error {}

/**
 * Parse the central directory of a ZIP buffer.
 *
 * Searches backwards from the end of the buffer for the End of Central Directory
 * record (EOCD, signature `0x06054b50`). Once found, walks the central directory
 * entries to build a map of filename → ZipEntry.
 *
 * This is a minimal pure-JS ZIP parser — no external dependencies. It handles
 * the subset of ZIP needed for Office Open XML files (.docx/.xlsx/.pptx).
 *
 * @param buf - Full contents of the ZIP file as a Buffer.
 * @returns Map of lowercase filename → ZipEntry. Empty map if EOCD not found.
 */
function parseZipCD(buf: Buffer): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();

  // Find EOCD signature (0x06054b50) — search from end
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      eocdOff = i; break;
    }
  }
  if (eocdOff < 0) return entries;

  const declaredEntryCount = buf.readUint16LE(eocdOff + 10);
  if (declaredEntryCount > MAX_OFFICE_ZIP_ENTRIES) {
    throw new OfficePreviewLimitError(`ZIP archive exceeds ${MAX_OFFICE_ZIP_ENTRIES} entries`);
  }
  const stCdSize = buf.readUint32LE(eocdOff + 12);
  const stCdOff = buf.readUint32LE(eocdOff + 16);
  if (stCdOff < 0 || stCdOff >= buf.length || stCdSize <= 0 || stCdOff + stCdSize > buf.length) return entries;

  let pos = stCdOff;
  const end = stCdOff + stCdSize;
  let totalUncompressed = 0;
  while (pos + 46 <= end) {
    const sig = buf.readUint32LE(pos);
    if (sig !== 0x02014b50) break;
    const method = buf.readUint16LE(pos + 10);
    const compSize = buf.readUint32LE(pos + 20);
    const uncompSize = buf.readUint32LE(pos + 24);
    const nameLen = buf.readUint16LE(pos + 28);
    const extraLen = buf.readUint16LE(pos + 30);
    const commentLen = buf.readUint16LE(pos + 32);
    const localOff = buf.readUint32LE(pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > end) return new Map();
    const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen).replace(/\\/g, '/');
    if (entries.size >= MAX_OFFICE_ZIP_ENTRIES) {
      throw new OfficePreviewLimitError(`ZIP archive exceeds ${MAX_OFFICE_ZIP_ENTRIES} entries`);
    }
    if (uncompSize > MAX_OFFICE_ENTRY_BYTES) {
      throw new OfficePreviewLimitError(`ZIP archive entry is too large: ${name}`);
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > MAX_OFFICE_TOTAL_UNCOMPRESSED_BYTES) {
      throw new OfficePreviewLimitError('ZIP archive expands beyond the preview limit');
    }
    if (compSize > 0 && uncompSize / compSize > MAX_OFFICE_COMPRESSION_RATIO) {
      throw new OfficePreviewLimitError(`ZIP archive compression ratio is unsafe: ${name}`);
    }
    entries.set(name.toLowerCase(), { name, offset: localOff, compSize, uncompSize, method });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Read and decompress a single ZIP entry.
 *
 * Seeks to the entry's local file header offset, validates the signature
 * (`0x04034b50`), skips the variable-length name/extra fields, then reads
 * the compressed data. Decompresses with zlib.inflateRawSync if deflate,
 * returns raw bytes if stored.
 *
 * @param buf - Full ZIP file buffer.
 * @param entry - Entry metadata from {@link parseZipCD}.
 * @returns Decompressed Buffer, or null if the entry is corrupt or unsupported.
 */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  let pos = entry.offset;
  if (pos + 30 > buf.length) return null;
  const sig = buf.readUint32LE(pos);
  if (sig !== 0x04034b50) return null;
  const nameLen = buf.readUint16LE(pos + 26);
  const extraLen = buf.readUint16LE(pos + 28);
  const dataOff = pos + 30 + nameLen + extraLen;
  if (dataOff + entry.compSize > buf.length) return null;
  const raw = buf.subarray(dataOff, dataOff + entry.compSize);
  if (entry.method === 0) {
    return raw.length <= MAX_OFFICE_ENTRY_BYTES && raw.length === entry.uncompSize ? raw : null;
  }
  if (entry.method === 8) {
    let output: Buffer;
    try {
      output = zlib.inflateRawSync(raw, { maxOutputLength: MAX_OFFICE_ENTRY_BYTES });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new OfficePreviewLimitError(`ZIP archive entry expands beyond the preview limit: ${entry.name}`);
      }
      return null;
    }
    if (output.length > MAX_OFFICE_ENTRY_BYTES) return null;
    if (output.length !== entry.uncompSize) return null;
    return output;
  }
  return null;
}

/** Validate ZIP metadata without extracting entry contents. */
function validateZipArchiveMetadata(buf: Buffer): Map<string, ZipEntry> {
  if (buf.length > MAX_OFFICE_FILE_BYTES) {
    throw new OfficePreviewLimitError(`Preview archive exceeds ${MAX_OFFICE_FILE_BYTES} bytes`);
  }
  const entries = parseZipCD(buf);
  if (entries.size === 0) throw new Error('Invalid or empty ZIP archive');
  for (const entry of entries.values()) {
    const headerOffset = entry.offset;
    if (headerOffset + 30 > buf.length || buf.readUint32LE(headerOffset) !== 0x04034b50) {
      throw new Error(`ZIP archive entry has an invalid local header: ${entry.name}`);
    }
    const nameLength = buf.readUint16LE(headerOffset + 26);
    const extraLength = buf.readUint16LE(headerOffset + 28);
    const dataOffset = headerOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compSize > buf.length) {
      throw new Error(`ZIP archive entry exceeds the file boundary: ${entry.name}`);
    }
  }
  return entries;
}

/** Validate ZIP metadata and contents before an Office converter decompresses it. */
export function validateOfficeArchiveBuffer(buf: Buffer): Map<string, ZipEntry> {
  const entries = validateZipArchiveMetadata(buf);
  let actualUncompressedBytes = 0;
  for (const entry of entries.values()) {
    const content = readZipEntry(buf, entry);
    if (content === null) {
      throw new Error(`ZIP archive entry cannot be safely decompressed: ${entry.name}`);
    }
    actualUncompressedBytes += content.length;
    if (actualUncompressedBytes > MAX_OFFICE_TOTAL_UNCOMPRESSED_BYTES) {
      throw new OfficePreviewLimitError('ZIP archive expands beyond the preview limit');
    }
    if (entry.compSize > 0 && content.length / entry.compSize > MAX_OFFICE_COMPRESSION_RATIO) {
      throw new OfficePreviewLimitError(`ZIP archive compression ratio is unsafe: ${entry.name}`);
    }
  }
  return entries;
}

const BROWSABLE_ARCHIVE_EXTENSIONS = new Set(['.zip', '.jar', '.war', '.ear', '.epub', '.apk', '.vsix', '.nupkg']);

const PSD_PREVIEW_EXTENSIONS = new Set(['.psd', '.psb']);

/** GET /api/v1/workspace/preview-psd — Render only a saved merged PSD/PSB preview. */
export async function handlePreviewWorkspacePsd(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const sessionId = url.searchParams.get('sessionId') || '';
    const filePath = url.searchParams.get('path') || '';
    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" query param' });
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!PSD_PREVIEW_EXTENSIONS.has(extension)) {
      sendJson(res, 400, { error: 'Bad Request', message: `Unsupported Photoshop format: ${extension || '(none)'}` });
      return;
    }

    const absPath = resolveWorkspacePath(workspaceRootForSession(sessionId), filePath);
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Photoshop preview path is not a file' });
      return;
    }

    const preview = await createPsdPreview(absPath, stat.size);
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': preview.mimeType,
      'Content-Length': preview.data.length,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${path.basename(filePath, extension)}-preview${preview.mimeType === 'image/png' ? '.png' : '.jpg'}`)}`,
      'X-Content-Type-Options': 'nosniff',
      'X-AnoClaw-Psd-Source': preview.source,
      'X-AnoClaw-Image-Width': preview.width,
      'X-AnoClaw-Image-Height': preview.height,
    });
    res.end(preview.data);
  } catch (err) {
    if (err instanceof PsdPreviewError) {
      sendJson(res, err.statusCode, { error: 'Photoshop preview failed', message: err.message });
      return;
    }
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Not Found', message: 'Photoshop document not found' });
      return;
    }
    sendWorkspaceError(err, res, sendJson, 'Photoshop preview failed');
  }
}

/** GET /api/v1/workspace/inspect-archive — Safely list a ZIP-family archive. */
export async function handleInspectWorkspaceArchive(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const sessionId = url.searchParams.get('sessionId') || '';
    const filePath = url.searchParams.get('path') || '';
    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" query param' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!BROWSABLE_ARCHIVE_EXTENSIONS.has(ext)) {
      sendJson(res, 400, { error: 'Bad Request', message: `Unsupported archive format: ${ext || '(none)'}` });
      return;
    }

    const absPath = resolveWorkspacePath(workspaceRootForSession(sessionId), filePath);
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Archive path is not a file' });
      return;
    }
    if (stat.size > MAX_OFFICE_FILE_BYTES) {
      throw new OfficePreviewLimitError(`Archive exceeds ${MAX_OFFICE_FILE_BYTES} bytes`);
    }

    const buffer = await fsp.readFile(absPath);
    const parsed = validateZipArchiveMetadata(buffer);
    const entries = [...parsed.values()]
      .map(entry => ({
        path: entry.name,
        size: entry.uncompSize,
        compressedSize: entry.compSize,
        compression: entry.method === 0 ? 'stored' : entry.method === 8 ? 'deflate' : `method-${entry.method}`,
        isDirectory: entry.name.endsWith('/'),
      }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));

    sendJson(res, 200, {
      type: 'archive',
      path: filePath,
      size: stat.size,
      entryCount: entries.length,
      entries,
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'Path escapes workspace root') {
      sendJson(res, 403, { error: 'Forbidden', message: err.message });
      return;
    }
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'Not Found', message: 'Archive not found' });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof OfficePreviewLimitError ? 413 : 500;
    sendJson(res, status, { error: 'Archive preview failed', message });
  }
}

/**
 * Strip XML tags and decode entities to produce plain text.
 *
 * Removes all `<tag>` markup, decodes the 5 standard XML entities
 * (`&amp; &lt; &gt; &quot; &apos;`) plus numeric character references
 * (`&#65;` → "A"). Collapses whitespace runs to single spaces.
 *
 * Used by Office Open XML converters to extract human-readable text
 * from spreadsheet shared strings and presentation slide XML.
 *
 * @param xml - Raw XML buffer (e.g. xl/sharedStrings.xml from an .xlsx file).
 * @returns Plain text string with all markup removed.
 */
function decodeXmlEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCharCode(Number.parseInt(d, 16)));
}

function extractXmlText(xml: Buffer): string {
  const s = xml.toString('utf-8');
  // Remove XML tags, keep content
  return decodeXmlEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const items = xml.match(/<si[\s\S]*?<\/si>/g) || [];
  for (const item of items) {
    const textParts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map(match => decodeXmlEntities(match[1]));
    strings.push(textParts.join(''));
  }
  return strings;
}

function columnIndexFromCellRef(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/i)?.[0] || '').toUpperCase();
  if (!letters) return -1;
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function extractCellText(cellXml: string, sharedStrings: string[]): string {
  const type = cellXml.match(/\st="([^"]+)"/)?.[1] || '';
  if (type === 'inlineStr') {
    return [...cellXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map(match => decodeXmlEntities(match[1]))
      .join('');
  }

  const value = cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] || '';
  if (!value) return '';
  if (type === 's') return sharedStrings[Number(value)] || '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return decodeXmlEntities(value);
}

function parseXlsxRows(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowMatches = sheetXml.match(/<row\b[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rowMatches.slice(0, 200)) {
    const row: string[] = [];
    const cells = rowXml.match(/<c\b[\s\S]*?<\/c>/g) || [];
    for (const cellXml of cells) {
      const ref = cellXml.match(/\sr="([^"]+)"/)?.[1] || '';
      const col = columnIndexFromCellRef(ref);
      if (col < 0 || col >= 50) continue;
      row[col] = extractCellText(cellXml, sharedStrings);
    }
    while (row.length > 0 && !row[row.length - 1]) row.pop();
    if (row.some(cell => cell && cell.trim())) rows.push(row.map(cell => cell || ''));
  }
  return rows;
}

/**
 * GET /api/v1/workspace/convert-office — Convert Office documents to HTML or plain text for preview.
 *
 * Supported formats and their converters:
 * - **.docx** — mammoth library → semantic HTML (tables, headings, images preserved).
 * - **.xlsx / .xlsm** — Pure-JS ZIP reader extracts shared strings and sheet data as text.
 * - **.pptx / .pptm** — Reads slide text from ppt/slides/slideN.xml inside the ZIP.
 * - **.odt / .ods / .odp** — Extracts text from content.xml (OpenDocument format).
 * - **.doc / .xls / .ppt** — Legacy binary format, returns a message suggesting re-save as .docx/.xlsx.
 *
 * Response shape: `{ type: 'html'|'text'|'image', html?: string, content?: string, dataUrl?: string }`
 *
 * Query params: `path` (required) — file path relative to session workspace. `sessionId` (optional).
 *
 * @param req - Incoming HTTP request.
 * @param res - Server response.
 * @param sendJson - Response helper for JSON output.
 * @param host - Server host (for URL parsing).
 * @param port - Server port.
 */
export async function handleConvertOffice(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  try {
    const baseUrl = 'http://' + host + ':' + port;
    const url = new URL(req.url || '/', baseUrl);
    const sessionId = url.searchParams.get('sessionId') || '';
    const filePath = url.searchParams.get('path') || '';

    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path"' });
      return;
    }

    // Resolve path
    const workspaceRoot = workspaceRootForSession(sessionId);
    let absPath: string;
    try { absPath = resolveWorkspacePath(workspaceRoot, filePath); }
    catch { sendJson(res, 403, { error: 'Forbidden', message: 'Path escapes workspace' }); return; }

    if (!fs.existsSync(absPath)) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
      sendJson(res, 200, { type: 'text', content: 'Legacy Office format (.doc/.xls/.ppt). Save as .docx/.xlsx/.pptx for preview.' });
      return;
    }
    const supportedArchiveExtensions = new Set(['.docx', '.xlsx', '.xlsm', '.pptx', '.pptm', '.odt', '.ods', '.odp']);
    if (!supportedArchiveExtensions.has(ext)) {
      sendJson(res, 400, { error: 'Bad Request', message: `Unsupported format: ${ext}` });
      return;
    }
    const stat = await fsp.stat(absPath);
    if (stat.size > MAX_OFFICE_FILE_BYTES) {
      throw new OfficePreviewLimitError(`Office file exceeds ${MAX_OFFICE_FILE_BYTES} bytes`);
    }
    const buf = await fsp.readFile(absPath);
    const entries = validateOfficeArchiveBuffer(buf);

    // ── .docx → mammoth ──
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.convertToHtml({ buffer: buf });
      sendJson(res, 200, { type: 'html', html: result.value, warnings: result.messages });
      return;
    }

    // ── .xlsx / .xlsm → extract shared strings + sheet data ──
    if (ext === '.xlsx' || ext === '.xlsm') {
      // Try shared strings first
      const ssEntry = entries.get('xl/sharedstrings.xml');
      let sharedStrings: string[] = [];
      if (ssEntry) {
        const raw = readZipEntry(buf, ssEntry);
        if (raw) {
          const xml = raw.toString('utf-8');
          sharedStrings = parseSharedStrings(xml);
        }
      }

      const sheetEntries = [...entries.values()]
        .filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
        .sort((a, b) => {
          const aNumber = Number(a.name.match(/sheet(\d+)\.xml$/i)?.[1] || 0);
          const bNumber = Number(b.name.match(/sheet(\d+)\.xml$/i)?.[1] || 0);
          return aNumber - bNumber;
        })
        .slice(0, 20);
      const sheets: Array<{ name: string; rows: string[][] }> = [];
      for (const [index, sheetEntry] of sheetEntries.entries()) {
        const raw = readZipEntry(buf, sheetEntry);
        if (!raw) continue;
        const rows = parseXlsxRows(raw.toString('utf-8'), sharedStrings);
        sheets.push({ name: `Sheet ${index + 1}`, rows });
      }
      if (sheets.length > 0) {
        sendJson(res, 200, { type: 'workbook', sheets });
        return;
      }
      sendJson(res, 200, { type: 'text', content: sharedStrings.join(' ') || '(no readable content)' });
      return;
    }

    // ── .pptx / .ppt → extract slide text ──
    if (ext === '.pptx' || ext === '.pptm') {
      const slideEntries = [...entries.values()]
        .filter(e => e.name.match(/^ppt\/slides\/slide\d+\.xml$/))
        .sort((a, b) => {
          const aNumber = Number(a.name.match(/slide(\d+)\.xml$/)?.[1] || 0);
          const bNumber = Number(b.name.match(/slide(\d+)\.xml$/)?.[1] || 0);
          return aNumber - bNumber;
        });

      if (slideEntries.length > 0) {
        const slides: string[] = [];
        for (const entry of slideEntries) {
          const raw = readZipEntry(buf, entry);
          if (raw) {
            const text = extractXmlText(raw);
            if (text) slides.push(text);
          }
        }
        if (slides.length > 0) {
          sendJson(res, 200, { type: 'slides', slides: slides.map((text, index) => ({ number: index + 1, text })) });
          return;
        }
      }
      sendJson(res, 200, { type: 'text', content: '(no slide text found)' });
      return;
    }

    // ── .odt / .ods / .odp (OpenDocument) — extract content.xml ──
    if (ext === '.odt' || ext === '.ods' || ext === '.odp') {
      const contentEntry = entries.get('content.xml');
      if (contentEntry) {
        const raw = readZipEntry(buf, contentEntry);
        if (raw) {
          const text = extractXmlText(raw);
          sendJson(res, 200, { type: 'text', content: text || '(no content)' });
          return;
        }
      }
      sendJson(res, 200, { type: 'text', content: '(no readable content)' });
      return;
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof OfficePreviewLimitError ? 413 : 500;
    sendJson(res, status, { error: 'Convert failed', message });
  }
}
