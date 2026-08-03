# src/server/gateway/handlers — API Handler Functions

## Overview

Imperative handler functions for HTTP API endpoints. These are called from `ApiServer`'s legacy if-else routing chain (the declarative routes in `routes/` are the newer approach). Handles sessions, agents, tools, system utilities, inline code suggestions, and read-only Workspace browsing/previews.

## Handler Catalog (24 endpoints)

### SessionHandlers

| Handler | Method | Path | WS Required | Description |
|---------|--------|------|-------------|-------------|
| `handleListSessions` | GET | `/api/v1/sessions` | No | List sessions (filters by `?status=` query param) |
| `handleCreateSession` | POST | `/api/v1/sessions` | Yes | Create main or sub-session (`{ agentId, title, parentSessionId }`) |
| `handleGetSession` | GET | `/api/v1/sessions/:id` | No | Get session details with metadata |
| `handleArchiveSession` | DELETE | `/api/v1/sessions/:id` | Yes | Archive session (soft-delete) |
| `handleClearAllSessions` | POST | `/api/v1/sessions/clear` | Yes | Remove all sessions from memory and disk |
| `handleRenameSession` | PATCH | `/api/v1/sessions/:id` | Yes | Rename session (`{ title }`) |
| `handleAutoTitle` | POST | `/api/v1/sessions/:id/auto-title` | Yes | Generate title via LLM (`{ message }`) |
| `handleSessionMessages` | GET | `/api/v1/sessions/:id/messages` | No | Get message history with token breakdown |
| `handleSendMessage` | POST | `/api/v1/sessions/:id/messages` | Yes* | Send message (dispatches to WebSocket handler) |
| `handleSessionToolStats` | GET | `/api/v1/sessions/:id/tool-stats` | No | Per-session tool timing stats |
| `handleGlobalToolStats` | GET | `/api/v1/tool-stats` | No | Global aggregate tool timing |
| `handleSearchSessions` | GET | `/api/v1/search` | No | Full-text search (`?q=`, `?scope=`, `?limit=`) |
| `handleGetOverview` | GET | `/api/v1/sessions/:id/overview` | No | Session summary (messages, tokens, tools, skills, memory refs) |

\* `handleSendMessage` requires WS connection for the session (returns 503 otherwise).

### AgentHandlers

| Handler | Method | Path | WS Required | Description |
|---------|--------|------|-------------|-------------|
| `handleListAgents` | GET | `/api/v1/agents` | No | List all agents |
| `handleGetAgent` | GET | `/api/v1/agents/:id` | No | Get agent by ID |
| `handleCreateAgent` | POST | `/api/v1/agents` | Yes | Create agent (merges with defaults) |
| `handleUpdateAgent` | PATCH | `/api/v1/agents/:id` | Yes | Update agent config (masks apiKey preservation) |
| `handleDeleteAgent` | DELETE | `/api/v1/agents/:id` | Yes | Delete agent (optional `?cascade=true`) |
| `handleAgentStatus` | GET | `/api/v1/agents/:id/status` | No | Get agent runtime status + session map |

### ToolHandlers

| Handler | Method | Path | Description |
|---------|--------|------|-------------|
| `handleListTools` | GET | `/api/v1/tools` | All tools with metadata and groups |
| `handleToolExecute` | POST | `/api/v1/tools/execute` | Execute tool (`{ toolName, params, sessionId? }`) |
| `handleListCommands` | GET | `/api/v1/commands` | All slash command definitions |

### SystemHandlers

| Handler | Method | Path | Description |
|---------|--------|------|-------------|
| `handleHealth` | GET | `/api/v1/health` | Health check (`status`, `version`, `uptime`) |
| `handleStats` | GET | `/api/v1/stats` | Agent/session/runtime stats + memory usage |
| `handleGetLogEntries` | GET | `/api/v1/logs` | Log entries (`?count=`, `?category=`) |
| `handleOpenFile` | POST | `/api/v1/system/open-file` | Open file in OS file manager (`{ path }`) |

