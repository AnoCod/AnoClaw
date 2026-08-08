/**
 * Plugin importer — recognizes plugin manifests from each ecosystem and
 * expands their declarative surfaces (skills / MCP / commands / agents /
 * hooks) into individual ecosystem assets.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { EcosystemAsset, EcosystemKind, SupportLevel } from '../types.js';
import { extractMcpEntries } from './mcp-importer.js';

export interface PluginManifestInfo {
  kind: EcosystemKind;
  pluginDir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
}

const MANIFEST_NAMES: Record<EcosystemKind, string[]> = {
  codex: ['.codex-plugin/plugin.json'],
  claude: ['.claude-plugin/plugin.json'],
  openclaw: ['openclaw.plugin.json', 'plugin.json'],
  opencode: ['plugin.json', 'opencode.plugin.json'],
  hermes: ['plugin.yaml'],
};

export function findPluginManifest(kind: EcosystemKind, pluginDir: string): PluginManifestInfo | null {
  for (const rel of MANIFEST_NAMES[kind]) {
    const manifestPath = path.join(pluginDir, rel);
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = rel.endsWith('.yaml') || rel.endsWith('.yml')
        ? (yaml.parse(raw) as Record<string, unknown>)
        : (JSON.parse(raw) as Record<string, unknown>);
      if (!manifest || typeof manifest !== 'object') continue;
      return { kind, pluginDir, manifestPath, manifest };
    } catch {
      continue;
    }
  }
  return null;
}

function resolvePaths(value: unknown, baseDir: string): string[] {
  if (typeof value === 'string') return [path.resolve(baseDir, value)];
  if (Array.isArray(value)) return value.map((v) => path.resolve(baseDir, String(v)));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [path.resolve(baseDir, JSON.stringify(value))];
  }
  return [];
}

function findSkillFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
      if (fs.existsSync(path.join(full, 'SKILL.md'))) out.push(path.join(full, 'SKILL.md'));
      else findSkillFiles(full, out);
    }
  }
  return out;
}

function findMarkdownFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(dir, e.name));
}

function skillAsset(kind: EcosystemKind, pluginDir: string, skillFile: string, pluginName: string): EcosystemAsset {
  const skillDir = path.dirname(skillFile);
  return {
    kind,
    assetType: 'skill',
    name: path.basename(skillDir),
    displayName: path.basename(skillDir),
    sourcePath: skillFile,
    supportLevel: 'native',
    detail: `From ${pluginName} (${kind} plugin)`,
    payload: {
      content: fs.readFileSync(skillFile, 'utf8'),
      skillDir,
      pluginRoot: pluginDir,
    },
  };
}

/**
 * Expand a recognized plugin manifest into its declarative assets.
 * Codex/Claude map natively; OpenClaw/OpenCode map partially; Hermes plugins
 * are code-only and reported as unsupported (their skills live separately).
 */
