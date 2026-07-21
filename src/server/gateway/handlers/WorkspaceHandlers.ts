// WorkspaceHandlers — workspace file-browsing and binding HTTP handlers extracted from ApiServer
// Handles: browse workspace, read workspace file, create directory, bind workspace
// Part of the AnoClaw v2.0 rewrite: Gateway system (SA-10)

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import micromatch from 'micromatch';
import type { IncomingMessage, ServerResponse } from 'http';
import { SessionManager } from '../../core/session/SessionManager.js';
import { requireWs, requireWsAny } from '../WsRequired.js';
import type { SendJson, ReadBody } from '../RouteHelpers.js';

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

function resolveToAbs(filePath: string, sessionId = ''): string {
  return resolveWorkspacePath(workspaceRootForSession(sessionId), filePath);
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

function isPlainFileName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Operation timed out')), ms)),
  ]);
}

const RAW_MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};

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
      .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
  } catch {
    return [];
  }
}

/** Check if relative path matches root .gitignore patterns used by the file tree. */
function isGitignored(relPath: string, isDir: boolean, patterns: string[]): boolean {
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return false;

  const segments = rel.split('/').filter(Boolean);
  const matchOptions = { dot: true, nocase: process.platform === 'win32' };

  for (const rawPattern of patterns) {
    const pattern = rawPattern.replace(/\\/g, '/').replace(/^\/+/, '');
    const directoryOnly = pattern.endsWith('/');
    const pat = pattern.replace(/\/+$/, '');
    if (!pat) continue;

    if (!pat.includes('/')) {
      for (let i = 0; i < segments.length; i++) {
        if (!micromatch.isMatch(segments[i], pat, matchOptions)) continue;
        if (!directoryOnly || i < segments.length - 1 || isDir) return true;
      }
      continue;
    }

    if (micromatch.isMatch(rel, pat, matchOptions)) {
      if (!directoryOnly || isDir) return true;
    }

    if (directoryOnly && micromatch.isMatch(rel, `${pat}/**`, matchOptions)) {
      return true;
    }

  }
  return false;
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

    const maxSize = 100 * 1024; // 100KB
    let content: string;
    let truncated = false;

    if (stat.size > maxSize) {
      // Large file: read first ~2000 lines (approximate via maxSize bytes)
      const fd = fs.openSync(absPath, 'r');
      const buf = Buffer.alloc(maxSize);
      const bytesRead = fs.readSync(fd, buf, 0, maxSize, 0);
      fs.closeSync(fd);
      content = buf.toString('utf-8', 0, bytesRead);
      truncated = true;
    } else {
      content = fs.readFileSync(absPath, 'utf-8');
    }

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
      language: langMap[ext] || 'text',
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Read failed');
  }
}

/** POST /api/v1/workspace/create-dir — Create directory */
export async function handleCreateWorkspaceDir(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const parentPath = String(body.path || '/');

    const dirName = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : null;

    if (dirName && !isPlainFileName(dirName)) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Invalid directory name' });
      return;
    }

    const absParentPath = resolveToAbs(parentPath, sessionId);
    const absPath = dirName
      ? path.join(absParentPath, dirName)
      : absParentPath;

    if (fs.existsSync(absPath)) {
      sendJson(res, 409, { error: 'Conflict', message: `Directory already exists` });
      return;
    }

    fs.mkdirSync(absPath, { recursive: true });

    const relPath = dirName
      ? (parentPath === '/' ? dirName : `${parentPath.replace(/\/$/, '')}/${dirName}`)
      : parentPath;
    sendJson(res, 200, { path: relPath, created: true });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Create directory failed');
  }
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

    // Async fs with timeout to prevent blocking on inaccessible drives
    let stat: fs.Stats;
    try { stat = await withTimeout(fsp.stat(absPath), 5000, 'bind-stat'); }
    catch {
      try { await withTimeout(fsp.mkdir(absPath, { recursive: true }), 5000, 'bind-mkdir'); stat = await withTimeout(fsp.stat(absPath), 5000, 'bind-stat2'); }
      catch (err2: any) {
        sendJson(res, 400, { error: 'Bad Request', message: `Cannot access or create directory: ${err2.message || err2}` });
        return;
      }
    }

    if (!stat.isDirectory()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Path is not a directory' });
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
// Mutation handlers
// ---------------------------------------------------------------------------

/** DELETE /api/v1/workspace/file — Delete a file or directory */
export async function handleDeleteWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const baseUrl = 'http://' + host + ':' + port;
    const url = new URL(req.url || '/', baseUrl);
    const sessionId = url.searchParams.get('sessionId') || '';
    const filePath = url.searchParams.get('path') || '';

    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" query param' });
      return;
    }

    const absPath = resolveToAbs(filePath, sessionId);

    if (!fs.existsSync(absPath)) {
      sendJson(res, 404, { error: 'Not Found', message: `Path '${filePath}' not found` });
      return;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      fs.rmSync(absPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(absPath);
    }

    const fileName = path.basename(absPath);
    sendJson(res, 200, { path: filePath, deleted: true, name: fileName });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Delete failed');
  }
}

