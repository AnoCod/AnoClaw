import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decryptApiKey, encryptApiKey } from '../../agent/AgentConfig.js';
import { V3DomainError } from '../domain/DomainError.js';

export interface LocalLlmCredential {
  credentialRef: string;
  provider: string;
  apiUrl: string;
  model: string;
  contextWindow: number;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredLocalLlmCredential extends Omit<LocalLlmCredential, 'apiKey'> {
  schemaVersion: 3;
  encryptedApiKey: string;
}

/**
 * Small local secret store for the installation LLM connection.
 *
 * API keys never enter Company or Work event streams. The same per-install
 * AES-GCM key used by the runtime encrypts this dedicated credential file.
 */
export class LocalCredentialStore {
  constructor(
    private readonly filePath = path.resolve('config', 'credentials.v3.json'),
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async exists(): Promise<boolean> {
    try {
      await fsp.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async load(credentialRef = 'local-llm'): Promise<LocalLlmCredential | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, 'utf-8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    let stored: StoredLocalLlmCredential;
    try {
      stored = JSON.parse(raw) as StoredLocalLlmCredential;
    } catch {
      throw new V3DomainError('CORRUPT_EVENT_STREAM', 'Local v3 credential file is invalid JSON');
    }
    validateStored(stored);
    if (stored.credentialRef !== credentialRef) return null;
    return {
      credentialRef: stored.credentialRef,
      provider: stored.provider,
      apiUrl: stored.apiUrl,
      model: stored.model,
      contextWindow: stored.contextWindow,
      apiKey: decryptApiKey(stored.encryptedApiKey),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  async save(input: {
    credentialRef?: string;
    provider: string;
    apiUrl: string;
    model: string;
    contextWindow: number;
    apiKey: string;
  }): Promise<Omit<LocalLlmCredential, 'apiKey'>> {
    requireText(input.provider, 'provider');
    requireText(input.apiUrl, 'apiUrl');
    requireText(input.model, 'model');
    if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1_000) {
      throw new V3DomainError('INVALID_ARGUMENT', 'contextWindow must be an integer of at least 1000');
    }
    const credentialRef = input.credentialRef?.trim() || 'local-llm';
    const previous = await this.load(credentialRef).catch((error) => {
      if (error instanceof V3DomainError && error.code === 'NOT_FOUND') return null;
      throw error;
    });
    const now = this.clock();
    const stored: StoredLocalLlmCredential = {
      schemaVersion: 3,
      credentialRef,
      provider: input.provider.trim(),
      apiUrl: input.apiUrl.trim(),
      model: input.model.trim(),
      contextWindow: input.contextWindow,
      encryptedApiKey: encryptApiKey(input.apiKey),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await fsp.open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify(stored, null, 2), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, this.filePath);
    const { encryptedApiKey: _secret, schemaVersion: _version, ...metadata } = stored;
    return metadata;
  }
}

function validateStored(value: Partial<StoredLocalLlmCredential>): asserts value is StoredLocalLlmCredential {
  if (
    value.schemaVersion !== 3
    || typeof value.credentialRef !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.apiUrl !== 'string'
    || typeof value.model !== 'string'
    || !Number.isSafeInteger(value.contextWindow)
    || typeof value.encryptedApiKey !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    throw new V3DomainError('CORRUPT_EVENT_STREAM', 'Local v3 credential file has an invalid schema');
  }
}

function requireText(value: string, label: string): void {
  if (!value?.trim()) throw new V3DomainError('INVALID_ARGUMENT', `${label} is required`);
}

function isNodeError(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
