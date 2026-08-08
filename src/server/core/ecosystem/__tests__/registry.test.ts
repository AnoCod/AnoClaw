import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EcosystemRegistry } from '../EcosystemRegistry.js';
import type { EcosystemAdapter, EcosystemAsset } from '../types.js';
import { SkillManager } from '../../skills/SkillManager.js';
import { CommandRegistry } from '../../commands/CommandRegistry.js';
import { AgentRegistry } from '../../agent/AgentRegistry.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';

const TMP = path.resolve(process.cwd(), '.test-ecosystem-registry');

class FakeAdapter implements EcosystemAdapter {
  readonly kind = 'claude' as const;
  constructor(private _assets: EcosystemAsset[]) {}
  roots(): string[] { return []; }
  scan(): Promise<EcosystemAsset[]> { return Promise.resolve(this._assets); }
}

function assets(): EcosystemAsset[] {
  return [
    {
      kind: 'claude',
      assetType: 'skill',
      name: 'foo',
      displayName: 'foo',
      sourcePath: path.join(TMP, 'foo', 'SKILL.md'),
      supportLevel: 'native',
      payload: { content: '---\nname: foo\ndescription: Foo skill\n---\n# Foo\nBody', skillDir: path.join(TMP, 'foo') },
    },
    {
      kind: 'claude',
      assetType: 'mcp',
      name: 'notes',
      displayName: 'notes',
      sourcePath: path.join(TMP, '.mcp.json'),
      supportLevel: 'native',
      payload: { serverName: 'notes', server: { command: 'node', args: ['srv.js'] } },
    },
    {
      kind: 'claude',
      assetType: 'command',
      name: 'review',
      displayName: 'review',
      sourcePath: path.join(TMP, 'review.md'),
      supportLevel: 'native',
      payload: { content: '---\ndescription: Review code\n---\nReview the diff', skillDir: TMP },
    },
    {
      kind: 'opencode',
      assetType: 'agent',
      name: 'helper',
      displayName: 'helper',
      sourcePath: path.join(TMP, 'helper.md'),
      supportLevel: 'partial',
      payload: { content: '---\ndescription: Helper agent\nmode: subagent\n---\nYou help', skillDir: TMP },
    },
    {
      kind: 'openclaw',
      assetType: 'skill',
      name: 'gated',
      displayName: 'gated',
      sourcePath: path.join(TMP, 'gated', 'SKILL.md'),
      supportLevel: 'native',
      payload: {
        content: '---\nname: gated\ndescription: Gated skill\nmetadata: {"openclaw":{"requires":{"env":["ECOSYSTEM_TEST_MISSING_ENV"]}}}\n---\nBody',
        skillDir: path.join(TMP, 'gated'),
      },
    },
    {
      kind: 'opencode',
      assetType: 'plugin',
      name: 'opencode-plug',
      displayName: 'opencode-plug',
      sourcePath: path.join(TMP, 'opencode-plug.mjs'),
      supportLevel: 'bridge',
      payload: { pluginPath: path.join(TMP, 'opencode-plug.mjs'), cwd: TMP },
    },
  ];
}

let statePath: string;
let persisted: Array<Array<{ name: string; origin?: { entryId?: string } }>>;

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  statePath = path.join(TMP, 'ecosystem.json');
  persisted = [];
  EcosystemRegistry.resetInstance();
  SkillManager.resetInstance();
  CommandRegistry.resetInstance();
  AgentRegistry.resetInstance();
  ToolRegistry.resetInstance();
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeRegistry(): EcosystemRegistry {
  return EcosystemRegistry.getInstance({
    statePath,
    watchEnabled: false,
    adapters: [new FakeAdapter(assets())],
    mcpPersist: async (servers) => {
      persisted.push(servers.map((s) => ({ name: s.name, origin: s.origin })));
    },
  });
}

describe('EcosystemRegistry', () => {
  it('start() does not mount anything until entries are enabled', async () => {
    const registry = makeRegistry();
    await registry.start();
    expect(SkillManager.getInstance().allSkills().length).toBe(0);
    expect(registry.entries().length).toBeGreaterThan(0);
  });

  it('enable/disable mounts and unmounts skills, commands, and agents', async () => {
    const registry = makeRegistry();
    await registry.start();

    const skillEntry = registry.entries().find((e) => e.name === 'foo')!;
    await registry.enable(skillEntry.id);
    expect(SkillManager.getInstance().getSkill('claude:foo')).toBeTruthy();

    await registry.disable(skillEntry.id);
    expect(SkillManager.getInstance().getSkill('claude:foo')).toBeUndefined();

    const cmdEntry = registry.entries().find((e) => e.name === 'review')!;
    await registry.enable(cmdEntry.id);
    expect(CommandRegistry.getInstance().hasCommand('claude:review')).toBe(true);
    await registry.disable(cmdEntry.id);
    expect(CommandRegistry.getInstance().hasCommand('claude:review')).toBe(false);

    const agentEntry = registry.entries().find((e) => e.name === 'helper')!;
    await registry.enable(agentEntry.id);
    expect(AgentRegistry.getInstance().allAgents().some((a) => a.name === 'helper')).toBe(true);
    await registry.disable(agentEntry.id);
    expect(AgentRegistry.getInstance().allAgents().some((a) => a.name === 'helper')).toBe(false);
  });

  it('enable/disable persists MCP configs into the injected target', async () => {
    const registry = makeRegistry();
    await registry.start();
    const mcpEntry = registry.entries().find((e) => e.name === 'notes')!;

    await registry.enable(mcpEntry.id);
    expect(persisted.at(-1)).toHaveLength(1);
    expect(persisted.at(-1)![0]).toMatchObject({ name: 'notes', origin: { entryId: mcpEntry.id } });

    await registry.disable(mcpEntry.id);
    expect(persisted.at(-1)).toHaveLength(0);
  });

  it('rejects gated skills with a clear error', async () => {
    const registry = makeRegistry();
    await registry.start();
    const gated = registry.entries().find((e) => e.name === 'gated')!;
    await expect(registry.enable(gated.id)).rejects.toThrow(/gated out/i);
  });

  it('requires a trust review before enabling code plugins', async () => {
    const registry = makeRegistry();
    await registry.start();
    const plugin = registry.entries().find((e) => e.name === 'opencode-plug')!;
    await expect(registry.enable(plugin.id)).rejects.toThrow(/trust review/i);
  });

  it('persists enabled state and remounts after restart', async () => {
    const registry = makeRegistry();
    await registry.start();
    const skillEntry = registry.entries().find((e) => e.name === 'foo')!;
    await registry.enable(skillEntry.id);
    expect(SkillManager.getInstance().getSkill('claude:foo')).toBeTruthy();

    EcosystemRegistry.resetInstance();
    SkillManager.resetInstance();
    const restarted = makeRegistry();
    await restarted.start();
    expect(SkillManager.getInstance().getSkill('claude:foo')).toBeTruthy();
  });

  it('forget() removes the entry and its state', async () => {
    const registry = makeRegistry();
    await registry.start();
    const skillEntry = registry.entries().find((e) => e.name === 'foo')!;
    await registry.enable(skillEntry.id);
    await registry.forget(skillEntry.id);
    expect(registry.entries().some((e) => e.name === 'foo')).toBe(false);
    expect(SkillManager.getInstance().getSkill('claude:foo')).toBeUndefined();
  });
});
