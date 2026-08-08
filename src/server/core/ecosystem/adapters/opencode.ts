/**
 * OpenCode adapter — scans project/global .opencode skills, opencode.json MCP
 * servers, local JS/TS plugins, agents, and commands.
 */

import * as path from 'path';
import { readdirSync } from 'node:fs';
import type { EcosystemAdapter, EcosystemAsset } from '../types.js';
import {
  dirExists, fileExists, findMarkdownFiles, findSkillFiles, homeDir,
  parseJson5ish, projectRoot, readTextFile,
} from './base.js';
import { extractMcpEntries } from '../importers/mcp-importer.js';

export interface OpenCodeAdapterOptions {
  repo?: string;
  globalDir?: string;
}

export class OpenCodeAdapter implements EcosystemAdapter {
  readonly kind = 'opencode' as const;
  private _opts: Required<OpenCodeAdapterOptions>;

  constructor(opts: OpenCodeAdapterOptions = {}) {
    this._opts = {
      repo: opts.repo ?? projectRoot(),
      globalDir: opts.globalDir ?? path.join(homeDir(), '.config', 'opencode'),
    };
  }

  async scan(): Promise<EcosystemAsset[]> {
    const assets: EcosystemAsset[] = [];
    const roots: string[] = [];
    const { repo, globalDir } = this._opts;

    // ── Skills ───────────────────────────────────────────────
    for (const root of [path.join(repo, '.opencode', 'skills'), path.join(globalDir, 'skills')]) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const skillFile of findSkillFiles(root)) {
        const skillDir = path.dirname(skillFile);
        assets.push({
          kind: 'opencode',
          assetType: 'skill',
          name: path.basename(skillDir),
          displayName: path.basename(skillDir),
          sourcePath: skillFile,
          supportLevel: 'native',
          detail: root.startsWith(globalDir) ? 'OpenCode global skill' : 'OpenCode project skill',
          payload: { content: readTextFile(skillFile) ?? '', skillDir },
        });
      }
    }

    // ── Configs: MCP + plugin references ─────────────────────
    const configPaths = [
      path.join(repo, 'opencode.json'),
      path.join(repo, 'opencode.jsonc'),
      path.join(globalDir, 'opencode.json'),
      path.join(globalDir, 'opencode.jsonc'),
    ];
    for (const configPath of configPaths) {
      if (!fileExists(configPath)) continue;
      roots.push(configPath);
      const config = parseJson5ish(readTextFile(configPath) ?? '');
      if (!config) continue;
      const mcp = config.mcp as Record<string, Record<string, unknown>> | undefined;
      if (mcp) {
        for (const [name, server] of Object.entries(mcp)) {
          assets.push({
            kind: 'opencode',
            assetType: 'mcp',
            name,
            displayName: name,
            sourcePath: configPath,
            supportLevel: 'native',
            detail: 'MCP server from opencode.json',
            payload: { serverName: name, server },
          });
        }
      }
      const pluginRefs = config.plugin;
      if (typeof pluginRefs === 'string') {
        assets.push(this._npmPluginAsset(pluginRefs, configPath));
      } else if (Array.isArray(pluginRefs)) {
        for (const ref of pluginRefs) {
          if (typeof ref === 'string') assets.push(this._npmPluginAsset(ref, configPath));
        }
      }
    }

    // ── Local plugins (JS/TS files) ──────────────────────────
    for (const root of [path.join(repo, '.opencode', 'plugins'), path.join(globalDir, 'plugins')]) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const entry of this._pluginFiles(root)) {
        assets.push({
          kind: 'opencode',
          assetType: 'plugin',
          name: path.basename(entry, path.extname(entry)),
          displayName: path.basename(entry, path.extname(entry)),
          sourcePath: entry,
          supportLevel: 'bridge',
          detail: 'OpenCode JS/TS plugin (worker bridge)',
          payload: { pluginPath: entry, cwd: repo },
        });
      }
    }

    // ── Agents + commands ────────────────────────────────────
    for (const root of [path.join(repo, '.opencode', 'agents'), path.join(globalDir, 'agents')]) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const file of findMarkdownFiles(root)) {
        assets.push({
          kind: 'opencode',
          assetType: 'agent',
          name: path.basename(file, '.md'),
          displayName: path.basename(file, '.md'),
          sourcePath: file,
          supportLevel: 'partial',
          detail: 'OpenCode agent (runtime-registered)',
          payload: { content: readTextFile(file) ?? '', skillDir: path.dirname(file) },
        });
      }
    }
    for (const root of [path.join(repo, '.opencode', 'commands'), path.join(globalDir, 'commands')]) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const file of findMarkdownFiles(root)) {
        assets.push({
          kind: 'opencode',
          assetType: 'command',
          name: path.basename(file, '.md'),
          displayName: path.basename(file, '.md'),
          sourcePath: file,
          supportLevel: 'native',
          detail: 'OpenCode slash command',
          payload: { content: readTextFile(file) ?? '', skillDir: path.dirname(file) },
        });
      }
    }

    // ── Rules (detect-only) ──────────────────────────────────
    const rulePath = path.join(repo, 'AGENTS.md');
    if (fileExists(rulePath)) {
      assets.push({
        kind: 'opencode',
        assetType: 'rule',
        name: 'agents',
        displayName: 'AGENTS.md',
        sourcePath: rulePath,
        supportLevel: 'native',
        detail: 'Project instruction file (listed only; not auto-injected)',
        payload: { content: readTextFile(rulePath) ?? '' },
      });
    }

    this._roots = roots;
    return assets;
  }

  private _npmPluginAsset(ref: string, configPath: string): EcosystemAsset {
    return {
      kind: 'opencode',
      assetType: 'plugin',
      name: ref,
      displayName: ref,
      sourcePath: configPath,
      supportLevel: 'unsupported',
      detail: 'npm plugin package — install via AnoClaw plugin flow first, then re-scan',
      payload: { npmRef: ref },
    };
  }

  private _pluginFiles(dir: string): string[] {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && /\.(js|mjs|cjs|ts)$/.test(e.name))
        .map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  }

  private _roots: string[] = [];
  roots(): string[] { return [...this._roots]; }
}
