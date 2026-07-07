// AnoClaw Frontend — Shared Types
//
// NOTE: Some types have counterparts in src/shared/types/. The shared types
// are the canonical definitions used by the server. The frontend keeps its own
// copies because the frontend tsconfig (rootDir: "ts") prevents importing from
// outside src/public/ts/.  Keep the following in sync manually:
//   - AgentRole  (shared: enum AgentRole in agent.ts)
//   - AgentConfig (shared: AgentConfig in agent.ts, minus apiKey)
//   - SessionNode (shared: SessionNode in session.ts)
//   - TokenBreakdown (shared: TokenBreakdown in session.ts)
//   - TodoItem (shared: none — frontend-only)

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageType =
  | 'message'
  | 'think'
  | 'tool_call'
  | 'tool_result'
  | 'todo_write'
  | 'plan_enter'
  | 'plan_exit'
  | 'error'
  | 'delegation_activity'
  | 'task_notification'
  | 'status';

export type MessageStatus = 'pending' | 'success' | 'error';

/**
 * Frontend display message — discriminated union by `type`.
 * This is fundamentally different from the backend Message (which batches
 * toolCalls/toolResults/thinking into a single object). The frontend
 * renders each event as a separate card in the timeline.
 */
export interface Message {
  id: string;
  sessionId?: string;
  type: MessageType;
  role?: MessageRole;
  content: string;
  timestamp: number;
  agentId?: string;
  agentName?: string;
  // Tool call specific
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  status?: MessageStatus;
  // Think specific
  durationMs?: number;
  // Todo specific
  todos?: TodoItem[];
  // Plan specific
  planTitle?: string;
  // Delegation activity specific
  subAgentId?: string;
  subSessionId?: string;
  // Task notification specific
  taskId?: string;
  parentSessionId?: string;
  parentAgentId?: string;
  taskStatus?: string;
  taskSummary?: string;
  taskResult?: string;
}

/** Alias for clarity — the frontend display message type. */
export type FrontendMessage = Message;

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** Frontend session status — UI states derived from shared SessionStatus enum + runtime states.
 *  'Active', 'Idle', 'Archived' match the shared SessionStatus enum (PascalCase).
 *  'working', 'paused', etc. are runtime-only UI states local to the frontend. */
export type SessionStatus = 'Active' | 'Idle' | 'Archived' | 'working' | 'paused' | 'error' | 'started' | 'tool_executing';

/**
 * Frontend session tree node.
 * Mirrors shared SessionNode (session.ts) but adds UI-specific fields:
 * parentId, children[], agentName, canWrite, isMain.
 * Uses 'id' instead of shared's 'sessionId'.
 */
export interface SessionNode {
  id: string;
  title: string;
  parentId: string | null;
  parentSessionId?: string | null;
  agentId?: string;
  agentName?: string;
  status: SessionStatus;
  lastActiveAt?: string;
  createdAt?: string;
  level?: number;
  type?: 'Main' | 'Sub';
  children: SessionNode[];
  workspace?: string;
  canWrite?: boolean;
  isMain?: boolean;
  subSessionIds?: string[];
  metadata?: Record<string, unknown>;
}

/** Agent role — matches shared enum AgentRole in agent.ts */
export type AgentRole = 'MainAgent' | 'Manager' | 'Member' | 'SubAgent';

/**
 * Frontend AgentConfig — mirrors shared AgentConfig (agent.ts) but WITHOUT apiKey.
 * apiKey is intentionally excluded from the frontend type for security.
 * When creating/updating agents, pass apiKey separately via the API.
 */
export interface AgentConfig {
  id: string; name: string; role: AgentRole;
  parentAgentId: string | null;
  provider: string; apiUrl: string;
  model: string; contextWindow: number;
  preferredLanguage: 'zh' | 'en'; conversationLanguage: 'zh' | 'en';
  agentPrompt: string;
  allowedTools: string[]; enabledSkills: string[];
  // Server-side fields (not directly managed by frontend, but may be passed during editing)
  apiKey?: string; level?: number; teamName?: string;
  mcpServers?: string[]; state?: string; createdAt?: string;
  maxTurns?: number; temperature?: number;
}

/**
 * Frontend token breakdown — mirrors shared TokenBreakdown but adds contextWindow.
 * The shared type has 'freeSpace' instead.
 */
export interface TokenBreakdown {
  systemPrompt: number; systemTools: number; skills: number;
  messages: number; total: number; contextWindow: number;
  freeSpace?: number;
}

