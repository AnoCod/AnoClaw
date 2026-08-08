/**
 * OpenClaw adapter — scans workspace/project/user skills, openclaw.json MCP
 * servers, and local plugin directories with openclaw.plugin.json.
 */

import * as path from 'path';
import type { EcosystemAdapter, EcosystemAsset } from '../types.js';
import {
  dirExists, fileExists, findFilesNamed, findSkillFiles, homeDir,
  parseJson5ish, projectRoot, readTextFile,
} from './base.js';
import { findPluginManifest, expandPluginAssets } from '../importers/plugin-importer.js';

export interface OpenClawAdapterOptions {
  repo?: string;
  home?: string;
  stateDir?: string;
}

export class OpenClawAdapter implements EcosystemAdapter {
  readonly kind = 'openclaw' as const;
  private _opts: Required<OpenClawAdapterOptions>;

  constructor(opts: OpenClawAdapterOptions = {}) {
    const home = homeDir();
    this._opts = {
      repo: opts.repo ?? projectRoot(),
      home: opts.home ?? home,
      stateDir: opts.stateDir ?? (process.env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw')),
    };
  }

  async scan(): Promise<EcosystemAsset[]> {
    const assets: EcosystemAsset[] = [];
    const roots: string[] = [];
    const { repo, home, stateDir } = this._opts;

    // ── Skills (highest → lowest precedence) ─────────────────
    const skillRoots = [
      path.join(repo, 'skills'),
      path.join(repo, '.agents', 'skills'),
      path.join(home, '.agents', 'skills'),
      path.join(stateDir, 'skills'),
    ];
    for (const root of skillRoots) {
      // The AnoClaw app directory is not an OpenClaw workspace: its own
      // skills/ and .agents/skills are native/dev assets, not external imports.
      if (root === path.join(repo, 'skills') || root === path.join(repo, '.agents', 'skills')) continue;
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const skillFile of findSkillFiles(root)) {
        const skillDir = path.dirname(skillFile);
        assets.push({
          kind: 'openclaw',
          assetType: 'skill',
          name: path.basename(skillDir),
          displayName: path.basename(skillDir),
          sourcePath: skillFile,
          supportLevel: 'native',
          detail: root === path.join(repo, 'skills') ? 'OpenClaw workspace skill' : 'OpenClaw skill',
          payload: { content: readTextFile(skillFile) ?? '', skillDir },
        });
      }
    }

    // ── Config: MCP servers ──────────────────────────────────
    const configCandidates = [
      path.join(stateDir, 'openclaw.json'),
      path.join(stateDir, 'openclaw.json5'),
      path.join(repo, 'openclaw.json'),
    ];
    for (const configPath of configCandidates) {
      if (!fileExists(configPath)) continue;
      roots.push(configPath);
      const config = parseJson5ish(readTextFile(configPath) ?? '');
      if (!config) continue;
      const mcp = config.mcp as { servers?: Record<string, Record<string, unknown>> } | undefined;
      if (mcp?.servers) {
        for (const [name, server] of Object.entries(mcp.servers)) {
          assets.push({
            kind: 'openclaw',
            assetType: 'mcp',
            name,
            displayName: name,
            sourcePath: configPath,
            supportLevel: 'native',
            detail: 'MCP server from openclaw.json',
            payload: { serverName: name, server },
          });
        }
      }
    }

    // ── Plugins ──────────────────────────────────────────────
    const pluginRoots = [
      path.join(stateDir, 'plugins'),
      path.join(repo, '.openclaw', 'plugins'),
    ];
    const pluginDirs: string[] = [];
    for (const root of pluginRoots) {
      if (!dirExists(root)) continue;
      roots.push(root);
      for (const manifest of findFilesNamed(root, 'openclaw.plugin.json', 4)) {
        pluginDirs.push(path.dirname(manifest));
      }
    }
    for (const pluginDir of [...new Set(pluginDirs)]) {
      const info = findPluginManifest('openclaw', pluginDir);
      if (info) assets.push(...expandPluginAssets(info));
    }

    this._roots = roots;
    return assets;
  }

  private _roots: string[] = [];
  roots(): string[] { return [...this._roots]; }
}