/** PATCH /api/v1/workspace/rename — Rename a file or directory */
export async function handleRenameWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const oldPath = String(body.path || '');
    const newName = String(body.newName || '');

    if (!oldPath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" field' });
      return;
    }
    if (!isPlainFileName(newName)) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Invalid new name — must be a plain file/dir name with no slashes' });
      return;
    }

    const absPath = resolveToAbs(oldPath, sessionId);

    if (!fs.existsSync(absPath)) {
      sendJson(res, 404, { error: 'Not Found', message: `Path '${oldPath}' not found` });
      return;
    }

    const dir = path.dirname(absPath);
    const newAbsPath = path.join(dir, newName);

    if (fs.existsSync(newAbsPath)) {
      sendJson(res, 409, { error: 'Conflict', message: `'${newName}' already exists` });
      return;
    }

    fs.renameSync(absPath, newAbsPath);

    // Compute new relative path
    const newRelPath = oldPath.includes('/')
      ? path.join(path.dirname(oldPath), newName).replace(/\\/g, '/')
      : newName;

    sendJson(res, 200, { oldPath, newPath: newRelPath, newName, renamed: true });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Rename failed');
  }
}

/** POST /api/v1/workspace/create-file — Create a new empty file */
export async function handleCreateWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const parentPath = String(body.path || '/');
    const fileName = String(body.name || '');

    if (!isPlainFileName(fileName)) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Invalid file name' });
      return;
    }

    const absParentPath = resolveToAbs(parentPath, sessionId);

    const absPath = path.join(absParentPath, fileName);

    if (fs.existsSync(absPath)) {
      sendJson(res, 409, { error: 'Conflict', message: `'${fileName}' already exists` });
      return;
    }

    // Ensure parent exists
    if (!fs.existsSync(absParentPath)) {
      fs.mkdirSync(absParentPath, { recursive: true });
    }

    fs.writeFileSync(absPath, '', 'utf-8');

    const stat = fs.statSync(absPath);
    const relPath = parentPath === '/' ? fileName : `${parentPath.replace(/\/$/, '')}/${fileName}`;
    sendJson(res, 200, {
      path: relPath,
      name: fileName,
      created: true,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Create file failed');
  }
}

/** POST /api/v1/workspace/move — Move/rename a file or directory (cut-paste or drag-drop) */
export async function handleMoveWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const sourcePath = String(body.source || '');
    const destDir = String(body.destDir || '');

    if (!sourcePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "source" field' });
      return;
    }
    if (!destDir) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "destDir" field' });
      return;
    }

    const srcAbsPath = resolveToAbs(sourcePath, sessionId);
    const dstAbsDir = resolveToAbs(destDir, sessionId);

    if (!fs.existsSync(srcAbsPath)) {
      sendJson(res, 404, { error: 'Not Found', message: `Source '${sourcePath}' not found` });
      return;
    }

    if (!fs.existsSync(dstAbsDir) || !fs.statSync(dstAbsDir).isDirectory()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Destination must be an existing directory' });
      return;
    }

    const name = path.basename(srcAbsPath);
    const destAbsPath = path.join(dstAbsDir, name);

    if (fs.existsSync(destAbsPath)) {
      sendJson(res, 409, { error: 'Conflict', message: `'${name}' already exists in destination` });
      return;
    }

    // Don't allow moving a directory into itself
    const moveRelative = path.relative(srcAbsPath, destAbsPath);
    if (moveRelative && !moveRelative.startsWith('..') && !path.isAbsolute(moveRelative)) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Cannot move a directory into itself' });
      return;
    }

    fs.renameSync(srcAbsPath, destAbsPath);

    const newRelPath = destDir === '/'
      ? name
      : `${destDir.replace(/\/$/, '')}/${name}`;

    sendJson(res, 200, {
      source: sourcePath,
      destPath: newRelPath,
      name,
      moved: true,
    });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Move failed');
  }
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

