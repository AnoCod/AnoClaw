import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CodexAdapter } from '../adapters/codex.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { HermesAdapter } from '../adapters/hermes.js';

const TMP = path.resolve(process.cwd(), '.test-ecosystem-adapters');

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const repo = path.join(TMP, 'repo');
  const home = path.join(TMP, 'home');

  // Codex
  write(path.join(home, '.codex', 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hi\n---\nHi\n');
  write(path.join(home, '.codex', 'plugins', 'p1', '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'p1', version: '1.0.0', description: 'p1', skills: './skills',
  }));
  write(path.join(home, '.codex', 'plugins', 'p1', 'skills', 'plugskill', 'SKILL.md'), '---\nname: plugskill\ndescription: From plugin\n---\nBody\n');
  write(path.join(home, '.codex', 'config.toml'), '[mcp_servers.browser]\ncommand = "npx"\nargs = ["-y", "browser-mcp"]\n');

  // Claude
  write(path.join(repo, '.claude', 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: Foo\n---\nFoo\n');
  write(path.join(repo, '.claude', 'commands', 'review.md'), '---\ndescription: Review\n---\nReview the diff\n');
  write(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { notes: { command: 'node', args: ['srv.js'] } } }));
  write(path.join(repo, '.claude', 'plugins', 'cp', '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'cp', version: '1.0.0', description: 'cp', skills: './skills', commands: './commands',
  }));
  write(path.join(repo, '.claude', 'plugins', 'cp', 'skills', 'inner', 'SKILL.md'), '---\nname: inner\ndescription: Inner\n---\nInner\n');
  write(path.join(repo, '.claude', 'plugins', 'cp', 'commands', 'ship.md'), '---\ndescription: Ship\n---\nShip it\n');

  // OpenClaw
  write(path.join(repo, 'skills', 'anoclaw-owned', 'SKILL.md'), '---\nname: anoclaw-owned\ndescription: Native skill\n---\nNative\n');
  write(path.join(home, '.agents', 'skills', 'baz', 'SKILL.md'), '---\nname: baz\ndescription: Baz\n---\nBaz\n');
  write(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({
    mcp: { servers: { docs: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' } } },
  }));

  // OpenCode
  write(path.join(repo, '.opencode', 'skills', 'qux', 'SKILL.md'), '---\nname: qux\ndescription: Qux\n---\nQux\n');
  write(path.join(repo, '.opencode', 'plugins', 'hello.ts'), 'export default function hello() { return {}; }');
  write(path.join(repo, 'opencode.jsonc'), '{\n  // comment\n  "mcp": { "srv": { "type": "local", "command": ["node", "srv.js"] } },\n}');
  write(path.join(repo, '.opencode', 'agents', 'helper.md'), '---\ndescription: Helper\nmode: subagent\n---\nHelp\n');

  // Hermes
  write(path.join(home, '.hermes', 'skills', 'research', 'arxiv', 'SKILL.md'), '---\nname: arxiv\ndescription: Search arxiv\n---\nSearch\n');
  write(path.join(home, '.hermes', 'config.yaml'), 'mcp_servers:\n  github:\n    command: npx\n    args: ["-y", "server-github"]\n');
  write(path.join(home, '.hermes', 'plugins', 'hello-world', 'plugin.yaml'), 'name: hello-world\nversion: "1.0"\n');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('ecosystem adapters', () => {
  it('codex adapter discovers skills, plugin skills, and MCP from config.toml', async () => {
    const adapter = new CodexAdapter({
      codexHome: path.join(TMP, 'home', '.codex'),
      agentsHome: path.join(TMP, 'home', '.agents'),
      repo: path.join(TMP, 'repo'),
    });
    const assets = await adapter.scan();
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'hello')).toBe(true);
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'plugskill')).toBe(true);
    expect(assets.some((a) => a.assetType === 'plugin' && a.name === 'p1')).toBe(true);
    expect(assets.some((a) => a.assetType === 'mcp' && a.name === 'browser')).toBe(true);
  });

  it('claude adapter discovers skills, commands, plugins, and .mcp.json', async () => {
    const adapter = new ClaudeAdapter({ repo: path.join(TMP, 'repo'), home: path.join(TMP, 'home') });
    const assets = await adapter.scan();
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'foo')).toBe(true);
    expect(assets.some((a) => a.assetType === 'command' && a.name === 'review')).toBe(true);
    expect(assets.some((a) => a.assetType === 'plugin' && a.name === 'cp')).toBe(true);
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'inner')).toBe(true);
    expect(assets.some((a) => a.assetType === 'command' && a.name === 'ship')).toBe(true);
    expect(assets.some((a) => a.assetType === 'mcp' && a.name === 'notes')).toBe(true);
  });

  it('openclaw adapter discovers workspace skills and mcp.servers', async () => {
    const adapter = new OpenClawAdapter({
      repo: path.join(TMP, 'repo'),
      home: path.join(TMP, 'home'),
      stateDir: path.join(TMP, 'home', '.openclaw'),
    });
    const assets = await adapter.scan();
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'baz')).toBe(true);
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'anoclaw-owned')).toBe(false);
    expect(assets.some((a) => a.assetType === 'mcp' && a.name === 'docs')).toBe(true);
  });

  it('opencode adapter discovers skills, plugins, agents, and MCP', async () => {
    const adapter = new OpenCodeAdapter({
      repo: path.join(TMP, 'repo'),
      globalDir: path.join(TMP, 'home', '.config', 'opencode'),
    });
    const assets = await adapter.scan();
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'qux')).toBe(true);
    expect(assets.some((a) => a.assetType === 'plugin' && a.name === 'hello' && a.supportLevel === 'bridge')).toBe(true);
    expect(assets.some((a) => a.assetType === 'agent' && a.name === 'helper')).toBe(true);
    expect(assets.some((a) => a.assetType === 'mcp' && a.name === 'srv')).toBe(true);
  });

  it('hermes adapter discovers nested skills, MCP, and Python plugins as unsupported', async () => {
    const adapter = new HermesAdapter({ hermesHome: path.join(TMP, 'home', '.hermes') });
    const assets = await adapter.scan();
    expect(assets.some((a) => a.assetType === 'skill' && a.name === 'arxiv')).toBe(true);
    expect(assets.some((a) => a.assetType === 'mcp' && a.name === 'github')).toBe(true);
    const plugin = assets.find((a) => a.assetType === 'plugin' && a.name === 'hello-world');
    expect(plugin).toBeTruthy();
    expect(plugin!.supportLevel).toBe('unsupported');
  });
});
