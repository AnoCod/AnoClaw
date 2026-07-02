// WorkspaceHandlers — workspace file-browsing and binding HTTP handlers extracted from ApiServer
// Handles: browse workspace, read workspace file, create directory, bind workspace
// Part of the AnoClaw v2.0 rewrite: Gateway system (SA-10)

import * as http from 'http';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { SessionManager } from '../../core/session/SessionManager.js';
import { requireWs, requireWsAny } from '../WsRequired.js';

// ---------------------------------------------------------------------------
// Utility types + helpers
// ---------------------------------------------------------------------------

type SendJson = (res: http.ServerResponse, statusCode: number, data: Record<string, unknown>) => void;
type ReadBody = (req: http.IncomingMessage) => Promise<Record<string, unknown>>;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Internal helpers for gitignore filtering
// ---------------------------------------------------------------------------

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

/** Check if relative path matches .gitignore patterns */
function isGitignored(relPath: string, isDir: boolean, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Normalize pattern: strip trailing /
    const pat = pattern.replace(/\/$/, '');
    // Directory-only pattern
    if (pattern.endsWith('/') && !isDir) continue;

    // Exact match
    if (relPath === pat || relPath.startsWith(pat + '/')) return true;

    // Wildcard match (basic — handle node_modules/, *.log, dist/, etc.)
    if (pat.includes('*')) {
      const regex = new RegExp('^' + pat.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '(/.*)?$');
      if (regex.test(relPath)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Exported handler functions
// ---------------------------------------------------------------------------

/** GET /api/v1/workspace/browse — List workspace directory contents */
export async function handleBrowseWorkspace(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const sessionId = url.searchParams.get('sessionId') || '';
    const browsePath = url.searchParams.get('path') || '/';

    // Get workspace root from session
    const sessionManager = SessionManager.getInstance();
    let workspaceRoot = process.cwd();
    if (sessionId) {
      const session = sessionManager.session(sessionId);
      if (session && session.workspace) {
        workspaceRoot = path.resolve(session.workspace);
      }
    }

    const absPath = path.resolve(workspaceRoot, browsePath.replace(/^\//, ''));
    // Security: ensure path doesn't escape workspace root
    if (!absPath.startsWith(path.resolve(workspaceRoot))) {
      sendJson(res, 403, { error: 'Forbidden', message: 'Path escapes workspace root' });
      return;
    }
    if (!fs.existsSync(absPath)) {
      sendJson(res, 404, { error: 'Not Found', message: `Path '${browsePath}' not found` });
      return;
    }
    if (!fs.statSync(absPath).isDirectory()) {
      // Return single file info
      const stat = fs.statSync(absPath);
      sendJson(res, 200, {
        path: browsePath,
        nodes: [{
          name: path.basename(absPath),
          path: browsePath,
          isDirectory: false,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        }],
      });
      return;
    }

    // Load .gitignore patterns
    const gitignorePatterns = loadGitignore(workspaceRoot);

    // Read directory (single level only — lazy loading)
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const nodes = entries
      .filter(entry => {
        const relPath = browsePath === '/'
          ? entry.name
          : `${browsePath.replace(/\/$/, '')}/${entry.name}`;
        return !isGitignored(relPath, entry.isDirectory(), gitignorePatterns);
      })
      .map(entry => {
        const fullPath = path.join(absPath, entry.name);
        const relPath = browsePath === '/'
          ? entry.name
          : `${browsePath.replace(/\/$/, '')}/${entry.name}`;
        let stat: fs.Stats | null = null;
        try { stat = fs.statSync(fullPath); } catch { /* permission denied */ }
        return {
          name: entry.name,
          path: relPath,
          isDirectory: entry.isDirectory(),
          size: stat ? stat.size : 0,
          modifiedAt: stat ? stat.mtime.toISOString() : '',
        };
      })
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    sendJson(res, 200, { path: browsePath, workspaceRoot, nodes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Browse failed', message });
  }
}

/** GET /api/v1/workspace/read — Read file contents */
export async function handleReadWorkspaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
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

    // Get workspace root from session
    const sessionManager = SessionManager.getInstance();
    let workspaceRoot = process.cwd();
    if (sessionId) {
      const session = sessionManager.session(sessionId);
      if (session && session.workspace) {
        workspaceRoot = path.resolve(session.workspace);
      }
    }

    const absPath = path.resolve(workspaceRoot, filePath.replace(/^\//, ''));
    // Security: ensure path doesn't escape workspace root
    if (!absPath.startsWith(path.resolve(workspaceRoot))) {
      sendJson(res, 403, { error: 'Forbidden', message: 'Path escapes workspace root' });
      return;
    }
    if (!fs.existsSync(absPath)) {
      sendJson(res, 404, { error: 'Not Found', message: `File '${filePath}' not found` });
      return;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Path is a directory, not a file' });
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
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Read failed', message });
  }
}

/** POST /api/v1/workspace/create-dir — Create directory */
export async function handleCreateWorkspaceDir(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const parentPath = String(body.path || '/');

    const dirName = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : null;

    const absParentPath = resolveToAbs(parentPath);
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
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Create dir failed', message });
  }
}

/** PATCH /api/v1/sessions/:id/bind-workspace — Bind workspace path */
export async function handleBindWorkspace(
  sessionId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
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
// Path helper — resolve relative/absolute path to an absolute fs path
// ---------------------------------------------------------------------------

function resolveToAbs(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}

// ---------------------------------------------------------------------------
// Mutation handlers
// ---------------------------------------------------------------------------

/** DELETE /api/v1/workspace/file — Delete a file or directory */
export async function handleDeleteWorkspaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const sessionId = url.searchParams.get('sessionId') || '';
    const filePath = url.searchParams.get('path') || '';

    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" query param' });
      return;
    }

    const absPath = resolveToAbs(filePath);

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
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Delete failed', message });
  }
}

/** PATCH /api/v1/workspace/rename — Rename a file or directory */
export async function handleRenameWorkspaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const oldPath = String(body.path || '');
    const newName = String(body.newName || '');

    if (!oldPath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path" field' });
      return;
    }
    if (!newName || newName.includes('/') || newName.includes('\\')) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Invalid new name — must be a plain file/dir name with no slashes' });
      return;
    }

    const absPath = resolveToAbs(oldPath);

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
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Rename failed', message });
  }
}

/** POST /api/v1/workspace/create-file — Create a new empty file */
export async function handleCreateWorkspaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const parentPath = String(body.path || '/');
    const fileName = String(body.name || '');

    if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Invalid file name' });
      return;
    }

    const absParentPath = resolveToAbs(parentPath);

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
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Create file failed', message });
  }
}

