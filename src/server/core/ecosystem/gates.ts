/**
 * Load-time eligibility gates for imported skills.
 *
 * OpenClaw: metadata.openclaw.requires.{os,bins,anyBins,env,config}
 * Hermes:   platforms, requires_toolsets, requires_tools,
 *           fallback_for_toolsets, fallback_for_tools
 */

import { spawnSync } from 'node:child_process';
import type { EcosystemKind } from './types.js';

export interface GateContext {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** openclaw.json-style config bag (usually empty in AnoClaw). */
  config?: Record<string, unknown>;
  /** Available AnoClaw tool names (for Hermes requires_tools gates). */
  tools?: Set<string>;
  /** Available AnoClaw toolset names (for Hermes requires_toolsets gates). */
  toolsets?: Set<string>;
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

function commandExists(bin: string): boolean {
  try {
    const probe = process.platform === 'win32'
      ? spawnSync('where', [bin], { stdio: 'ignore' })
      : spawnSync('which', [bin], { stdio: 'ignore' });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function truthyPath(config: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.').filter(Boolean);
  let node: unknown = config;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return false;
    }
  }
  return Boolean(node);
}

function platformMatches(platform: string | undefined, candidates: unknown[]): boolean {
  const current = platform ?? process.platform;
  return candidates.some((c) => {
    const p = String(c).toLowerCase();
    if (p === 'win32' || p === 'windows') return current === 'win32';
    if (p === 'darwin' || p === 'macos') return current === 'darwin';
    if (p === 'linux') return current === 'linux';
    return p === current;
  });
}

/**
 * Evaluate skill frontmatter gates. Unknown ecosystems have no load-time gates.
 */
export function evaluateSkillGates(
  kind: EcosystemKind,
  frontmatter: Record<string, unknown>,
  ctx: GateContext = {},
): GateResult {
  const env = ctx.env ?? process.env as Record<string, string | undefined>;
  const config = ctx.config ?? {};
  const reasons: string[] = [];

  if (kind === 'openclaw') {
    const metadata = frontmatter.metadata as Record<string, unknown> | undefined;
    const oc = metadata?.openclaw as Record<string, unknown> | undefined;
    if (oc && typeof oc === 'object') {
      const requires = oc.requires as Record<string, unknown> | undefined;
      if (requires && typeof requires === 'object') {
        if (Array.isArray(requires.os) && !platformMatches(ctx.platform, requires.os)) {
          reasons.push(`OS not in [${(requires.os as unknown[]).join(', ')}]`);
        }
        if (Array.isArray(requires.bins)) {
          const missing = (requires.bins as string[]).filter((b) => !commandExists(b));
          if (missing.length > 0) reasons.push(`missing binaries: ${missing.join(', ')}`);
        }
        if (Array.isArray(requires.anyBins)) {
          const bins = requires.anyBins as string[];
          if (!bins.some((b) => commandExists(b))) reasons.push(`none of binaries present: ${bins.join(', ')}`);
        }
        if (Array.isArray(requires.env)) {
          const missing = (requires.env as string[]).filter((name) => !env[name]);
          if (missing.length > 0) reasons.push(`missing env vars: ${missing.join(', ')}`);
        }
        if (Array.isArray(requires.config)) {
          const missing = (requires.config as string[]).filter((p) => !truthyPath(config, p));
          if (missing.length > 0) reasons.push(`missing config paths: ${missing.join(', ')}`);
        }
      }
      if (oc.always === true) return { ok: true, reasons: [] };
    }
  }

  if (kind === 'hermes') {
    if (Array.isArray(frontmatter.platforms) && !platformMatches(ctx.platform, frontmatter.platforms)) {
      reasons.push(`platforms not in [${(frontmatter.platforms as unknown[]).join(', ')}]`);
    }
    const metadata = frontmatter.metadata as Record<string, unknown> | undefined;
    const hermes = metadata?.hermes as Record<string, unknown> | undefined;
    if (hermes && typeof hermes === 'object') {
      if (Array.isArray(hermes.requires_toolsets)) {
        const missing = (hermes.requires_toolsets as string[]).filter((ts) => !(ctx.toolsets ?? new Set()).has(ts));
        if (missing.length > 0) reasons.push(`requires toolsets: ${missing.join(', ')}`);
      }
      if (Array.isArray(hermes.requires_tools)) {
        const missing = (hermes.requires_tools as string[]).filter((t) => !(ctx.tools ?? new Set()).has(t));
        if (missing.length > 0) reasons.push(`requires tools: ${missing.join(', ')}`);
      }
      if (Array.isArray(hermes.fallback_for_toolsets)) {
        const present = (hermes.fallback_for_toolsets as string[]).filter((ts) => (ctx.toolsets ?? new Set()).has(ts));
        if (present.length > 0) reasons.push(`hidden when toolsets present: ${present.join(', ')}`);
      }
      if (Array.isArray(hermes.fallback_for_tools)) {
        const present = (hermes.fallback_for_tools as string[]).filter((t) => (ctx.tools ?? new Set()).has(t));
        if (present.length > 0) reasons.push(`hidden when tools present: ${present.join(', ')}`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
