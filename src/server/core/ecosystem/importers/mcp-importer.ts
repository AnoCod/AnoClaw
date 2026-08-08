/**
 * MCP importer — normalizes MCP server configs from the five ecosystems into
 * the AnoClaw MCP plugin server shape.
 *
 * Canonical shape:
 *   {
 *     name, transport: 'stdio'|'sse'|'http',
 *     command?, args?, env?, cwd?, url?, headers?,
 *     enabled?, timeoutMs?, toolFilter?: { include?, exclude? },
 *     origin?: { kind, sourcePath, entryId }
 *   }
 */

import { resolvePlaceholders, expandHome } from '../placeholders.js';
import type { EcosystemKind } from '../types.js';

export interface McpServerConfig {
  name: string;
  transport?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeoutMs?: number;
  toolFilter?: { include?: string[]; exclude?: string[] };
  origin?: { kind: EcosystemKind; sourcePath: string; entryId: string };
}

export interface McpNormalizeResult {
  config: McpServerConfig;
  warnings: string[];
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapTransport(raw: unknown, hasUrl: boolean): 'stdio' | 'sse' | 'http' | undefined {
  const t = String(raw ?? '').toLowerCase();
  if (t === 'stdio' || t === 'local') return 'stdio';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http' || t === 'remote') return 'http';
  if (t === 'url') return hasUrl ? 'http' : undefined;
  if (t) return 'http'; // unknown transports fall back to HTTP when a URL exists
  return undefined;
}

function extractToolFilter(raw: unknown): { include?: string[]; exclude?: string[] } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const include = asStringArray(obj.include ?? obj.tools);
  const exclude = asStringArray(obj.exclude);
  if (!include && !exclude) return undefined;
  return { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
}

/**
 * Normalize one MCP server definition from any of the five ecosystems.
 */
export function normalizeMcpServer(
  kind: EcosystemKind,
  serverName: string,
  raw: Record<string, unknown>,
  opts: { entryId?: string; sourcePath?: string; env?: Record<string, string | undefined> } = {},
): McpNormalizeResult {
  const warnings: string[] = [];

  // ── Extract connection primitives ──────────────────────────
  const commandRaw = raw.command;
  const argsRaw = raw.args;
  let command: string | undefined;
  let args: string[] | undefined;

  if (Array.isArray(commandRaw)) {
    // OpenCode local: command: ["npx", "-y", "server"]
    const parts = (commandRaw as unknown[]).map(String);
    command = parts[0];
    args = parts.slice(1);
  } else if (typeof commandRaw === 'string') {
    command = commandRaw;
    args = asStringArray(argsRaw);
  } else {
    // Codex/Claude may put the executable in `command` as string; nothing else.
    warnings.push('No command or url found; server definition kept as-is');
  }

  const url = typeof raw.url === 'string' ? raw.url : undefined;
  const env = asStringRecord(raw.env ?? raw.environment);
  const headers = asStringRecord(raw.headers);
  const cwd = typeof raw.cwd === 'string' ? expandHome(raw.cwd) : undefined;

  // ── Transport mapping ──────────────────────────────────────
  const explicitType = raw.type ?? raw.transport;
  let transport = mapTransport(explicitType, Boolean(url));
  if (!transport) {
    transport = url ? 'http' : 'stdio';
  }
  if (transport === 'http' && !url && explicitType === 'streamable-http') {
    warnings.push('streamable-http transport requires a url; defaulting to stdio');
    transport = 'stdio';
  }

  // ── Timeouts ───────────────────────────────────────────────
  let timeoutMs: number | undefined;
  const timeoutRaw = raw.timeout ?? raw.requestTimeoutMs ?? raw.connectionTimeoutMs;
  if (typeof timeoutRaw === 'number' && timeoutRaw > 0) {
    // Hermes documents timeouts in seconds; OpenCode/OpenClaw in ms.
    timeoutMs = kind === 'hermes' ? timeoutRaw * 1000 : timeoutRaw;
  }

  const toolFilter = extractToolFilter(raw.toolFilter ?? raw.tools);
  if (raw.tools && !raw.toolFilter) {
    const tools = raw.tools as Record<string, unknown>;
    if (tools.resources === false) warnings.push('resources disabled flag not mapped in v1');
    if (tools.prompts === false) warnings.push('prompts disabled flag not mapped in v1');
  }

  // ── Resolve placeholders (env vars, context vars) ──────────
  const resolved = resolvePlaceholders(
    {
      command,
      args,
      env,
      headers,
      cwd,
      url,
    },
    { env: opts.env },
  );
  const values = resolved.value as {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    cwd?: string;
    url?: string;
  };
  for (const name of resolved.unresolved) {
    warnings.push(`unresolved environment placeholder: ${name}`);
  }

  const config: McpServerConfig = {
    name: serverName,
    transport,
    ...(values.command ? { command: values.command } : {}),
    ...(values.args && values.args.length > 0 ? { args: values.args } : {}),
    ...(values.env ? { env: values.env } : {}),
    ...(values.cwd ? { cwd: values.cwd } : {}),
    ...(values.url ? { url: values.url } : {}),
    ...(values.headers ? { headers: values.headers } : {}),
    ...(raw.enabled !== undefined ? { enabled: Boolean(raw.enabled) } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(toolFilter ? { toolFilter } : {}),
    ...(opts.entryId || opts.sourcePath
      ? {
          origin: {
            kind,
            sourcePath: opts.sourcePath ?? '',
            entryId: opts.entryId ?? '',
          },
        }
      : {}),
  };

  return { config, warnings };
}

/**
 * Read the standard MCP config shapes:
 *   - .mcp.json / plugin manifests: mcpServers or mcp_servers object
 *   - Codex config.toml: already parsed into mcp_servers object
 *   - OpenClaw openclaw.json: mcp.servers object
 *   - OpenCode opencode.json: mcp object
 *   - Hermes config: mcp_servers object (YAML)
 */
export function extractMcpEntries(
  raw: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  for (const key of ['mcpServers', 'mcp_servers']) {
    if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
      return raw[key] as Record<string, Record<string, unknown>>;
    }
  }
  if (raw.mcp && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp)) {
    const mcp = raw.mcp as Record<string, unknown>;
    if (mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers)) {
      return mcp.servers as Record<string, Record<string, unknown>>;
    }
    if (mcp && !mcp.servers) return mcp as Record<string, Record<string, unknown>>;
  }
  return {};
}
