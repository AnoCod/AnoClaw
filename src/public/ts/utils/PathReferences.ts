export interface FilePathReference {
  raw: string;
  path: string;
  line?: number;
  column?: number;
}

const FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'py', 'rs',
  'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt',
  'scala', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'html', 'htm', 'css', 'scss',
  'less', 'xml', 'toml', 'ini', 'cfg', 'conf', 'md', 'mdx', 'txt', 'log',
  'env', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'vue', 'svelte',
  'dart', 'ex', 'exs', 'proto', 'prisma', 'tf', 'nix', 'cmake', 'gradle',
  'properties', 'lock', 'gitignore', 'dockerfile', 'makefile', 'mts', 'cts',
  'd.ts',
];

const SPECIAL_FILENAMES = [
  'Dockerfile', 'Makefile', 'README', 'LICENSE', 'AGENTS.md', 'anoclaw.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts',
];

const EXT_PATTERN = FILE_EXTENSIONS
  .map((ext) => ext.replace('.', '\\.'))
  .sort((a, b) => b.length - a.length)
  .join('|');
const SPECIAL_PATTERN = SPECIAL_FILENAMES
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const DIR_PREFIX = '(?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|[/\\\\](?![/\\\\])|(?:[\\w@.$+~-]+[\\\\/])+)';
const PATH_WITH_DIR = `${DIR_PREFIX}[^\\s<>"{}|^\`\\[\\]]*?(?:\\.(?:${EXT_PATTERN})|[\\\\/]\\.[A-Za-z0-9_-]+|[\\\\/](?:${SPECIAL_PATTERN}))`;
const ROOT_FILE = `(?:[\\w@.$+~-]+\\.(?:${EXT_PATTERN})|\\.[A-Za-z0-9_-]+|(?:${SPECIAL_PATTERN}))`;
const LOCATION_SUFFIX = '(?::\\d+(?::\\d+|-\\d+)?)?';
const FILE_REF_RE = new RegExp(
  `(^|[\\s([<{'\"“‘])((?:${PATH_WITH_DIR}|${ROOT_FILE})${LOCATION_SUFFIX})(?=$|[\\s)\\]}>.,;:'\"!?，。；：！？、])`,
  'gi',
);