### InlineSuggestHandler

| Handler | Method | Path | Description |
|---------|--------|------|-------------|
| `handleInlineSuggest` | POST | `/api/v1/inline-suggest` | Monaco inline code completion via LLM (`{ prefix, suffix, language, sessionId? }`) |

### WorkspaceHandlers

| Handler | Method | Path | WS Required | Description |
|---------|--------|------|-------------|-------------|
| `handleBrowseWorkspace` | GET | `/api/v1/workspace/browse` | No | Browse directory (`?path=`, `?sessionId=`) |
| `handleReadWorkspaceFile` | GET | `/api/v1/workspace/read` | No | Read/stream file; text preview is capped at 1 MiB and reports encoding/truncation |
| `handleCreateWorkspaceDir` | POST | `/api/v1/workspace/create-dir` | No | Disabled compatibility route: always HTTP 405 `WORKSPACE_READ_ONLY` |
| `handleCreateWorkspaceFile` | POST | `/api/v1/workspace/create-file` | No | Disabled compatibility route: always HTTP 405 `WORKSPACE_READ_ONLY` |
| `handleWriteWorkspaceFile` | PUT | `/api/v1/workspace/write` | No | Disabled compatibility route: always HTTP 405 `WORKSPACE_READ_ONLY` |
| `handleDeleteWorkspaceFile` | DELETE | `/api/v1/workspace/file` | No | Disabled compatibility route: always HTTP 405 `WORKSPACE_READ_ONLY` |
| `handleRenameWorkspaceFile` | PATCH | `/api/v1/workspace/rename` | No | Disabled compatibility route: always HTTP 405 `WORKSPACE_READ_ONLY` |
| `handleMoveWorkspaceFile` | POST | `/api/v1/workspace/move` | No | Disabled compatibility route: always HTTP 405 `WORKSPACE_READ_ONLY` |
| `handleBindWorkspace` | PATCH | `/api/v1/sessions/:id/bind-workspace` | Yes | Bind an existing directory; never creates one |
| `handleGetWorkspace` | GET | `/api/v1/sessions/:id/workspace` | No | Get session workspace path |
| `handleConvertOffice` | GET | `/api/v1/workspace/convert-office` | No | Read-only DOCX/workbook/slides/OpenDocument conversion |
| `handleInspectWorkspaceArchive` | GET | `/api/v1/workspace/inspect-archive` | No | Safely list ZIP-family entries without extracting to disk |
| `handlePreviewWorkspacePsd` | GET | `/api/v1/workspace/preview-psd` | No | Return an embedded thumbnail or safely decoded flattened PSD/PSB composite; skips layer data without parsing it |

---

## Handler Signature Convention

All handlers receive utility functions. The common pattern:

```ts
function handlerName(
  req: IncomingMessage,     // HTTP request
  res: ServerResponse,      // HTTP response
  sendJson: SendJson,       // (res, status, data) => void
  readBody?: ReadBody       // (req) => Promise<Record> (POST/PATCH/PUT only)
): void | Promise<void>;
```

Session-specific handlers receive `sessionId` as the first parameter (extracted from `:id` path segment). Some handlers receive `host` and `port` for URL construction.

---

## Dependencies

```
SessionHandlers  → SessionManager, SessionStore, AgentRegistry, AgentRuntime,
                   WsServer, TypedEventBus, ToolProfiler, MemoryManager, TokenCounter
AgentHandlers    → AgentRegistry, AgentConfig, TypedEventBus, WsRequired
ToolHandlers     → ToolRegistry, CommandRegistry, SessionManager
SystemHandlers   → AgentRuntime, AgentRegistry, SessionManager, LogManager
InlineSuggestHandler → createLLMProvider, AgentRegistry, SessionManager
WorkspaceHandlers → SessionManager, WsRequired, fs/promises, zlib, WorkspacePsdPreview
```

## Usage

None — handlers are called exclusively by `ApiServer.route()`. New functionality should use declarative `RouteHandler` classes in `routes/` instead.
