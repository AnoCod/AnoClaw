/**
 * Codex adapter — scans ~/.codex skills, plugins (marketplace-managed and
 * local), config.toml MCP servers, and project .mcp.json.
 */

import * as path from 'path';
import { parse } from 'smol-toml';
import type { EcosystemAdapter, EcosystemAsset } from '../types.js';
import {
  dirExists, fileExists, findFilesNamed, findSkillFiles, homeDir, projectRoot, readJsonFile, readTextFile,
} from './base.js';
import { findPluginManifest, expandPluginAssets } from '../importers/plugin-importer.js';
import { extractMcpEntries } from '../importers/mcp-importer.js';

export interface CodexAdapterOptions {
  codexHome?: string;
  agentsHome?: string;
  repo?: string;
}

export class CodexAdapter implements EcosystemAdapter {
  readonly kind = 'codex' as const;
  private _opts: Required<CodexAdapterOptions>;

  constructor(opts: CodexAdapterOptions = {}) {
    const home = homeDir();
    this._opts = {
      codexHome: opts.codexHome ?? path.join(home, '.codex'),
      agentsHome: opts.agentsHome ?? path.join(home, '.agents'),
      repo: opts.repo ?? projectRoot(),
    };
  }

  async scan(): Promise<EcosystemAsset[]> {
    const assets: EcosystemAsset[] = [];
    const roots: string[] = [];
    const { codexHome, agentsHome, repo } = this._opts;

    // ── Skills ───────────────────────────────────────────────
    const skillRoots = [path.join(codexHome, 'skills')];
    for (const root of skillRoots) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const skillFile of findSkillFiles(root)) {
        const skillDir = path.dirname(skillFile);
        assets.push({
          kind: 'codex',
          assetType: 'skill',
          name: path.basename(skillDir),
          displayName: path.basename(skillDir),
          sourcePath: skillFile,
          supportLevel: 'native',
          detail: 'Codex user skill',
          payload: { content: readTextFile(skillFile) ?? '', skillDir },
        });
      }
    }

    // ── Plugins (installed + marketplace-referenced) ─────────
    const pluginCandidates: string[] = [];
    const installedRoot = path.join(codexHome, 'plugins');
    if (dirExists(installedRoot)) {
      roots.push(installedRoot);
      for (const manifest of findFilesNamed(installedRoot, 'plugin.json', 5)) {
        if (manifest.includes(`${path.sep}.codex-plugin${path.sep}`)) {
          pluginCandidates.push(path.resolve(path.dirname(manifest), '..'));
        }
      }
    }
    for (const marketFile of [
      path.join(agentsHome, 'plugins', 'marketplace.json'),
      path.join(repo, '.agents', 'plugins', 'marketplace.json'),
    ]) {
      const market = readJsonFile<{ plugins?: Array<{ name?: string; source?: { path?: string } | string }> }>(marketFile);
      if (!market?.plugins) continue;
      const marketRoot = path.dirname(marketFile);
      for (const entry of market.plugins) {
        const sourcePath = typeof entry.source === 'string' ? entry.source : entry.source?.path;
        if (!sourcePath) continue;
        pluginCandidates.push(path.resolve(marketRoot, sourcePath));
      }
    }
    for (const pluginDir of [...new Set(pluginCandidates)]) {
      const info = findPluginManifest('codex', pluginDir);
      if (info) assets.push(...expandPluginAssets(info));
    }

    // ── MCP: config.toml + project .mcp.json ─────────────────
    const tomlPath = path.join(codexHome, 'config.toml');
    if (fileExists(tomlPath)) {
      roots.push(tomlPath);
      try {
        const toml = parse(readTextFile(tomlPath) ?? '') as Record<string, unknown>;
        const servers = toml.mcp_servers as Record<string, Record<string, unknown>> | undefined;
        if (servers) {
          for (const [name, server] of Object.entries(servers)) {
            assets.push({
              kind: 'codex',
              assetType: 'mcp',
              name,
              displayName: name,
              sourcePath: tomlPath,
              supportLevel: 'native',
              detail: 'MCP server from ~/.codex/config.toml',
              payload: { serverName: name, server },
            });
          }
        }
      } catch { /* unparsable toml — skipped */ }
    }
    const mcpJson = path.join(repo, '.mcp.json');
    if (fileExists(mcpJson)) {
      roots.push(mcpJson);
      const raw = readJsonFile(mcpJson) ?? {};
      for (const [name, server] of Object.entries(extractMcpEntries(raw))) {
        assets.push({
          kind: 'codex',
          assetType: 'mcp',
          name,
          displayName: name,
          sourcePath: mcpJson,
          supportLevel: 'native',
          detail: 'MCP server from project .mcp.json',
          payload: { serverName: name, server },
        });
      }
    }

    this._roots = roots;
    return assets;
  }

  private _roots: string[] = [];
  roots(): string[] { return [...this._roots]; }
}