function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripWrapping(value: string): string {
  let result = value.trim();
  result = result.replace(/^[`'"]+|[`'"]+$/g, '');
  result = result.replace(/[.,;!?，。；！？、]+$/g, '');
  return result;
}

function normalizeFileUrl(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    return value;
  }
}

function lineSuffix(value: string): { path: string; line?: number; column?: number } {
  const match = value.match(/^(.*):(\d+)(?::(\d+)|-(\d+))?$/);
  if (!match) return { path: value };
  const candidate = match[1];
  if (!isLikelyFilePath(candidate)) return { path: value };
  return {
    path: candidate,
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : undefined,
  };
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function isLikelyFilePath(value: string): boolean {
  const raw = normalizeFileUrl(decodeBasicEntities(stripWrapping(value)));
  if (!raw || isHttpUrl(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) {
    return false;
  }

  const withoutLine = raw.replace(/:(\d+)(?::\d+|-\d+)?$/, '');
  const baseName = withoutLine.split(/[\\/]/).pop() || withoutLine;
  const lowerBase = baseName.toLowerCase();

  if (SPECIAL_FILENAMES.some((name) => name.toLowerCase() === lowerBase)) return true;
  if (/^\.[A-Za-z0-9_-]+$/.test(baseName)) return true;

  const extMatch = lowerBase.match(/\.([a-z0-9.]+)$/);
  if (!extMatch) return false;
  return FILE_EXTENSIONS.includes(extMatch[1]);
}

export function parseFilePathReference(raw: string): FilePathReference | null {
  const normalized = normalizeFileUrl(decodeBasicEntities(stripWrapping(raw)));
  if (!isLikelyFilePath(normalized)) return null;
  const located = lineSuffix(normalized);
  return {
    raw,
    path: located.path,
    line: located.line,
    column: located.column,
  };
}

export function clickablePathHtml(displayHtml: string, rawPath: string): string {
  const ref = parseFilePathReference(rawPath);
  if (!ref) return displayHtml;
  const lineAttr = ref.line ? ` data-file-line="${ref.line}"` : '';
  const columnAttr = ref.column ? ` data-file-column="${ref.column}"` : '';
  const title = ref.line ? `${ref.path}:${ref.line}` : ref.path;
  return `<span class="clickable-path" data-file-path="${escAttr(ref.path)}"${lineAttr}${columnAttr} title="Open ${escAttr(title)}">${displayHtml}</span>`;
}

export function markdownLinkHtml(labelHtml: string, target: string): string {
  const ref = parseFilePathReference(target);
  if (ref && !isHttpUrl(target)) {
    return clickablePathHtml(labelHtml, target);
  }
  return `<a href="${escAttr(target)}" data-external-url="true" rel="noopener noreferrer" class="md-link">${labelHtml}</a>`;
}

function linkifyTextNode(text: string): string {
  FILE_REF_RE.lastIndex = 0;
  return text.replace(FILE_REF_RE, (full, prefix: string, candidate: string) => {
    const ref = parseFilePathReference(candidate);
    if (!ref) return full;
    return prefix + clickablePathHtml(candidate, candidate);
  });
}

export function linkifyFilePathsInHtml(html: string): string {
  const tokens = html.split(/(<[^>]+>)/g);
  const blocked: string[] = [];
  return tokens.map((token) => {
    if (!token) return token;
    if (!token.startsWith('<')) {
      return blocked.length ? token : linkifyTextNode(token);
    }

    const close = token.match(/^<\/\s*([a-z0-9-]+)/i);
    if (close) {
      const tag = close[1].toLowerCase();
      const idx = blocked.lastIndexOf(tag);
      if (idx >= 0) blocked.splice(idx, 1);
      return token;
    }

    const open = token.match(/^<\s*([a-z0-9-]+)/i);
    if (open) {
      const tag = open[1].toLowerCase();
      if (tag === 'a' || tag === 'code' || tag === 'pre' || tag === 'img') blocked.push(tag);
    }
    return token;
  }).join('');
}

function isWindowsWorkspace(workspacePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(workspacePath);
}

function isWindowsAbsolutePath(filePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(filePath);
}

function isUncPath(filePath: string): boolean {
  return /^[/\\]{2}[^/\\]/.test(filePath);
}

function isPosixAbsolutePath(filePath: string): boolean {
  return /^\/(?:home|Users|mnt|var|tmp|opt|usr|etc)\//.test(filePath);
}

export function resolveClickedFilePath(clickedPath: string, workspacePath: string): string | null {
  const ref = parseFilePathReference(clickedPath);
  const cleanPath = ref?.path ?? normalizeFileUrl(decodeBasicEntities(stripWrapping(clickedPath)));
  if (!cleanPath) return null;

  if (
    isWindowsAbsolutePath(cleanPath) ||
    isUncPath(cleanPath) ||
    cleanPath.startsWith('~/') ||
    cleanPath.startsWith('~\\') ||
    isPosixAbsolutePath(cleanPath)
  ) {
    return cleanPath;
  }

  const workspace = workspacePath.trim();
  if (!workspace) return null;

  const sep = workspace.includes('\\') ? '\\' : '/';
  const relative = isWindowsWorkspace(workspace) && /^[/\\](?![/\\])/.test(cleanPath)
    ? cleanPath.replace(/^[/\\]+/, '')
    : cleanPath.replace(/^[/\\]+/, '');
  const normalizedRelative = relative.replace(/[\\/]+/g, sep);

  return `${workspace.replace(/[\\/]+$/, '')}${sep}${normalizedRelative}`;
}
