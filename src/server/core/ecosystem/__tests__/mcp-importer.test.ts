import { describe, expect, it } from 'vitest';
import { normalizeMcpServer, extractMcpEntries } from '../importers/mcp-importer.js';

describe('normalizeMcpServer', () => {
  it('maps Codex config.toml stdio shape', () => {
    const { config } = normalizeMcpServer('codex', 'browser', {
      command: 'npx',
      args: ['-y', '@anthropic/browser-use-mcp'],
      env: { BROWSER_USE_HEADLESS: 'false' },
    });
    expect(config).toMatchObject({
      name: 'browser',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropic/browser-use-mcp'],
      env: { BROWSER_USE_HEADLESS: 'false' },
    });
  });

  it('maps OpenCode local command array and remote URL', () => {
    const local = normalizeMcpServer('opencode', 'local-srv', {
      type: 'local',
      command: ['npx', '-y', 'server-everything'],
      environment: { X: '1' },
    }).config;
    expect(local.transport).toBe('stdio');
    expect(local.command).toBe('npx');
    expect(local.args).toEqual(['-y', 'server-everything']);
    expect(local.env).toEqual({ X: '1' });

    const remote = normalizeMcpServer('opencode', 'remote-srv', {
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${env:TOKEN}' },
    }, { env: { TOKEN: 'secret' } }).config;
    expect(remote.transport).toBe('http');
    expect(remote.url).toBe('https://mcp.example.com/mcp');
    expect(remote.headers).toEqual({ Authorization: 'Bearer secret' });
  });

  it('maps OpenClaw mcp.servers with streamable-http and toolFilter', () => {
    const { config } = normalizeMcpServer('openclaw', 'docs', {
      url: 'https://mcp.example.com/mcp',
      transport: 'streamable-http',
      enabled: true,
      toolFilter: { include: ['search', 'read_*'], exclude: ['delete'] },
    });
    expect(config.transport).toBe('http');
    expect(config.enabled).toBe(true);
    expect(config.toolFilter).toEqual({ include: ['search', 'read_*'], exclude: ['delete'] });
  });

  it('maps Hermes YAML mcp_servers with seconds-based timeout', () => {
    const { config } = normalizeMcpServer('hermes', 'github', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${env:GITHUB_TOKEN}' },
      timeout: 120,
      tools: { include: ['list_issues'] },
    });
    expect(config.timeoutMs).toBe(120000);
    expect(config.toolFilter).toEqual({ include: ['list_issues'] });
  });

  it('reports unresolved env placeholders', () => {
    const { warnings } = normalizeMcpServer('claude', 'obsidian', {
      url: 'http://127.0.0.1:27123/mcp/',
      headers: { Authorization: 'Bearer ${env:OBSIDIAN_MCP_TOKEN}' },
    }, { env: {} });
    expect(warnings.some((w) => w.includes('OBSIDIAN_MCP_TOKEN'))).toBe(true);
  });

  it('adds origin metadata when requested', () => {
    const { config } = normalizeMcpServer('codex', 'srv', { command: 'node', args: ['x.js'] }, {
      entryId: 'codex:mcp:srv:abc',
      sourcePath: '/tmp/config.toml',
    });
    expect(config.origin).toEqual({ kind: 'codex', sourcePath: '/tmp/config.toml', entryId: 'codex:mcp:srv:abc' });
  });
});

describe('extractMcpEntries', () => {
  it('handles mcpServers, mcp_servers, and mcp.servers shapes', () => {
    expect(Object.keys(extractMcpEntries({ mcpServers: { a: { command: 'x' } } }))).toEqual(['a']);
    expect(Object.keys(extractMcpEntries({ mcp_servers: { b: { command: 'x' } } }))).toEqual(['b']);
    expect(Object.keys(extractMcpEntries({ mcp: { servers: { c: { command: 'x' } } } }))).toEqual(['c']);
    expect(Object.keys(extractMcpEntries({ mcp: { d: { command: 'x' } } }))).toEqual(['d']);
    expect(Object.keys(extractMcpEntries({ other: {} }))).toEqual([]);
  });
});
