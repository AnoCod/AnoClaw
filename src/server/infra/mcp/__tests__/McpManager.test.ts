import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { McpManager } from '../McpManager.js';
import { ToolRegistry } from '../../../core/tools/ToolRegistry.js';

const TMP = path.resolve(process.cwd(), '.test-mcp-manager');

let configPath: string;

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  configPath = path.join(TMP, 'mcp-servers.json');
  McpManager.resetInstance();
  ToolRegistry.resetInstance();
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('McpManager (native)', () => {
  it('init() registers the six agent-facing MCP tools', async () => {
    const manager = McpManager.getInstance({ configPath });
    await manager.init();
    const registry = ToolRegistry.getInstance();
    expect(registry.hasTool('MCPListTools')).toBe(true);
    expect(registry.hasTool('MCPExecute')).toBe(true);
    expect(registry.hasTool('MCPListResources')).toBe(true);
    expect(registry.hasTool('MCPReadResource')).toBe(true);
    expect(registry.hasTool('MCPListPrompts')).toBe(true);
    expect(registry.hasTool('MCPGetPrompt')).toBe(true);
  });

  it('addServer persists config and shows a disconnected entry', async () => {
    const manager = McpManager.getInstance({ configPath });
    await manager.init();
    await manager.addServer({
      name: 'browser',
      transport: 'stdio',
      command: 'npx -y @anthropic/browser-use-mcp',
    });
    const states = manager.listServers();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ name: 'browser', transport: 'stdio', connected: false });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).servers).toHaveLength(1);
  });

  it('updateServer merges fields and reconnect path exists', async () => {
    const manager = McpManager.getInstance({ configPath });
    await manager.init();
    await manager.addServer({ name: 'srv', transport: 'http', url: 'https://a.example/mcp' });
    await manager.updateServer('srv', { url: 'https://b.example/mcp', env: { TOKEN: 'x' } });
    const states = manager.listServers();
    expect(states[0].url).toBe('https://b.example/mcp');
    expect(states[0].command).toBeUndefined();
    await expect(manager.reconnect('missing')).rejects.toThrow('Server not found');
  });

  it('deleteServer removes config and client', async () => {
    const manager = McpManager.getInstance({ configPath });
    await manager.init();
    await manager.addServer({ name: 'tmp', transport: 'stdio', command: 'node x.js' });
    expect(await manager.deleteServer('tmp')).toBe(true);
    expect(manager.listServers()).toHaveLength(0);
    expect(await manager.deleteServer('tmp')).toBe(false);
  });

  it('replaceImportedServers keeps manual servers and replaces imports by entryId', async () => {
    const manager = McpManager.getInstance({ configPath });
    await manager.init();
    await manager.addServer({ name: 'manual', transport: 'stdio', command: 'node m.js' });
    await manager.replaceImportedServers([
      {
        name: 'ecosystem-a',
        transport: 'stdio',
        command: 'node e.js',
        origin: { kind: 'codex', sourcePath: '/x', entryId: 'codex:mcp:a' },
      },
    ]);
    expect(manager.listServers().map((s) => s.name).sort()).toEqual(['ecosystem-a', 'manual']);

    // Same entryId -> replaced, not duplicated; manual stays.
    await manager.replaceImportedServers([
      {
        name: 'ecosystem-a-v2',
        transport: 'http',
        url: 'https://new.example/mcp',
        origin: { kind: 'codex', sourcePath: '/x', entryId: 'codex:mcp:a' },
      },
    ]);
    const names = manager.listServers().map((s) => s.name).sort();
    expect(names).toEqual(['ecosystem-a-v2', 'manual']);
  });

  it('migrates legacy plugin data on first run', async () => {
    const legacy = path.join(TMP, 'legacy-data.json');
    fs.writeFileSync(legacy, JSON.stringify({
      servers: [{ name: 'old-srv', transport: 'stdio', command: 'node old.js' }],
    }), 'utf8');
    const manager = McpManager.getInstance({ configPath, migrationCandidates: [legacy] });
    await manager.init();
    expect(manager.listServers().map((s) => s.name)).toEqual(['old-srv']);
    expect(fs.existsSync(configPath)).toBe(true);
  });
});
