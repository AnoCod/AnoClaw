/**
 * AnoClaw -- Gateway Types
 * External platform integration types: platform messages, message options,
 * API permissions, API tokens, and MCP server configuration.
 */

/** Normalized message received from or sent to an external platform. */
export interface PlatformMessage {
  platform: string;
  chatId: string;
  chatType: 'private' | 'group' | 'channel';
  senderId: string;
  senderName: string;
  content: string;
  mediaUrls: string[];
  timestamp: string;       // ISO8601
  messageId: string;       // platform-native message ID (dedup key)
}

/** Options for sending a message back to a platform. */
export interface MessageOptions {
  replyToMessageId?: string;
  parseMode?: 'text' | 'markdown' | 'html';
  disableNotification?: boolean;
}

/** Fine-grained API permission scopes for external API tokens. */
export enum ApiPermission {
  SessionsRead  = 'sessions:read',
  SessionsWrite = 'sessions:write',
  MessagesRead  = 'messages:read',
  MessagesSend  = 'messages:send',
  AgentsRead    = 'agents:read',
  AgentsWrite   = 'agents:write',
  WorkspaceRead = 'workspace:read',
  MemoryRead    = 'memory:read',
  MemoryWrite   = 'memory:write',
  Admin         = 'admin',
}

/** An API token with its associated permissions and usage metadata. */
export interface ApiToken {
  token: string;
  name: string;
  permissions: ApiPermission[];
  createdAt: string;
  lastUsedAt: string | null;
}

/** Configuration for an MCP (Model Context Protocol) server connection. */
export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'ws' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}
