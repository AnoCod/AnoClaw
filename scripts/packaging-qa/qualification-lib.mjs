import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const SENSITIVE_RESPONSE_KEYS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'token',
  'secret',
  'secretkey',
  'password',
  'credential',
  'credentials',
]);

const SECRET_LITERAL_PATTERNS = [
  { name: 'OpenAI-compatible API key', regex: /sk-[A-Za-z0-9_-]{32,}/g },
  { name: 'GitHub token', regex: /gh[oprsu]_[A-Za-z0-9]{30,}/g },
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'Google API key', regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'Telegram bot token', regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
];

export function expectedReleaseArtifactNames(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ''))) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return {
    installer: `AnoClaw.Setup.${version}.exe`,
    portable: `AnoClaw-${version}-win-unpacked.zip`,
  };
}

export function containsAnoClawUninstallEntry(registryOutput) {
  return String(registryOutput || '')
    .split(/\r?\n/)
    .some((line) => (
      /^\s*DisplayName\s+REG_\w+\s+AnoClaw(?:\s+\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)?\s*$/i
        .test(line)
    ));
}

export function normalizeSensitiveKey(key) {
  return String(key).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function findSensitiveValuePaths(value, basePath = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveValuePaths(item, `${basePath}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${basePath}.${key}`;
    if (SENSITIVE_RESPONSE_KEYS.has(normalizeSensitiveKey(key)) && child !== '' && child != null) {
      found.push(childPath);
    }
    findSensitiveValuePaths(child, childPath, found);
  }
  return found;
}

export function detectSecretLiteral(text) {
  const source = String(text || '');
  const matches = [];
  for (const pattern of SECRET_LITERAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(source)) matches.push(pattern.name);
  }
  return matches;
}

export function assertPathInside(candidate, parent, label = 'path') {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${resolvedParent}: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

export function assertDisposablePackagedRuntimeRoot(runtimeRoot, repoRoot) {
  const resolved = assertPathInside(runtimeRoot, repoRoot, 'packaged runtime root');
  const relative = path.relative(path.resolve(repoRoot), resolved).replace(/\\/g, '/');
  if (!/^release\d+\/win-unpacked\/resources\/app\.asar\.unpacked$/.test(relative)) {
    throw new Error(`Refusing to clean non-release runtime root: ${resolved}`);
  }
  return resolved;
}

export async function sha256File(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function findAvailablePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function waitUntil(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 150;
  const label = options.label || 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}