/** POST /api/v1/workspace/move — Move/rename a file or directory (cut-paste or drag-drop) */
export async function handleMoveWorkspaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
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

    const srcAbsPath = resolveToAbs(sourcePath);
    const dstAbsDir = resolveToAbs(destDir);

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
    if (destAbsPath.startsWith(srcAbsPath + path.sep)) {
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
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Move failed', message });
  }
}

/** GET /api/v1/sessions/:id/workspace — Get current workspace path */
export function handleGetWorkspace(
  sessionId: string,
  res: http.ServerResponse,
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
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  readBody: ReadBody,
): Promise<void> {
  if (!requireWsAny(res, sendJson)) return;
  try {
    const body = await readBody(req);
    const filePath = String(body.path || '');
    const content = String(body.content || '');

    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path"' });
      return;
    }

    const absPath = resolveToAbs(filePath);
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
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'Write failed', message });
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
function extractXmlText(xml: Buffer): string {
  const s = xml.toString('utf-8');
  // Remove XML tags, keep content
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ').trim();
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
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sendJson: SendJson,
  host: string,
  port: number,
): Promise<void> {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    const sessionId = url.searchParams.get('sessionId') || '';
    const filePath = url.searchParams.get('path') || '';

    if (!filePath) {
      sendJson(res, 400, { error: 'Bad Request', message: 'Missing "path"' });
      return;
    }

    // Resolve path
    const sessionManager = SessionManager.getInstance();
    let workspaceRoot = process.cwd();
    if (sessionId) {
      const session = sessionManager.session(sessionId);
      if (session && session.workspace) workspaceRoot = path.resolve(session.workspace);
    }
    const absPath = path.resolve(workspaceRoot, filePath.replace(/^\//, ''));
    if (!absPath.startsWith(path.resolve(workspaceRoot))) {
      sendJson(res, 403, { error: 'Forbidden', message: 'Path escapes workspace' });
      return;
    }
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
          const matches = xml.match(/<t[^>]*>([^<]*)<\/t>/g);
          if (matches) sharedStrings = matches.map(m => m.replace(/<[^>]+>/g, '').trim());
        }
      }

      // Try sheet data — prefer sheet1.xml
      const sheetEntry = entries.get('xl/worksheets/sheet1.xml')
        || [...entries.values()].find(e => e.name.startsWith('xl/worksheets/sheet') && e.name.endsWith('.xml'));
      if (sheetEntry) {
        const raw = readZipEntry(buf, sheetEntry);
        if (raw) {
          const xml = raw.toString('utf-8');
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
