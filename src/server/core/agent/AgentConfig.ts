// AgentConfig — validation, defaults, and persistence for Agent configurations
// Loads from / saves to data/agents/{id}.json
// apiKey is encrypted at rest using AES-256-GCM

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AgentConfig } from '../../../shared/types/agent.js';
import { AgentRole, AgentState } from '../../../shared/types/agent.js';
import { DEFAULT_CONTEXT_WINDOW, PATHS } from '../../../shared/constants.js';

/** Server-internal AgentConfig that includes the apiKey field for LLM calls. */
export interface AgentConfigWithKey extends AgentConfig {
  apiKey: string;
}

function randomUUID(): string {
  // crypto.randomUUID() is available in Node 19+, fallback for older
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: 32 hex chars
  const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}

// ── API key encryption ──
const ENC_PREFIX = 'enc:';
const ENCRYPTION_KEY_PATH = 'config/.encryption-key';
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let _encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (_encryptionKey) return _encryptionKey;

  // 1. Check environment variable
  const envKey = process.env.ANOCHAT_ENCRYPTION_KEY;
  if (envKey && envKey.length >= 32) {
    _encryptionKey = Buffer.from(envKey.slice(0, 32), 'utf-8');
    return _encryptionKey;
  }

  // 2. Load from key file
  const keyPath = path.resolve(process.cwd(), ENCRYPTION_KEY_PATH);
  try {
    const keyB64 = fs.readFileSync(keyPath, 'utf-8').trim();
    if (keyB64.length >= 32) {
      _encryptionKey = Buffer.from(keyB64, 'base64');
      return _encryptionKey;
    }
  } catch { /* file doesn't exist yet */ }

  // 3. Generate new key and persist
  _encryptionKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, _encryptionKey.toString('base64'), 'utf-8');
  return _encryptionKey;
}

export function encryptApiKey(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, encrypted, tag]).toString('base64');
}

export function decryptApiKey(value: string): string {
  if (!value) return value;
  // Backward compat: plaintext keys pass through
  if (!value.startsWith(ENC_PREFIX)) return value;
  try {
    const key = getEncryptionKey();
    const data = Buffer.from(value.slice(ENC_PREFIX.length), 'base64');
    const iv = data.subarray(0, IV_LEN);
    const tag = data.subarray(data.length - TAG_LEN);
    const encrypted = data.subarray(IV_LEN, data.length - TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf-8');
  } catch {
    // If decryption fails (wrong key, corrupted data), throw so the problem is visible
    throw new Error(
      'API key decryption failed. The encryption key may have changed.\n' +
      'Run: node -e "const c=require(\'./src/server/core/agent/AgentConfig.js\'); console.log(c.encryptApiKey(\'sk-your-key\'))"\n' +
      'Then update the apiKey field in the agent config.'
    );
  }
}

const VALID_ROLES = new Set<string>(Object.values(AgentRole));
const VALID_STATES = new Set<string>(Object.values(AgentState));

export function defaultConfig(overrides: Partial<AgentConfigWithKey> = {}): AgentConfigWithKey {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'New Agent',
    role: overrides.role ?? AgentRole.Member,
    parentAgentId: overrides.parentAgentId ?? null,
    level: overrides.level ?? 2,
    teamName: overrides.teamName ?? '',
    provider: overrides.provider ?? 'cloud_api',
    apiUrl: overrides.apiUrl ?? '',
    apiKey: overrides.apiKey ?? '',
    model: overrides.model ?? '',
    contextWindow: overrides.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTurns: overrides.maxTurns ?? 0,
    temperature: overrides.temperature ?? 0.7,
    agentPrompt: overrides.agentPrompt ?? '',
    preferredLanguage: overrides.preferredLanguage ?? 'en',
    conversationLanguage: overrides.conversationLanguage ?? 'en',
    allowedTools: overrides.allowedTools ?? [],
    enabledSkills: overrides.enabledSkills ?? [],
    mcpServers: overrides.mcpServers ?? [],
    state: overrides.state ?? AgentState.Active,
    createdAt: overrides.createdAt ?? now,
  };
}

export function validateConfig(config: Partial<AgentConfigWithKey>): { valid: boolean; errors: string[]; config?: AgentConfigWithKey } {
  const errors: string[] = [];

  if (!config.id || typeof config.id !== 'string') {
    errors.push('id is required and must be a non-empty string');
  }
  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required and must be a non-empty string');
  }
  if (config.role && !VALID_ROLES.has(config.role)) {
    errors.push(`role must be one of: ${Object.values(AgentRole).join(', ')}`);
  }
  if (config.level != null && (typeof config.level !== 'number' || config.level < 0 || config.level > 3)) {
    errors.push('level must be a number between 0 and 3');
  }
  if (config.provider && typeof config.provider !== 'string') {
    errors.push('provider must be a string');
  }
  if (config.model && typeof config.model !== 'string') {
    errors.push('model must be a string');
  }
  if (config.contextWindow != null && (typeof config.contextWindow !== 'number' || config.contextWindow < 1000)) {
    errors.push('contextWindow must be a number >= 1000');
  }
  if (config.maxTurns != null && (typeof config.maxTurns !== 'number' || config.maxTurns < 0 || !Number.isInteger(config.maxTurns))) {
    errors.push('maxTurns must be a non-negative integer (0 = unlimited)');
  }
  if (config.temperature != null && (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2)) {
    errors.push('temperature must be a number between 0 and 2');
  }
  if (config.state && !VALID_STATES.has(config.state)) {
    errors.push(`state must be one of: ${Object.values(AgentState).join(', ')}`);
  }
  if (config.preferredLanguage && !['zh', 'en'].includes(config.preferredLanguage)) {
    errors.push('preferredLanguage must be "zh" or "en"');
  }
  if (config.conversationLanguage && !['zh', 'en'].includes(config.conversationLanguage)) {
    errors.push('conversationLanguage must be "zh" or "en"');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const merged = defaultConfig(config);
  return { valid: true, errors: [], config: merged };
}

function agentFilePath(agentId: string): string {
  // Use path relative to project root
  return path.resolve(process.cwd(), PATHS.agents, `${agentId}.json`);
}

export async function loadAgentConfig(agentId: string): Promise<AgentConfigWithKey> {
  const filePath = agentFilePath(agentId);
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    // Resolve ${ENV_VAR} placeholders
    const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
    const parsed = JSON.parse(resolved);
    const result = validateConfig(parsed);
    if (!result.valid || !result.config) {
      throw new Error(`Invalid agent config for ${agentId}: ${result.errors.join('; ')}`);
    }
    // Decrypt apiKey at load time
    result.config.apiKey = decryptApiKey(result.config.apiKey);
    return result.config;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      throw new Error(`Agent config not found: ${agentId}`);
    }
    throw err;
  }
}

export async function saveAgentConfig(config: AgentConfigWithKey): Promise<void> {
  // Validate before saving
  const result = validateConfig(config);
  if (!result.valid) {
    throw new Error(`Cannot save invalid agent config: ${result.errors.join('; ')}`);
  }

  const filePath = agentFilePath(config.id);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  // Encrypt apiKey before persisting
  const safeConfig = { ...config, apiKey: encryptApiKey(config.apiKey) };

  // Write atomically: write to temp file then rename
  const tmpPath = filePath + '.tmp';
  await fs.promises.writeFile(tmpPath, JSON.stringify(safeConfig, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}