export function expandPluginAssets(info: PluginManifestInfo): EcosystemAsset[] {
  const { kind, pluginDir, manifest } = info;
  const pluginName = String(manifest.name ?? path.basename(pluginDir));
  const displayName = String(manifest.displayName ?? manifest.description ?? pluginName);
  const assets: EcosystemAsset[] = [];

  const pluginAsset: EcosystemAsset = {
    kind,
    assetType: 'plugin',
    name: pluginName,
    displayName,
    sourcePath: info.manifestPath,
    supportLevel: kind === 'codex' || kind === 'claude' ? 'native' : kind === 'hermes' ? 'unsupported' : 'partial',
    detail: `Plugin manifest ${path.basename(info.manifestPath)}`,
    payload: { manifest, pluginDir },
  };
  assets.push(pluginAsset);

  // ── Skills ────────────────────────────────────────────────
  const skillsField = manifest.skills;
  const skillDirs: string[] = [];
  if (typeof skillsField === 'string' || Array.isArray(skillsField)) {
    for (const dir of resolvePaths(skillsField, pluginDir)) {
      skillDirs.push(...findSkillFiles(dir));
    }
  }
  for (const skillFile of skillDirs) assets.push(skillAsset(kind, pluginDir, skillFile, pluginName));

  // ── MCP ───────────────────────────────────────────────────
  let mcpEntries: Record<string, Record<string, unknown>> = {};
  const mcpRaw = manifest.mcpServers ?? manifest.mcp;
  if (typeof mcpRaw === 'string') {
    const mcpFile = path.resolve(pluginDir, mcpRaw);
    try {
      mcpEntries = extractMcpEntries(JSON.parse(fs.readFileSync(mcpFile, 'utf8')) as Record<string, unknown>);
    } catch { /* keep empty */ }
  } else if (mcpRaw && typeof mcpRaw === 'object') {
    mcpEntries = extractMcpEntries({ mcpServers: mcpRaw });
  }
  for (const [serverName, serverRaw] of Object.entries(mcpEntries)) {
    assets.push({
      kind,
      assetType: 'mcp',
      name: serverName,
      displayName: serverName,
      sourcePath: pluginDir,
      supportLevel: 'native',
      detail: `MCP server bundled by ${pluginName}`,
      payload: { serverName, server: serverRaw, pluginRoot: pluginDir },
    });
  }

  // ── Commands (Claude / OpenClaw) ──────────────────────────
  if (kind === 'claude' || kind === 'openclaw' || kind === 'opencode') {
    const commandsField = manifest.commands;
    let commandDirs: string[] = [];
    if (typeof commandsField === 'string' || Array.isArray(commandsField)) {
      commandDirs = resolvePaths(commandsField, pluginDir);
    } else if (commandsField && typeof commandsField === 'object') {
      commandDirs = Object.values(commandsField).map((v) => path.resolve(pluginDir, String(v)));
    }
    for (const dir of commandDirs) {
      for (const file of findMarkdownFiles(dir)) {
        assets.push({
          kind,
          assetType: 'command',
          name: path.basename(file, '.md'),
          displayName: path.basename(file, '.md'),
          sourcePath: file,
          supportLevel: 'native',
          detail: `Command bundled by ${pluginName}`,
          payload: { content: fs.readFileSync(file, 'utf8'), skillDir: path.dirname(file), pluginRoot: pluginDir },
        });
      }
    }
  }

  // ── Agents (Claude / OpenCode) ────────────────────────────
  if (kind === 'claude' || kind === 'opencode') {
    const agentsField = manifest.agents;
    const agentDirs = typeof agentsField === 'string' || Array.isArray(agentsField)
      ? resolvePaths(agentsField, pluginDir)
      : [];
    for (const dir of agentDirs) {
      for (const file of findMarkdownFiles(dir)) {
        assets.push({
          kind,
          assetType: 'agent',
          name: path.basename(file, '.md'),
          displayName: path.basename(file, '.md'),
          sourcePath: file,
          supportLevel: 'partial',
          detail: `Agent bundled by ${pluginName} (runtime-registered)`,
          payload: { content: fs.readFileSync(file, 'utf8'), skillDir: path.dirname(file), pluginRoot: pluginDir },
        });
      }
    }
  }

  // ── Hooks (Codex / Claude / OpenClaw) ─────────────────────
  if (kind === 'codex' || kind === 'claude' || kind === 'openclaw') {
    const hooksRaw = manifest.hooks;
    let hooksFile: string | null = null;
    if (typeof hooksRaw === 'string') hooksFile = path.resolve(pluginDir, hooksRaw);
    else if (Array.isArray(hooksRaw) && typeof hooksRaw[0] === 'string') hooksFile = path.resolve(pluginDir, hooksRaw[0]);
    else if (!hooksRaw && kind === 'codex' && fs.existsSync(path.join(pluginDir, 'hooks', 'hooks.json'))) {
      hooksFile = path.join(pluginDir, 'hooks', 'hooks.json');
    }
    if (hooksFile && fs.existsSync(hooksFile)) {
      assets.push({
        kind,
        assetType: 'hook',
        name: 'hooks',
        displayName: `${pluginName} hooks`,
        sourcePath: hooksFile,
        supportLevel: 'partial',
        detail: 'Lifecycle hooks mapped to TypedEventBus events where names overlap',
        payload: { hooksFile, pluginRoot: pluginDir },
      });
    }
  }

  return assets;
}

export function loadHooksJson(hooksFile: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(hooksFile, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
