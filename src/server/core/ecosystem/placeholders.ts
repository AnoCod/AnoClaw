/**
 * Placeholder resolution for imported MCP/config values.
 *
 * Supports the common syntaxes across the five ecosystems:
 *   ${env:VAR}   (Claude / Cursor / Hermes)
 *   ${VAR}       (Hermes / generic env)
 *   {env:VAR}    (OpenClaw JSON5 config)
 *   ${userHome} / ${workspaceFolder} / ${workspaceFolderBasename} /
 *   ${pathSeparator} / ${/}          (Cursor-style context variables used by Hermes)
 *
 * Missing variables keep their literal placeholder so the failure is visible,
 * and are reported through `unresolved`.
 */

import * as path from 'path';

export interface PlaceholderContext {
  env?: Record<string, string | undefined>;
  userHome?: string;
  workspaceFolder?: string;
}

export interface ResolveResult {
  value: unknown;
  unresolved: string[];
}

const ENV_PATTERN =
  /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

const CONTEXT_PATTERN = /\$\{(userHome|workspaceFolder|workspaceFolderBasename|pathSeparator|\/)\}/g;

export function resolvePlaceholders(
  value: unknown,
  ctx: PlaceholderContext = {},
): ResolveResult {
  const unresolved = new Set<string>();
  const env = ctx.env ?? process.env as Record<string, string | undefined>;
  const userHome = ctx.userHome ?? (process.env.USERPROFILE || process.env.HOME || '');
  const workspaceFolder = ctx.workspaceFolder ?? process.cwd();
  const pathSeparator = process.platform === 'win32' ? '\\' : '/';

  const resolveString = (input: string): string => {
    let output = input.replace(ENV_PATTERN, (_m, a?: string, b?: string, c?: string) => {
      const name = a ?? b ?? c ?? '';
      const val = env[name];
      if (val !== undefined && val !== '') return val;
      unresolved.add(name);
      return _m;
    });
    output = output.replace(CONTEXT_PATTERN, (_m, key: string) => {
      switch (key) {
        case 'userHome': return userHome;
        case 'workspaceFolder': return workspaceFolder;
        case 'workspaceFolderBasename': return workspaceFolder.split(/[\\/]/).filter(Boolean).pop() || workspaceFolder;
        case 'pathSeparator': return pathSeparator;
        case '/': return pathSeparator;
        default: return _m;
      }
    });
    return output;
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return resolveString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  return { value: walk(value), unresolved: [...unresolved] };
}

/** Expand a leading `~` to the user home directory. */
export function expandHome(input: string): string {
  if (!input || input === '~') return input;
  if (!input.startsWith('~/') && !input.startsWith('~\\')) return input;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return home ? path.join(home, input.slice(2)) : input;
}

/**
 * Substitute skill-directory/plugin-root path variables found in imported
 * SKILL.md bodies so instructions keep working after live-mounting.
 */
export function substituteSkillPathVars(
  content: string,
  vars: { skillDir?: string; pluginRoot?: string; pluginData?: string } = {},
): string {
  let out = content;
  if (vars.skillDir) {
    out = out.replace(/\$\{CLAUDE_SKILL_DIR\}/g, vars.skillDir);
    out = out.replace(/\{baseDir\}/g, vars.skillDir);
  }
  if (vars.pluginRoot) {
    out = out.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, vars.pluginRoot);
    out = out.replace(/\$\{PLUGIN_ROOT\}/g, vars.pluginRoot);
  }
  if (vars.pluginData) {
    out = out.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, vars.pluginData);
    out = out.replace(/\$\{PLUGIN_DATA\}/g, vars.pluginData);
  }
  return out;
}
