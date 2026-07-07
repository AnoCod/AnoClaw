// PluginRPC.ts — Shared RPC protocol types for Main ↔ PluginHost communication
// Bidirectional JSON messaging over MessageChannel.
// Requests: { id, method, params }
// Responses: { id, result } or { id, error: { code, message } }

export interface RPCCallbacks {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

import * as crypto from 'crypto';
import type { CapabilityDefinition } from '../../../shared/types/capability.js';

/** Generate a short unique ID for RPC requests */
export function generateRPCLabel(method: string, pluginName: string): string {
  return `${pluginName}:${method}:${crypto.randomUUID().slice(0, 8)}`;
}

/** Plugin manifest schema */
export interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  publisher?: string;
  main: string;
  activationEvents: string[];
  contributes?: {
    tools?: Array<{ name?: string }>;
    capabilities?: CapabilityDefinition[];
    pages?: Array<{ id: string; title: string; icon?: string; order?: number; html?: string }>;
    skills?: string[];
    commands?: Array<{ id: string; label: string }>;
    configuration?: {
      title?: string;
      properties: Record<string, { type: string; default?: unknown; description?: string }>;
    };
    apiRoutes?: Array<{ method: string; path: string }>;
    overrides?: Record<string, string | null>;
  };
  engines?: {
    anoclaw: string;
  };
}

/** Registered plugin state */
export interface PluginState {
  manifest: PluginManifest;
  /** Absolute path to plugin directory */
  pluginPath: string;
  status: 'loaded' | 'activated' | 'error';
  errorMessage?: string;
  activatedAt?: string;
}

export interface PluginListItem {
  name: string;
  displayName: string;
  version: string;
  publisher?: string;
  description?: string;
  status: string;
  errorMessage?: string;
  contributes?: PluginManifest['contributes'];
}

// ── Extended Plugin API types ──

export interface PluginLLMMessage {
  role: string;
  content: string;
}

export interface PluginLLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface PluginLLMResponse {
  content: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface PluginGrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface PluginMemorySaveInput {
  name: string;
  type: string;
  description: string;
  content: string;
  scope: string;
  sessionId?: string;
  subScope?: 'team' | 'personal';
}

export interface PluginMemorySearchOptions {
  scope?: string;
  agentId?: string;
  sessionId?: string;
  subScope?: 'team' | 'personal';
  limit?: number;
  fuzzy?: boolean;
}

export interface PluginEventMessage {
  method: 'event';
  params: { event: string; data: unknown };
}
