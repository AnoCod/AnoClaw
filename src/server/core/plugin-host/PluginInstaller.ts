import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { PluginManifest } from './PluginRPC.js';

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_COUNT = 256;
const MAX_DIRECTORY_DEPTH = 12;

type FetchLike = typeof fetch;

interface GitHubSource {
  owner: string;
  repo: string;
  ref: string;
  subdir: string;
}

export interface PluginInstallOptions {
  url: string;
  requestedName?: string;
  branch?: string;
  subdir?: string;
  pluginsDir: string;
  fetchImpl?: FetchLike;
}

export interface PluginInstallResult {
  name: string;
  path: string;
  installed: true;
  files: number;
  source: 'github' | 'json';
}

export class PluginInstallError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'PluginInstallError';
  }
}

function safePluginName(value: string, label = 'plugin name'): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === '.' || value === '..') {
    throw new PluginInstallError(`Invalid ${label}`);
  }
  return value;
}

function safeRelativePath(value: string): string {
  if (!value || value.includes('\0') || path.isAbsolute(value)) {
    throw new PluginInstallError(`Invalid plugin file path: ${value}`);
  }
  const normalized = path.normalize(value).replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new PluginInstallError(`Plugin file escapes its install directory: ${value}`);
  }
  return normalized;
}

async function fetchBuffer(
  fetchImpl: FetchLike,
  url: string,
  limit: number,
  headers?: Record<string, string>,
): Promise<Buffer> {
  let requestedUrl: URL;
  try { requestedUrl = new URL(url); }
  catch { throw new PluginInstallError('Invalid plugin download URL'); }
  const safeUrl = `${requestedUrl.origin}${requestedUrl.pathname}`;
  if (requestedUrl.protocol !== 'https:') {
    throw new PluginInstallError(`Plugin download URL must use HTTPS: ${safeUrl}`);
  }
  const response = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new PluginInstallError(`Fetch failed for ${safeUrl}: HTTP ${response.status}`, 502);
  }
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:') {
      throw new PluginInstallError(
        `Plugin download redirected to an insecure URL: ${finalUrl.origin}${finalUrl.pathname}`,
        502,
      );
    }
  }
  const declaredLength = Number(response.headers.get('content-length') || '0');
  if (declaredLength > limit) throw new PluginInstallError(`Remote file exceeds ${limit} bytes`, 413);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new PluginInstallError(`Remote file exceeds ${limit} bytes`, 413);
  return bytes;
}

function parseGitHubSource(urlText: string, branch?: string, explicitSubdir?: string): GitHubSource | null {
  let url: URL;
  try { url = new URL(urlText); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) throw new PluginInstallError('GitHub URL must include an owner and repository');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  let ref = branch || 'main';
  let subdir = explicitSubdir || '';
  if (parts[2] === 'tree') {
    if (!parts[3]) throw new PluginInstallError('GitHub tree URL is missing a branch');
    ref = branch || parts[3];
    if (!explicitSubdir) subdir = parts.slice(4).join('/');
  } else if (parts.length > 2) {
    throw new PluginInstallError('Use a GitHub repository URL or /tree/<branch>/<plugin-directory> URL');
  }
  return {
    owner: safePluginName(owner, 'GitHub owner'),
    repo: safePluginName(repo, 'GitHub repository'),
    ref,
    subdir: subdir ? safeRelativePath(subdir) : '',
  };
}

function assertCapacity(files: Map<string, Buffer>, nextPath: string, nextSize: number): void {
  if (nextSize > MAX_FILE_BYTES) throw new PluginInstallError(`${nextPath} exceeds the per-file limit`, 413);
  if (files.size >= MAX_FILE_COUNT) throw new PluginInstallError(`Plugin exceeds ${MAX_FILE_COUNT} files`, 413);
  const total = [...files.values()].reduce((sum, value) => sum + value.length, 0) + nextSize;
  if (total > MAX_SOURCE_BYTES) throw new PluginInstallError('Plugin exceeds the total install size limit', 413);
}