/** PUT /api/v1/workspace/write — Write content to a file (create or overwrite) */
export async function handleWriteWorkspaceFile(
  req: IncomingMessage,
  res: ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const filePath = String(body.path || '');
    const content = String(body.content || '');

    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path"' });
      return;
    }

    const absPath = resolveToAbs(filePath, sessionId);
    const parentDir = path.dirname(absPath);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(absPath, content, 'utf-8');

    const stat = fs.statSync(absPath);
    sendJson(res, 200, {
      path: filePath,
      written: true,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    sendWorkspaceError(err, res, sendJson, 'Write failed');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Office document conversion
// ═══════════════════════════════════════════════════════════════════════

/** Minimal ZIP entry info we extract from central directory. */
interface ZipEntry {
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

  const stCdSize = buf.readUint32LE(eocdOff + 12);
  const stCdOff = buf.readUint32LE(eocdOff + 16);
  if (stCdOff < 0 || stCdOff >= buf.length || stCdSize <= 0) return entries;

  let pos = stCdOff;
  const end = Math.min(stCdOff + stCdSize, buf.length);
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
    const name = buf.toString('utf-8', pos + 46, pos + 46 + nameLen).replace(/\\/g, '/');
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
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  return null;
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
    const buf = fs.readFileSync(absPath);

    // ── .docx → mammoth ──
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const result = await mammoth.convertToHtml({ buffer: buf });
      sendJson(res, 200, { type: 'html', html: result.value, warnings: result.messages });
      return;
    }

    // ── .xlsx / .xlsm → extract shared strings + sheet data ──
    if (ext === '.xlsx' || ext === '.xlsm') {
      const entries = parseZipCD(buf);
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

      // Try sheet data — prefer sheet1.xml
      const sheetEntry = entries.get('xl/worksheets/sheet1.xml')
        || [...entries.values()].find(e => e.name.startsWith('xl/worksheets/sheet') && e.name.endsWith('.xml'));
      if (sheetEntry) {
        const raw = readZipEntry(buf, sheetEntry);
        if (raw) {
          const xml = raw.toString('utf-8');
          const rows = parseXlsxRows(xml, sharedStrings);
          if (rows.length > 0) {
            const content = rows.map(row => row.join('\t')).join('\n');
            sendJson(res, 200, { type: 'table', rows, content });
            return;
          }
          // Replace shared string refs with actual strings
          let text = xml;
          if (sharedStrings.length > 0) {
            text = text.replace(/<c[^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/g, (_, idx) => {
              const i = Number(idx);
              return sharedStrings[i] || '';
            });
          }
          const extracted = extractXmlText(Buffer.from(text, 'utf-8'));
          sendJson(res, 200, { type: 'text', content: extracted || '(empty spreadsheet)' });
          return;
        }
      }
      sendJson(res, 200, { type: 'text', content: sharedStrings.join(' ') || '(no readable content)' });
      return;
    }

    // ── .pptx / .ppt → extract slide text ──
    if (ext === '.pptx' || ext === '.pptm') {
      const entries = parseZipCD(buf);
      const slideEntries = [...entries.values()]
        .filter(e => e.name.match(/^ppt\/slides\/slide\d+\.xml$/))
        .sort((a, b) => a.name.localeCompare(b.name));

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
          const content = slides.map((s, i) => `── Slide ${i + 1} ──\n${s}`).join('\n\n');
          sendJson(res, 200, { type: 'text', content });
          return;
        }
      }
      sendJson(res, 200, { type: 'text', content: '(no slide text found)' });
      return;
    }

    // ── .odt / .ods / .odp (OpenDocument) — extract content.xml ──
    if (ext === '.odt' || ext === '.ods' || ext === '.odp') {
      const entries = parseZipCD(buf);
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

    // ── .doc (old format) → can't parse, suggest conversion ──
    if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
      sendJson(res, 200, { type: 'text', content: 'Legacy Office format (.doc/.xls/.ppt). Save as .docx/.xlsx/.pptx for preview.' });
      return;
    }

    sendJson(res, 400, { error: 'Bad Request', message: `Unsupported format: ${ext}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Convert failed', message });
  }
}
