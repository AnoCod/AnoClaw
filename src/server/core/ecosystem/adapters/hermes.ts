/**
 * Hermes adapter — scans ~/.hermes skills (agentskills.io compatible),
 * config mcp_servers (YAML), and plugin manifests (Python; detect-only).
 */

import * as path from 'path';
import type { EcosystemAdapter, EcosystemAsset } from '../types.js';
import {
  dirExists, fileExists, findFilesNamed, findSkillFiles, homeDir, readTextFile, readYamlFile,
} from './base.js';

export interface HermesAdapterOptions {
  hermesHome?: string;
}

export class HermesAdapter implements EcosystemAdapter {
  readonly kind = 'hermes' as const;
  private _opts: Required<HermesAdapterOptions>;

  constructor(opts: HermesAdapterOptions = {}) {
    this._opts = {
      hermesHome: opts.hermesHome ?? path.join(homeDir(), '.hermes'),
    };
  }

  async scan(): Promise<EcosystemAsset[]> {
    const assets: EcosystemAsset[] = [];
    const roots: string[] = [];
    const hermesHome = this._opts.hermesHome;

    // ── Skills ───────────────────────────────────────────────
    const skillRoot = path.join(hermesHome, 'skills');
    if (dirExists(skillRoot)) {
      roots.push(skillRoot);
      for (const skillFile of findSkillFiles(skillRoot)) {
        const skillDir = path.dirname(skillFile);
        assets.push({
          kind: 'hermes',
          assetType: 'skill',
          name: path.basename(skillDir),
          displayName: path.basename(skillDir),
          sourcePath: skillFile,
          supportLevel: 'native',
          detail: 'Hermes skill (~/.hermes/skills)',
          payload: { content: readTextFile(skillFile) ?? '', skillDir },
        });
      }
    }

    // ── Config: MCP servers ──────────────────────────────────
    const configCandidates = [
      path.join(hermesHome, 'config.yaml'),
      path.join(hermesHome, 'config.yml'),
      path.join(hermesHome, 'settings.yaml'),
      path.join(hermesHome, 'settings.yml'),
    ];
    for (const configPath of configCandidates) {
      if (!fileExists(configPath)) continue;
      roots.push(configPath);
      const config = readYamlFile(configPath);
      if (!config) continue;
      const servers = config.mcp_servers as Record<string, Record<string, unknown>> | undefined;
      if (servers) {
        for (const [name, server] of Object.entries(servers)) {
          assets.push({
            kind: 'hermes',
            assetType: 'mcp',
            name,
            displayName: name,
            sourcePath: configPath,
            supportLevel: 'native',
            detail: 'MCP server from Hermes config',
            payload: { serverName: name, server },
          });
        }
      }
    }

    // ── Plugins (Python — detect only) ───────────────────────
    const pluginRoot = path.join(hermesHome, 'plugins');
    if (dirExists(pluginRoot)) {
      roots.push(pluginRoot);
      for (const manifest of findFilesNamed(pluginRoot, 'plugin.yaml', 3)) {
        const pluginDir = path.dirname(manifest);
        const parsed = readYamlFile(manifest) ?? {};
        const name = String(parsed.name ?? path.basename(pluginDir));
        assets.push({
          kind: 'hermes',
          assetType: 'plugin',
          name,
          displayName: name,
          sourcePath: manifest,
          supportLevel: 'unsupported',
          detail: 'Hermes plugins are Python; v1 detects them but does not execute',
          payload: { manifest: parsed, pluginDir },
        });
      }
    }

    this._roots = roots;
    return assets;
  }

  private _roots: string[] = [];
  roots(): string[] { return [...this._roots]; }
}