async function collectGitHubDirectory(
  fetchImpl: FetchLike,
  source: GitHubSource,
  remotePath: string,
  relativePrefix: string,
  files: Map<string, Buffer>,
  depth = 0,
): Promise<void> {
  if (depth > MAX_DIRECTORY_DEPTH) throw new PluginInstallError('Plugin directory nesting is too deep', 413);
  const encodedPath = remotePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(source.ref)}`;
  const listingBuffer = await fetchBuffer(fetchImpl, apiUrl, 2 * 1024 * 1024, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AnoClaw-Plugin-Installer',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  let entries: Array<{ type: string; name: string; path: string; size?: number; download_url?: string | null }>;
  try {
    const parsed = JSON.parse(listingBuffer.toString('utf8')) as typeof entries | { message?: string };
    if (!Array.isArray(parsed)) throw new Error('source is not a directory');
    entries = parsed;
  } catch (error) {
    throw new PluginInstallError(`Invalid GitHub directory response: ${(error as Error).message}`, 502);
  }

  for (const entry of entries) {
    const relativePath = safeRelativePath(relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name);
    if (entry.type === 'dir') {
      await collectGitHubDirectory(fetchImpl, source, entry.path, relativePath, files, depth + 1);
      continue;
    }
    if (entry.type !== 'file' || !entry.download_url) {
      throw new PluginInstallError(`Unsupported GitHub entry type for ${entry.path}: ${entry.type}`);
    }
    assertCapacity(files, relativePath, entry.size || 0);
    const content = await fetchBuffer(fetchImpl, entry.download_url, MAX_FILE_BYTES);
    assertCapacity(files, relativePath, content.length);
    if ([...files.keys()].some((name) => name.toLowerCase() === relativePath.toLowerCase())) {
      throw new PluginInstallError(`Duplicate plugin path: ${relativePath}`);
    }
    files.set(relativePath, content);
  }
}

async function collectJsonBundle(fetchImpl: FetchLike, url: string): Promise<Map<string, Buffer>> {
  const bundle = await fetchBuffer(fetchImpl, url, MAX_SOURCE_BYTES);
  let data: { files?: Record<string, string> };
  try { data = JSON.parse(bundle.toString('utf8')) as { files?: Record<string, string> }; }
  catch (error) { throw new PluginInstallError(`Invalid plugin bundle JSON: ${(error as Error).message}`, 502); }
  if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
    throw new PluginInstallError('Plugin bundle must contain a files object');
  }
  const files = new Map<string, Buffer>();
  for (const [rawPath, rawContent] of Object.entries(data.files)) {
    if (typeof rawContent !== 'string') throw new PluginInstallError(`Plugin file is not text: ${rawPath}`);
    const filePath = safeRelativePath(rawPath);
    const content = Buffer.from(rawContent, 'utf8');
    assertCapacity(files, filePath, content.length);
    if ([...files.keys()].some((name) => name.toLowerCase() === filePath.toLowerCase())) {
      throw new PluginInstallError(`Duplicate plugin path: ${filePath}`);
    }
    files.set(filePath, content);
  }
  return files;
}

function validateBundle(files: Map<string, Buffer>, requestedName?: string): PluginManifest {
  const manifestBuffer = files.get('plugin.json');
  if (!manifestBuffer) throw new PluginInstallError('Plugin source is missing plugin.json');
  let manifest: PluginManifest;
  try { manifest = JSON.parse(manifestBuffer.toString('utf8')) as PluginManifest; }
  catch (error) { throw new PluginInstallError(`Invalid plugin.json: ${(error as Error).message}`); }
  const manifestName = safePluginName(String(manifest.name || ''));
  if (requestedName && safePluginName(requestedName) !== manifestName) {
    throw new PluginInstallError(`Requested plugin name "${requestedName}" does not match manifest name "${manifestName}"`);
  }
  const main = safeRelativePath(String(manifest.main || ''));
  if (!files.has(main)) throw new PluginInstallError(`Plugin entry file is missing: ${main}`);
  for (const page of manifest.contributes?.pages || []) {
    if (!page.html) continue;
    const htmlPath = safeRelativePath(page.html);
    if (!files.has(htmlPath)) throw new PluginInstallError(`Plugin page file is missing: ${htmlPath}`);
  }
  manifest.name = manifestName;
  manifest.main = main;
  return manifest;
}

export async function installPluginFromUrl(options: PluginInstallOptions): Promise<PluginInstallResult> {
  let sourceUrl: URL;
  try { sourceUrl = new URL(options.url); }
  catch { throw new PluginInstallError('Invalid plugin install URL'); }
  if (sourceUrl.protocol !== 'https:') throw new PluginInstallError('Plugin install URL must use HTTPS');

  const fetchImpl = options.fetchImpl || fetch;
  const github = parseGitHubSource(options.url, options.branch, options.subdir);
  const files = new Map<string, Buffer>();
  if (github) {
    await collectGitHubDirectory(fetchImpl, github, github.subdir, '', files);
  } else {
    const bundle = await collectJsonBundle(fetchImpl, options.url);
    for (const [filePath, content] of bundle) files.set(filePath, content);
  }
  const manifest = validateBundle(files, options.requestedName);

  fs.mkdirSync(options.pluginsDir, { recursive: true });
  const destination = path.join(options.pluginsDir, manifest.name);
  if (fs.existsSync(destination)) throw new PluginInstallError(`Plugin "${manifest.name}" is already installed`, 409);

  const stage = path.join(options.pluginsDir, `.install-${crypto.randomUUID()}`);
  fs.mkdirSync(stage, { recursive: false });
  try {
    for (const [filePath, content] of files) {
      const target = path.join(stage, filePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    fs.renameSync(stage, destination);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  return {
    name: manifest.name,
    path: destination,
    installed: true,
    files: files.size,
    source: github ? 'github' : 'json',
  };
}
