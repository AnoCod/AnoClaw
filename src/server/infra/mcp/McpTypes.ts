/**
 * Native MCP (Model Context Protocol) — shared types.
 * MCP is a kernel feature since v2.1: configs live in data/mcp-servers.json,
 * tools are registered directly into ToolRegistry, and the plugin-based
 * implementation (plugins/anoclaw-mcp) is retired.
 */

export interface McpOrigin {
  kind: string;
  sourcePath: string;
  entryId: string;
}

export interface McpServerConfig {
  id?: string;
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
  toolFilter?: { include?: string[]; exclude?: string[]; resources?: boolean; prompts?: boolean };
  origin?: McpOrigin;
}

export interface McpServerState {
  id: string;
  name: string;
  transport: string;
  command?: string;
  url?: string;
  connected: boolean;
  connecting: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  serverInfo?: { name?: string; version?: string } | null;
  capabilities?: Record<string, unknown> | null;
  error?: string;
}

export interface McpLogEntry {
  level: 'info' | 'warn' | 'error';
  server: string;
  message: string;
  timestamp: number;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpServersFile {
  version: 1;
  updatedAt: string;
  servers: McpServerConfig[];
}
