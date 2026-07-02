// MemoryStore.ts — Filesystem storage layer for memory system
// Reads/writes .md memory files and maintains MEMORY.md index files
// Memory files use YAML frontmatter with metadata.type and metadata.scope

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { PATHS, MEMORY_INDEX_MAX_LINES, MEMORY_INDEX_MAX_BYTES } from '../../../shared/constants.js';
import type { MemoryEntry, MemoryFileMetadata } from './MemoryEntry.js';
import { MemoryScope, MemoryType } from './MemoryEntry.js';

/** B2: Write-lock map to serialize concurrent writes to the same index file */
const _writeLocks = new Map<string, Promise<void>>();

/** B2: Acquire exclusive access to a file path, run fn, release */
async function _withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(filePath) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const chainLink = prev.then(() => next);
  _writeLocks.set(filePath, chainLink);
  try {
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  } finally {
    // Clean up lock entry — only if no new caller chained after us
    if (_writeLocks.get(filePath) === chainLink) {
      _writeLocks.delete(filePath);
    }
  }
}

/**
 * Get the directory path for a given scope and agent.
 * For Session scope with subScope: memory/sessions/<sessionId>/team/ or .../personal/<agentId>/
 * Without subScope (backward compat): memory/sessions/<sessionId>/
 */
function memoryDir(scope: MemoryScope, agentId: string, sessionId?: string, subScope?: 'team' | 'personal'): string {
  const base = path.resolve(process.cwd(), PATHS.memory);
  if (scope === MemoryScope.Team) {
    return path.join(base, 'team');
  }
  if (scope === MemoryScope.Session) {
    if (!sessionId) throw new Error('sessionId is required for MemoryScope.Session');
    if (subScope === 'team') return path.join(base, 'sessions', sessionId, 'team');
    if (subScope === 'personal') return path.join(base, 'sessions', sessionId, 'personal', agentId);
    return path.join(base, 'sessions', sessionId);
  }
  return path.join(base, 'agents', agentId);
}

/**
 * Get the path to a specific memory .md file.
 */
function memoryFilePath(scope: MemoryScope, agentId: string, name: string, sessionId?: string, subScope?: 'team' | 'personal'): string {
  return path.join(memoryDir(scope, agentId, sessionId, subScope), `${name}.md`);
}

/**
 * Get the path to the MEMORY.md index file.
 */
function indexFilePath(scope: MemoryScope, agentId: string, sessionId?: string, subScope?: 'team' | 'personal'): string {
  return path.join(memoryDir(scope, agentId, sessionId, subScope), 'MEMORY.md');
}

/**
 * Serialize a MemoryEntry to a .md file content string.
 * Includes YAML frontmatter with metadata.
 */
export function serializeMemoryEntry(entry: MemoryEntry): string {
  const frontmatter: MemoryFileMetadata = {
    name: entry.name,
    description: entry.description,
    metadata: {
      type: entry.type,
      scope: entry.scope,
    },
  };

  const yamlStr = yaml.stringify(frontmatter).trim();
  return `---\n${yamlStr}\n---\n\n${entry.content.trim()}\n`;
}

/**
 * Read a memory file and parse it back into a MemoryEntry.
 */
export async function readMemoryFile(
  filePath: string,
  name: string,
  scope: MemoryScope,
): Promise<MemoryEntry | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parseMemoryFile(raw, name, scope);
    return parsed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) return null;
    throw err;
  }
}

/**
 * Parse raw .md content into a MemoryEntry.
 */
function parseMemoryFile(
  raw: string,
  fallbackName: string,
  fallbackScope: MemoryScope,
): MemoryEntry {
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n*/);

  let metadata: MemoryFileMetadata | null = null;
  let body = raw;

  if (frontmatterMatch) {
    try {
      const parsed = yaml.parse(frontmatterMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as MemoryFileMetadata;
      }
    } catch {
      // YAML parse failed — strip the broken frontmatter block, use body only
    }
    body = raw.slice(frontmatterMatch[0].length).trim();
  }

  const name = metadata?.name ?? fallbackName;
  const type = metadata?.metadata?.type ?? MemoryType.Project;
  const scope = metadata?.metadata?.scope ?? fallbackScope;
  const description = metadata?.description ?? '';

  return { name, type, description, content: body, scope };
}

/**
 * Write a memory entry to its .md file.
 */
export async function writeMemoryFile(entry: MemoryEntry, agentId: string, sessionId?: string): Promise<void> {
  const dir = memoryDir(entry.scope, agentId, sessionId, entry.subScope);
  await fs.mkdir(dir, { recursive: true });

  const filePath = memoryFilePath(
    entry.scope,
    agentId,
    entry.name,
    sessionId,
    entry.subScope,
  );
  const content = serializeMemoryEntry(entry);
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * Delete a memory .md file by name.
 */
export async function deleteMemoryFile(
  scope: MemoryScope,
  agentId: string,
  name: string,
  sessionId?: string,
  subScope?: 'team' | 'personal',
): Promise<boolean> {
  const filePath = memoryFilePath(scope, agentId, name, sessionId, subScope);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) return false;
    throw err;
  }
}

/**
 * Load the MEMORY.md index file content as a string.
 * Creates a default index if none exists.
 */