export type ArtifactKind =
  | 'presentation'
  | 'document'
  | 'spreadsheet'
  | 'pdf'
  | 'image'
  | 'web_report'
  | 'table_analysis'
  | 'mindmap'
  | 'automation_result'
  | 'other';

export type ArtifactStatus =
  | 'draft'
  | 'working'
  | 'ready'
  | 'done'
  | 'failed'
  | 'archived';

export type ArtifactPreviewType =
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'table'
  | 'json';

export interface ArtifactFile {
  path: string;
  label?: string;
  mimeType?: string;
  sizeBytes?: number;
  role?: 'primary' | 'preview' | 'source' | 'export' | 'attachment';
}

export interface ArtifactPreview {
  type: ArtifactPreviewType;
  content?: string;
  path?: string;
  mimeType?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  createdAt: string;
  title?: string;
  summary?: string;
  filePaths: string[];
  preview?: ArtifactPreview;
  metadata?: Record<string, unknown>;
}

export interface ArtifactRecord {
  id: string;
  sessionId: string;
  title: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
  capabilityId?: string;
  taskId?: string;
  description?: string;
  files: ArtifactFile[];
  preview?: ArtifactPreview;
  versions: ArtifactVersion[];
  metadata: Record<string, unknown>;
  error?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileEntry[];
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
}

export interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  team: string;
  type: string;
  scope: string;
  agentId: string;
  updatedAt: number;
}

export interface MCPServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable';
  command?: string;
  url?: string;
  connected: boolean;
  toolCount: number;
}

export interface GatewayConnection {
  id: string;
  platform: 'telegram' | 'wechat' | 'feishu';
  name: string;
  connected: boolean;
  config: Record<string, string>;
}

export interface Page {
  name: string;
  container: HTMLElement;
  onEnter(): void;
  onExit(): void;
}

export interface AppSettings {
  lang: 'zh' | 'en';
  showThinkCards: boolean;
  showToolCards: boolean;
  theme: 'dark' | 'light';
  accentColor: string;
  compactionThreshold: number;
}

// ── Plugin system types ──

export interface PluginInfo {
  name: string;
  displayName: string;
  version: string;
  publisher?: string;
  description?: string;
  status: 'loaded' | 'activated' | 'error';
  errorMessage?: string;
  contributes?: {
    pages?: Array<{ id: string; title: string; icon?: string; order?: number; html?: string }>;
    tools?: Array<{ name?: string }>;
    commands?: Array<{ id: string; label: string }>;
    skills?: string[];
  };
}

export interface PluginPageContribution {
  id: string;
  title: string;
  icon?: string;
  order?: number;
  pluginName: string;
  htmlPath: string;
}

// ── Slash commands (mirrors shared types/command.ts) ──

export interface CommandArg {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'boolean' | 'number';
}

export interface CommandDefinition {
  name: string;
  displayName: string;
  description: string;
  category: 'session' | 'project' | 'workspace' | 'help';
  args?: CommandArg[];
}

// ── Stream event types — mirrors src/shared/types/stream-events.ts ──
// Frontend keeps its own copy because tsconfig (rootDir: "ts") prevents
// importing from src/shared/. These type the WebSocket event dispatch.

export type StreamEventType =
  | 'think' | 'text' | 'tool_call' | 'tool_result' | 'done' | 'error'
  | 'plan_enter' | 'plan_exit' | 'todo_write'
  | 'delegation_progress' | 'delegation_status'
  | 'status' | 'sleep' | 'wake'
  | 'command_result' | 'subsession_created'
  | 'session_created' | 'message_appended' | 'workspace_changed'
  | 'tool_execution_started' | 'tool_execution_completed'
  | 'loop_completed' | 'compaction_triggered'
  | 'quality_score_ack' | 'quality_score_error'
  | 'task_notification'
  | 'task_list_update';

// ── Talent Pool types (frontend copy) ──

export interface TalentPoolGroup {
  id: string;
  name: string;
  icon: string;
  order: number;
  description: string;
}

export type TalentPoolSource = 'builtin' | 'custom' | 'github';

export interface TalentPoolTemplate {
  id: string;
  groupId: string;
  name: string;
  description: string;
  role: 'Manager' | 'Member';
  model: string;
  provider: string;
  agentPrompt: string;
  preferredLanguage: string;
  conversationLanguage: string;
  allowedTools: string[];
  enabledSkills: string[];
  tags: string[];
  source: TalentPoolSource;
  sourceUrl?: string;
  icon: string;
  starRating: number;
  createdAt: string;
  updatedAt: string;
}
