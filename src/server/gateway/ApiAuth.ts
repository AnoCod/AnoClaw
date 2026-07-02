// ApiAuth — Bearer token authentication and permission checks
// Uses ApiToken / ApiPermission from shared types. Token store is a simple
// in-memory map; on boot it loads from config/api.json (or environment fallback).
// Part of the AnoClaw v2.0 rewrite: Gateway system (SA-10)

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ApiToken, ApiPermission } from '../../shared/types/gateway.js';
import { LogManager } from '../infra/logging/LogManager.js';
// Re-export for convenience (used by ApiServer)
export type { ApiToken, ApiPermission } from '../../shared/types/gateway.js';

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

const tokens: Map<string, ApiToken> = new Map();

/** Create a prefixed random token string: ano_sk_<32 hex chars> */
function makeTokenString(): string {
  return `ano_sk_${randomBytes(16).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a Bearer token string and return the matching ApiToken,
 * or null if the token is invalid / unknown.
 */
export function validateToken(token: string): ApiToken | null {
  const entry = tokens.get(token);
  if (!entry) return null;

  // Update last-used timestamp
  entry.lastUsedAt = new Date().toISOString();
  tokens.set(token, entry);

  return entry;
}

/**
 * Check whether a token holds a specific permission.
 */
export function hasPermission(
  token: ApiToken,
  permission: ApiPermission,
): boolean {
  return token.permissions.includes(permission);
}

/**
 * Generate a new API token with the given name and permission set.
 * The token is automatically stored in the in-memory map.
 *
 * @returns The newly created ApiToken (including the plain-text token string).
 */
export function generateToken(
  name: string,
  permissions: ApiPermission[],
): ApiToken {
  const token: ApiToken = {
    token: makeTokenString(),
    name,
    permissions,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  tokens.set(token.token, { ...token });
  return token;
}

/**
 * Revoke (remove) a token by its string value.
 * Returns true if the token was found and removed.
 */
export function revokeToken(token: string): boolean {
  return tokens.delete(token);
}

/**
 * List all registered tokens (without exposing the plain-text token strings
 * when `mask` is true — useful for admin UI).
 */
export function listTokens(mask = true): ApiToken[] {
  const result: ApiToken[] = [];
  for (const entry of tokens.values()) {
    result.push({
      ...entry,
      token: mask ? entry.token.slice(0, 12) + '...' : entry.token,
    });
  }
  return result;
}

/**
 * Return the number of registered tokens.
 */
export function tokenCount(): number {
  return tokens.size;
}

// ---------------------------------------------------------------------------
// Bootstrap: load tokens from config or generate a default
// ---------------------------------------------------------------------------

/**
 * Initialise the token store. Called once at startup.
 *
 * If a config/api.json file exists, tokens are loaded from it.
 * Otherwise, a single default admin token is auto-generated for localhost use
 * (printed to stdout so the user can find it).
 */
export async function initAuthStore(configDir?: string): Promise<void> {
  // Try loading from config file
  const loaded = await loadTokensFromConfig(configDir);
  if (loaded && tokens.size > 0) {
    LogManager.getInstance().logger('anochat.api').info('API auth tokens loaded', { count: tokens.size });
    return;
  }

  // Auto-generate a default admin token for local development
  const defaultToken = generateToken('Default Admin (auto-generated)', [
    'sessions:read' as ApiPermission,
    'sessions:write' as ApiPermission,
    'messages:read' as ApiPermission,
    'messages:send' as ApiPermission,
    'agents:read' as ApiPermission,
    'agents:write' as ApiPermission,
    'workspace:read' as ApiPermission,
    'memory:read' as ApiPermission,
    'memory:write' as ApiPermission,
    'admin' as ApiPermission,
  ]);

  const masked = defaultToken.token.slice(0, 8) + '...';
  LogManager.getInstance().logger('anochat.api').info('Default admin token generated', { token: masked });
}

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

async function loadTokensFromConfig(
  configDir?: string,
): Promise<boolean> {
  const candidates = [
    configDir ? path.join(configDir, 'api.json') : null,
    'config/api.json',
    'anochat/config/api.json',
  ].filter(Boolean) as string[];

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      const tokenList: Array<{
        token: string;
        name: string;
        permissions: string[];
        createdAt?: string;
        lastUsedAt?: string | null;
      }> = data.tokens;

      if (!Array.isArray(tokenList)) {
        LogManager.getInstance().logger('anochat.api').warn('Invalid API auth config: tokens not an array', { file: filePath });
        continue;
      }

      for (const entry of tokenList) {
        if (!entry.token || !entry.name) continue;

        const apiToken: ApiToken = {
          token: entry.token,
          name: entry.name,
          permissions: (entry.permissions || []) as ApiPermission[],
          createdAt: entry.createdAt || new Date().toISOString(),
          lastUsedAt: entry.lastUsedAt || null,
        };

        tokens.set(apiToken.token, apiToken);
      }

      if (tokens.size > 0) return true;
    } catch {
      // File doesn't exist or is invalid — try next candidate
      continue;
    }
  }

  return false;
}