export async function loadIndex(
  scope: MemoryScope,
  agentId: string,
  agentName?: string,
  sessionId?: string,
  subScope?: 'team' | 'personal',
): Promise<string> {
  const filePath = indexFilePath(scope, agentId, sessionId, subScope);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      // Create default index
      const name = agentName || agentId;
      let header: string;
      if (scope === MemoryScope.Team) {
        header = '# Team Memory Index\n\n';
      } else if (scope === MemoryScope.Session) {
        header = `# Session Memory Index (${sessionId})\n\n`;
      } else {
        header = `# ${name}'s Memory Index\n\n`;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, header, 'utf8');
      return header;
    }
    throw err;
  }
}

/**
 * Append an index line to the MEMORY.md file.
 * Format: `- [Title](file.md) — one-line hook`
 *
 * Enforces max 200 lines and 25KB limits by removing oldest entries.
 */
export async function appendToIndex(
  scope: MemoryScope,
  agentId: string,
  entry: MemoryEntry,
  sessionId?: string,
): Promise<void> {
  const filePath = indexFilePath(scope, agentId, sessionId, entry.subScope);
  // B2: serialize writes to the same index file to prevent race conditions
  await _withLock(filePath, async () => {
    const agentName = agentId;

    // Ensure index exists
    let current = await loadIndex(scope, agentId, agentName, sessionId, entry.subScope);

    // Build the index line
    const indexLine = `- [${entry.name}](${entry.name}.md) — ${entry.description}`;

    // Parse existing lines
    const lines = current.split('\n');
    const linkLines: string[] = [];
    const otherLines: string[] = [];

    for (const line of lines) {
      if (/^\s*-\s*\[/.test(line)) {
        linkLines.push(line);
      } else {
        otherLines.push(line);
      }
    }

    // Remove existing entry for this name (update case)
    const filtered = linkLines.filter(
      (l) => !l.includes(`(${entry.name}.md)`),
    );

    // Add new entry at the end
    filtered.push(indexLine);

    // Enforce max lines
    while (filtered.length > MEMORY_INDEX_MAX_LINES) {
      filtered.shift();
    }

    // Reassemble
    const newIndex = [...otherLines, '', ...filtered].join('\n').trim() + '\n';

    // Enforce max bytes
    if (Buffer.byteLength(newIndex, 'utf8') > MEMORY_INDEX_MAX_BYTES) {
      // Truncate oldest entries until within limit
      let truncated = [...filtered];
      while (
        truncated.length > 0 &&
        Buffer.byteLength(
          [...otherLines, '', ...truncated].join('\n').trim() + '\n',
          'utf8',
        ) > MEMORY_INDEX_MAX_BYTES
      ) {
        truncated.shift();
      }
      const finalIndex =
        [...otherLines, '', ...truncated].join('\n').trim() + '\n';
      await fs.writeFile(filePath, finalIndex, 'utf8');
    } else {
      await fs.writeFile(filePath, newIndex, 'utf8');
    }
  });
}

/**
 * Remove an entry's index line from MEMORY.md.
 */
export async function removeFromIndex(
  scope: MemoryScope,
  agentId: string,
  name: string,
  sessionId?: string,
  subScope?: 'team' | 'personal',
): Promise<void> {
  const filePath = indexFilePath(scope, agentId, sessionId, subScope);
  try {
    const current = await fs.readFile(filePath, 'utf8');
    const lines = current.split('\n');
    const filtered = lines.filter(
      (l) => !l.includes(`(${name}.md)`),
    );
    await fs.writeFile(filePath, filtered.join('\n'), 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) return;
    throw err;
  }
}

/**
 * Parse the MEMORY.md index into individual entries (one per linked file).
 * Returns the link lines parsed into { name, file, description } objects.
 */
export function parseIndexLinks(indexContent: string): Array<{ name: string; file: string; description: string }> {
  const results: Array<{ name: string; file: string; description: string }> = [];
  const regex = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—\-]\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(indexContent)) !== null) {
    results.push({
      name: match[1].trim(),
      file: match[2].trim(),
      description: match[3].trim(),
    });
  }
  return results;
}

/**
 * Load all memory entries from a scope's directory.
 * Reads every .md file except MEMORY.md, parses frontmatter + body.
 */
export async function loadAllMemoryFiles(
  scope: MemoryScope,
  agentId: string,
  sessionId?: string,
  subScope?: 'team' | 'personal',
): Promise<MemoryEntry[]> {
  const dir = memoryDir(scope, agentId, sessionId, subScope);
  const entries: MemoryEntry[] = [];

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return entries; // Directory doesn't exist yet
  }

  for (const file of files) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
    const name = file.replace(/\.md$/, '');
    const filePath = path.join(dir, file);
    const entry = await readMemoryFile(filePath, name, scope);
    if (entry) {
      if (scope === MemoryScope.Session && sessionId) {
        entry.sessionId = sessionId;
      }
      try {
        const stat = await fs.stat(filePath);
        entry.updatedAt = stat.mtimeMs;
      } catch {
        // Ignore stat errors — leave updatedAt undefined
      }
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Write or update a memory entry, including the .md file and the MEMORY.md index.
 */
export async function saveMemory(entry: MemoryEntry, agentId: string, sessionId?: string): Promise<void> {
  await writeMemoryFile(entry, agentId, sessionId);
  await appendToIndex(entry.scope, agentId, entry, sessionId);
}

/**
 * Remove a memory entry by name, deleting both .md file and index line.
 */
export async function removeMemory(
  scope: MemoryScope,
  agentId: string,
  name: string,
  sessionId?: string,
  subScope?: 'team' | 'personal',
): Promise<boolean> {
  const deleted = await deleteMemoryFile(scope, agentId, name, sessionId, subScope);
  if (deleted) {
    await removeFromIndex(scope, agentId, name, sessionId, subScope);
  }
  return deleted;
}
