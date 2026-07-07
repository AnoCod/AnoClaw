import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release8', 'release9', '.git', 'js', 'monaco', '__tests__']);

describe('frontend API coverage', () => {
  it('keeps every statically declared frontend /api fetch backed by a server route', () => {
    const frontendFetches = collectFrontendFetches();
    const backendRoutes = collectBackendRoutes();
    const comparableRoutes = new Set([...backendRoutes].map(toComparablePath));

    const missing = [...frontendFetches.keys()]
      .filter((apiPath) => !comparableRoutes.has(toComparablePath(apiPath)))
      .sort()
      .map((apiPath) => ({
        path: apiPath,
        files: [...new Set(frontendFetches.get(apiPath) || [])].sort(),
      }));

    expect(missing).toEqual([]);
  });
});

function collectFrontendFetches(): Map<string, string[]> {
  const files = [
    ...walk(path.join(ROOT, 'src', 'public')),
    ...walk(path.join(ROOT, 'src', 'electron')),
  ];
  const fetches = new Map<string, string[]>();
  const patterns = [
    /fetch\(\s*['"]([^'"]*\/api\/[^'"]*)['"]/g,
    /fetch\(\s*`([^`]*\/api\/[^`]*)`/g,
  ];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    for (const regex of patterns) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text))) {
        const normalized = normalizeFrontendPath(match[1]);
        const entries = fetches.get(normalized) || [];
        entries.push(rel);
        fetches.set(normalized, entries);
      }
    }
  }

  return fetches;
}

function collectBackendRoutes(): Set<string> {
  const files = [
    ...walk(path.join(ROOT, 'src', 'server', 'gateway')),
    path.join(ROOT, 'src', 'server', 'main.ts'),
  ];
  const routes = new Set<string>();
  const patterns = [
    /(?:readonly\s+)?path\s*=\s*['"]([^'"]*\/api\/[^'"]*)['"]/g,
    /R\(\s*['"](?:GET|POST|PATCH|PUT|DELETE)['"]\s*,\s*['"]([^'"]*\/api\/[^'"]*)['"]/g,
    /url\s*===\s*['"]([^'"]*\/api\/[^'"]*)['"]/g,
  ];

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const regex of patterns) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text))) {
        routes.add(stripQuery(match[1]));
      }
    }
  }

  return routes;
}

function walk(dir: string, output: string[] = []): string[] {
  if (!fs.existsSync(dir)) return output;
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(fullPath, output);
      continue;
    }
    if (/\.(ts|tsx|js|html)$/.test(name)) output.push(fullPath);
  }
  return output;
}

function normalizeFrontendPath(raw: string): string {
  return stripQuery(raw)
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\/:param(?![\w-])/g, '/:param');
}

function stripQuery(apiPath: string): string {
  return apiPath.replace(/\?.*$/, '');
}

function toComparablePath(apiPath: string): string {
  return apiPath.replace(/\/:[^/]+/g, '/:param');
}
