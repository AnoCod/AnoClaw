/**
 * Shared helpers for ecosystem adapters (read-only scanning).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';

export function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

export function projectRoot(): string {
  return process.cwd();
}

export function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function readJsonFile<T = Record<string, unknown>>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readYamlFile<T = Record<string, unknown>>(p: string): T | null {
  try {
    return yaml.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readTextFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Tolerant JSON5-ish parser used for opencode.jsonc / openclaw.json:
 * strips comments, trailing commas, quotes bare keys, then tries JSON, then YAML.
 */
export function parseJson5ish(src: string): Record<string, unknown> | null {
  if (!src) return null;
  try { return JSON.parse(src) as Record<string, unknown>; } catch { /* fall through */ }
  let s = src.replace(/^\uFEFF/, '');
  s = s.replace(/\/\/[^\r\n]*/g, '');
  s = s.replace(/#[^\r\n]*/g, '');
  s = s.replace(/,\s*([}\]])/g, '$1');
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  try { return JSON.parse(s) as Record<string, unknown>; } catch { /* fall through */ }
  try { return yaml.parse(s) as Record<string, unknown>; } catch { return null; }
}

/** Recursively find SKILL.md files under a root (max depth 6, OpenClaw rule). */
export function findSkillFiles(root: string, depth = 0): string[] {
  if (depth > 6) return [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '_system' || entry.name === '.system') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (fileExists(path.join(full, 'SKILL.md'))) out.push(path.join(full, 'SKILL.md'));
      else out.push(...findSkillFiles(full, depth + 1));
    }
  }
  return out;
}

/** Find markdown files directly inside a directory (commands/agents). */
export function findMarkdownFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** Recursively find files named `name` up to a max depth. */
export function findFilesNamed(root: string, name: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.codex-plugin' && entry.name !== '.claude-plugin') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === name) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}
