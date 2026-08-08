/**
 * Claude Code adapter — scans project/user .claude skills, commands, plugins
 * and MCP configs (.mcp.json + ~/.claude.json).
 */

import * as path from 'path';
import type { EcosystemAdapter, EcosystemAsset } from '../types.js';
import {
  dirExists, fileExists, findFilesNamed, findMarkdownFiles, findSkillFiles,
  homeDir, projectRoot, readJsonFile, readTextFile,
} from './base.js';
import { findPluginManifest, expandPluginAssets } from '../importers/plugin-importer.js';
import { extractMcpEntries } from '../importers/mcp-importer.js';

export interface ClaudeAdapterOptions {
  repo?: string;
  home?: string;
}

export class ClaudeAdapter implements EcosystemAdapter {
  readonly kind = 'claude' as const;
  private _opts: Required<ClaudeAdapterOptions>;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this._opts = {
      repo: opts.repo ?? projectRoot(),
      home: opts.home ?? homeDir(),
    };
  }

  async scan(): Promise<EcosystemAsset[]> {
    const assets: EcosystemAsset[] = [];
    const roots: string[] = [];
    const { repo, home } = this._opts;

    // ── Skills ───────────────────────────────────────────────
    const skillRoots = [path.join(repo, '.claude', 'skills'), path.join(home, '.claude', 'skills')];
    for (const root of skillRoots) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const skillFile of findSkillFiles(root)) {
        const skillDir = path.dirname(skillFile);
        assets.push({
          kind: 'claude',
          assetType: 'skill',
          name: path.basename(skillDir),
          displayName: path.basename(skillDir),
          sourcePath: skillFile,
          supportLevel: 'native',
          detail: root.startsWith(home) ? 'Claude user skill' : 'Claude project skill',
          payload: { content: readTextFile(skillFile) ?? '', skillDir },
        });
      }
    }

    // ── Commands ─────────────────────────────────────────────
    const commandRoots = [path.join(repo, '.claude', 'commands'), path.join(home, '.claude', 'commands')];
    for (const root of commandRoots) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const file of findMarkdownFiles(root)) {
        assets.push({
          kind: 'claude',
          assetType: 'command',
          name: path.basename(file, '.md'),
          displayName: path.basename(file, '.md'),
          sourcePath: file,
          supportLevel: 'native',
          detail: 'Claude slash command',
          payload: { content: readTextFile(file) ?? '', skillDir: path.dirname(file) },
        });
      }
    }

    // ── Plugins ──────────────────────────────────────────────
    const pluginRoots = [path.join(home, '.claude', 'plugins'), path.join(repo, '.claude', 'plugins')];
    const pluginDirs: string[] = [];
    for (const root of pluginRoots) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const manifest of findFilesNamed(root, 'plugin.json', 5)) {
        if (manifest.includes(`${path.sep}.claude-plugin${path.sep}`)) {
          pluginDirs.push(path.resolve(path.dirname(manifest), '..'));
        }
      }
    }
    for (const pluginDir of [...new Set(pluginDirs)]) {
      const info = findPluginManifest('claude', pluginDir);
      if (info) assets.push(...expandPluginAssets(info));
    }

    // ── MCP ──────────────────────────────────────────────────
    const mcpFiles = [
      path.join(repo, '.mcp.json'),
      path.join(home, '.claude.json'),
      path.join(repo, '.claude', 'mcp.json'),
    ];
    for (const mcpFile of mcpFiles) {
      if (!fileExists(mcpFile)) continue;
      roots.push(mcpFile);
      const raw = readJsonFile(mcpFile) ?? {};
      const entries = extractMcpEntries(raw);
      for (const [name, server] of Object.entries(entries)) {
        assets.push({
          kind: 'claude',
          assetType: 'mcp',
          name,
          displayName: name,
          sourcePath: mcpFile,
          supportLevel: 'native',
          detail: `MCP server from ${path.basename(mcpFile)}`,
          payload: { serverName: name, server },
        });
      }
    }

    // ── Project rules (detect-only) ──────────────────────────
    for (const rule of ['CLAUDE.md', 'AGENTS.md']) {
      const rulePath = path.join(repo, rule);
      if (fileExists(rulePath)) {
        assets.push({
          kind: 'claude',
          assetType: 'rule',
          name: rule.replace(/\.md$/, ''),
          displayName: rule,
          sourcePath: rulePath,
          supportLevel: 'native',
          detail: 'Project instruction file (listed only; not auto-injected)',
          payload: { content: readTextFile(rulePath) ?? '' },
        });
      }
    }

    this._roots = roots;
    return assets;
  }

  private _roots: string[] = [];
  roots(): string[] { return [...this._roots]; }
}
