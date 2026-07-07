import { describe, it, expect, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiServer } from '../ApiServer.js';
import type { RouteHandler, RouteMatch } from '../RouteHandler.js';
import { handleBrowseWorkspace, resolveWorkspacePath } from '../handlers/WorkspaceHandlers.js';

interface Capture {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockReq(url: string, origin?: string, remoteAddress = '10.0.0.5'): IncomingMessage {
  return Object.assign(new EventEmitter(), {
    method: 'GET',
    url,
    headers: origin ? { origin } : {},
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
}

function mockRes(capture: Capture): ServerResponse {
  return {
    setHeader: (key: string, value: string) => { capture.headers[key] = value; },
    writeHead: (status: number) => { capture.status = status; },
    end: (data?: string) => {
      if (!data) return;
      try { capture.body = JSON.parse(data); }
      catch { capture.body = { raw: data }; }
    },
  } as unknown as ServerResponse;
}

describe('ApiServer security boundaries', () => {
  let api: ApiServer;

  beforeEach(() => {
    api = ApiServer.getInstance();
    (api as unknown as { _routeTable: RouteHandler[] })._routeTable = [];
  });

  it('rejects permissioned routes when no token is present', async () => {
    api.registerRoute({
      method: 'GET',
      path: '/api/v1/secure',
      permission: 'admin',
      handle: (_match, _req, res) => {
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
    });

    const capture: Capture = { status: 0, headers: {}, body: {} };
    await api.handleApiRequest(mockReq('/api/v1/secure'), mockRes(capture));

    expect(capture.status).toBe(401);
    expect(capture.body.error).toBe('Unauthorized');
  });

  it('passes query parameters into declarative route matches', async () => {
    let seen: string | null = null;
    api.registerRoute({
      method: 'GET',
      path: '/api/v1/items',
      handle: (match: RouteMatch, _req, res) => {
        seen = match.query.get('groupId');
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
    });

    const capture: Capture = { status: 0, headers: {}, body: {} };
    await api.handleApiRequest(mockReq('/api/v1/items?groupId=alpha', undefined, '127.0.0.1'), mockRes(capture));

    expect(seen).toBe('alpha');
  });

  it('rejects cross-origin browser requests before routing', async () => {
    api.registerRoute({
      method: 'GET',
      path: '/api/v1/secure',
      handle: (_match, _req, res) => {
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
    });

    const capture: Capture = { status: 0, headers: {}, body: {} };
    await api.handleApiRequest(mockReq('/api/v1/secure', 'https://example.test'), mockRes(capture));

    expect(capture.status).toBe(403);
    expect(capture.body.error).toBe('Forbidden');
  });

  it('does not treat sibling paths as inside the workspace', () => {
    const base = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
    const sibling = process.platform === 'win32' ? 'C:\\work\\project-evil\\file.txt' : '/work/project-evil/file.txt';

    expect(() => resolveWorkspacePath(base, sibling)).toThrow('Path escapes workspace root');
  });

  it('resolves the browser file-tree root slash to the workspace root', () => {
    const base = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

    expect(resolveWorkspacePath(base, '/')).toBe(pathResolveForTest(base));
  });

  it('treats leading-slash file-tree paths as workspace-relative', () => {
    if (process.platform !== 'win32') return;
    const base = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
    const expected = process.platform === 'win32' ? 'C:\\work\\project\\src\\index.ts' : '/work/project/src/index.ts';

    expect(resolveWorkspacePath(base, '/src/index.ts')).toBe(pathResolveForTest(expected));
  });

  it('filters nested workspace browse entries using root gitignore semantics', async () => {
    const previousCwd = process.cwd();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anoclaw-gitignore-'));

    try {
      fs.writeFileSync(path.join(workspaceRoot, '.gitignore'), [
        'src/public/js/',
        '*.log',
        '*.tmp',
        'release*/',
      ].join('\n'));

      fs.mkdirSync(path.join(workspaceRoot, 'src/public/js/components'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'src/public/js/main.js'), '');
      fs.writeFileSync(path.join(workspaceRoot, 'src/public/js/components/foo.js'), '');
      fs.mkdirSync(path.join(workspaceRoot, 'src/public/vendor'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'src/public/vendor/other.tmp'), '');
      fs.mkdirSync(path.join(workspaceRoot, 'foo/bar'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'foo/bar/baz.log'), '');
      fs.mkdirSync(path.join(workspaceRoot, 'release9/win-unpacked'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'release9/win-unpacked/AnoClaw.exe'), '');
      fs.mkdirSync(path.join(workspaceRoot, 'visible'), { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'visible/keep.txt'), '');

      process.chdir(workspaceRoot);

      expect(browseNames(await browseWorkspace('/'))).not.toContain('release9');
      expect(browseNames(await browseWorkspace('foo/bar'))).not.toContain('baz.log');
      expect(browseNames(await browseWorkspace('src/public/vendor'))).not.toContain('other.tmp');
      const ignoredDirectoryNames = browseNames(await browseWorkspace('src/public/js'));
      expect(ignoredDirectoryNames).not.toContain('components');
      expect(ignoredDirectoryNames).not.toContain('main.js');
      expect(browseNames(await browseWorkspace('visible'))).toContain('keep.txt');
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function pathResolveForTest(p: string): string {
  return process.platform === 'win32'
    ? p.replace(/\//g, '\\')
    : p.replace(/\\/g, '/');
}

async function browseWorkspace(browsePath: string): Promise<Capture> {
  const capture: Capture = { status: 0, headers: {}, body: {} };
  const encodedPath = encodeURIComponent(browsePath);
  await handleBrowseWorkspace(
    mockReq(`/api/v1/workspace/browse?path=${encodedPath}`, undefined, '127.0.0.1'),
    mockRes(capture),
    (_res, status, body) => {
      capture.status = status;
      capture.body = body as Record<string, unknown>;
    },
    '127.0.0.1',
    15730,
  );
  return capture;
}

function browseNames(capture: Capture): string[] {
  expect(capture.status).toBe(200);
  const nodes = capture.body.nodes as Array<{ name: string }> | undefined;
  return (nodes ?? []).map(node => node.name);
}
