# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Codex Source of Truth

AnoClaw is now developed with Codex. `AGENTS.md` is the canonical repository instruction file for AI coding work. Do not create or maintain Claude Code instruction files (`CLAUDE.md` / `CLAUDE.*.md`); migrate any still-useful guidance into this file or task-specific docs under `docs/`.
`DESIGN.md` is retired and must not be recreated or maintained. Project, architecture, product, and design guidance belongs in `AGENTS.md` or focused docs under `docs/`.

## Project Overview

AnoClaw 3.0 is a local-first autonomous AI company. Most users talk only to
MainAgent; persistent Teams and independent Agents organize, delegate, execute,
verify, remember, and communicate behind that simple surface. The transparent
Work view exposes real Agent conversations and execution evidence without
making users operate the orchestration machinery.

The Electron application uses a browser SPA and a single-threaded Node.js
HTTP+WebSocket server. There is no Express or database. Version 3 uses
append-only JSONL event streams under `data/v3/` and does not import or
dual-write v2 organization/task/session state. See
`docs/anoclaw-3-architecture.md` for the canonical product and execution
invariants.

## Commands

```bash
# Install dependencies (use npm, not pnpm — this project uses package-lock.json)
npm install

# Build TypeScript (both server and frontend)
npm run build

# Build frontend TypeScript only
npm run build:frontend

# Full build (server + frontend + CSS + Monaco + icons + plugin frontends)
npm run build:all

# Development — NOTE: `npm run dev` requires Windows cmd.exe (calls start-electron.bat)
# It will NOT work in Git Bash, WSL, or PowerShell. Use `npm run build:all` instead,
# then invoke the anoclaw-test-build skill to package and test.
npm run dev

# Start (requires prior build, same cmd.exe requirement as dev)
npm start

# Run tests (Vitest)
npm test

# Run tests in watch mode
npm run test:watch
```

**Build notes**: There are two TypeScript compilations:
1. Root `tsconfig.json` → `dist/` (server code, `src/server/**` + `src/shared/**`; excludes `src/public`)
2. `src/public/tsconfig.json` → `src/public/js/` (frontend code)

Always run `npm run build:all` if both changed. Path aliases `@shared/*`, `@server/*`, `@public/*` are configured in root tsconfig — they resolve at compile time only (no runtime module aliasing).

## Completion Workflow

AnoClaw uses Git as the durable completion record. Do not write Obsidian/vault work logs for coding sessions.
Treat removal of retired guidance files such as `DESIGN.md` as an intentional cleanup when it is part of the current task; do not restore them just to keep the worktree unchanged.

After verified code, docs, config, or skill changes:
1. Inspect `git status --short --branch` and review the relevant diff.
2. Stage only intentional files; never include unrelated user changes, secrets, local data, or build caches.
3. Create a concise git commit describing the completed work.
4. Push the current branch to `origin`; if no upstream exists, use `git push -u origin HEAD`.
5. Report verification, commit hash, branch, and push status to the user.

## Architecture

### Four-Layer Design

```
Presentation (src/public/)         HTML/CSS/TS — browser SPA, static files
    │ HTTP REST + WebSocket (ws://127.0.0.1:3456/ws?session={id})
ViewModel (src/public/ts/viewmodel/)  TypeScript classes + EventEmitter
    │
Service (src/server/core/)         AgentRuntime, SessionManager, PromptAssembler, ToolRegistry...
    │
Infrastructure (src/server/infra/)  LLM providers, JSONL storage, MCP transports, WorkerPool
```

```mermaid
graph TB
    subgraph Presentation["Presentation (src/public/)"]
        SPA["index.html SPA"]
        VM["ViewModel<br/>(EventEmitter)"]
        WS["ws-client.ts<br/>(WebSocket)"]
    end

    subgraph Service["Service (src/server/core/)"]
        AR["AgentRuntime<br/>(processMessage)"]
        AL["AgentLoop<br/>(AsyncGenerator)"]
        SM["SessionManager<br/>(CRUD + Locks)"]
        PA["PromptAssembler<br/>(Sections)"]
        TR["ToolRegistry<br/>(built-in tools + plugins)"]
        CC["ContextCompressor"]
        AReg["AgentRegistry<br/>(Org Tree)"]
        COORD["CoordinationService<br/>(Teams + Tasks + Mailbox + Leases)"]
        CS["CoordinationScheduler"]
        PHM["PluginHostManager<br/>(Worker + RPC)"]
        EXT["ExtensionPoints<br/>(8 hooks)"]
    end

    subgraph Infrastructure["Infrastructure (src/server/infra/)"]
        LLP["LLMProvider<br/>(OpenAICompat / Ollama)"]
        APS["APIScheduler<br/>(Rate Limits)"]
        JSL["JsonlStore<br/>(Append-Only)"]
        MCPM["MCPClientManager<br/>(4 Transports)"]
        IC["InterruptController"]
        LM["LogManager<br/>(pino)"]
    end

    subgraph Gateway["Gateway Layer"]
        API["ApiServer<br/>(:15730)"]
        GW["GatewayRouter<br/>(WS Bridge)"]
    end

    SPA -->|"HTTP /ws"| WS
    WS -->|"send_message"| AR
    AR --> AL
    AR --> SM
    AR --> AReg
    AR --> COORD
    AL --> PA
    AL --> TR
    AL --> CC
    AL --> LLP
    AL --> APS
    AL --> IC
    COORD --> CS
    CS --> AL
    SM --> JSL
    API --> SM
    API --> AReg
    GW --> WS
    MCPM --> TR
    LM -.-> AR
    LM -.-> AL
```

### Two HTTP Servers (same process)

| Server | Port | Purpose |
|--------|------|---------|
| `main.ts` (HTTP + WS) | 3456 | Static files, WebSocket streaming, skill CRUD, API passthrough |
| `ApiServer` (REST) | 15730 | External AI agent control API, token-authenticated (localhost only) |

`main.ts` handles `/api/skills*` itself, all other `/api/*` routes delegate to `ApiServer.getInstance().handleApiRequest()`.

### Core Execution Flow

1. User sends message via WebSocket (`send_message`)
2. `main.ts` handler creates/loads session, appends user message to JSONL
3. Calls `AgentRuntime.processMessage()` → creates an `AgentLoop` (ReAct generator)
4. `AgentLoop` builds prompt via `PromptAssembler`, calls LLM via `LLMProvider`, executes tools via `ToolRegistry`
5. Each event (think/text/tool_call/tool_result) is yielded as SSE-like objects and pushed to client via WebSocket
6. Assistant response persisted to JSONL on completion

```mermaid
sequenceDiagram
    participant U as User
    participant WS as WsServer
    participant H as SendMessageHandler
    participant AR as AgentRuntime
    participant SM as SessionManager
    participant AL as AgentLoop
    participant PA as PromptAssembler
    participant LLM as LLMProvider
    participant TR as ToolRegistry
    participant CC as ContextCompressor

    U->>WS: send_message (WebSocket)
    WS->>H: dispatch
    H->>SM: getHistory(sessionId)
    SM-->>H: history (last 200)
    H->>AR: processMessage(sessionId, agentId, msg, history)

    AR->>AL: new AgentLoop(config)
    AR->>AL: run(userMessage, history, signal)

    loop ReAct Loop (up to maxTurns)
        AL->>PA: buildEffectivePrompt()
        PA-->>AL: systemPrompt

        AL->>AL: compact check (>70% context)

        alt Context Overflow
            AL->>CC: compact(messages)
            CC-->>AL: compacted messages
        end

        AL->>LLM: chat(messages, tools, systemPrompt)
        LLM-->>AL: stream (text_delta, think_delta, tool_use)

        alt No Tool Calls
            AL-->>AR: Done event
        else Tool Calls Present
            loop Each Tool Call
                AL->>TR: execute(toolName, args)
                TR-->>AL: ToolResult
                AL->>AL: compressResult + append
            end
            AL->>AL: stallDetector.check()
        end
    end

    AL-->>AR: Done + TokenBreakdown
    AR-->>H: SSEEvent stream
    H->>WS: send(event)
    WS->>U: SSE-like events (text, think, tool_call, tool_result, done)
```

### Persistent Company and Teams

- **Company**: exactly one local Company per installation in 3.0.
- **Team**: persistent, nested organization unit. Teams may grow, split, or be
  archived without changing the Agent execution engine.
- **TeamMembership**: gives an Agent `leader` or `member` responsibility and a
  primary Team.
- **Agent**: a persistent independent worker with its own instructions, model,
  tools, skills, capabilities, memory, sessions, and runtime state.
- **MainAgent**: the Company owner and normal user-facing Agent. It uses the
  same runtime as every other Agent but has company-level responsibilities.

`HireEmployee`, `ListEmployees`, `UpdateOrg`, and temporary `SubAgentSpawn` are not public 3.0
operations. Adding a new employee is a Team member operation that atomically
creates a persistent Agent and membership.

Agents are not globally single-threaded. An Agent can serve multiple Works
because each Run owns an independent Session and `AgentLoop`; server-owned
capacity policies still limit concurrent reads and writes.

### Coordination Plane

Every Work owns a persistent `Work → Mission → Task → Run → Session` execution
graph. The v3 scheduler is event-driven and server-owned. It selects Agents from
the responsible persistent Team, releases dependencies only after durable
completion, obtains Workspace isolation before execution, and submits a Task
only after the worker `AgentLoop` reaches `Done`.

Agent messages, Workspace leases, orchestration decisions, verification
records, and tool-call write-ahead journal entries live in the same Work JSONL
stream. `BackgroundTaskManager` remains reserved for non-Agent process jobs.

### Plugin Architecture

Plugins run in a Worker Thread, isolated from the main process. Communication via bidirectional MessageChannel RPC.

```mermaid
graph TB
    subgraph Main["Main Thread"]
        TR["ToolRegistry"]
        API["ApiServer"]
        EXT["ExtensionPoints<br/>(8 hooks)"]
        MGR["PluginHostManager<br/>spawn/restart/RPC"]
    end

    subgraph Worker["Worker Thread (PluginHost)"]
        PL["PluginLoader<br/>scan + parse"]
        PH["PluginHost<br/>activate/deactivate"]
        A["Plugin A<br/>extension.js"]
        B["Plugin B<br/>extension.js"]
        C["Plugin C<br/>extension.js"]
    end

    subgraph Frontend["Frontend (Browser)"]
        NAV["Navigation Dock<br/>KERNEL | plugins"]
        IFRAME["PluginPageContainer<br/>iframe sandbox + bridge"]
    end

    MGR -->|"MessageChannel"| PH
    PH -->|"import()"| A
    PH -->|"import()"| B
    PH -->|"import()"| C
    A -->|"anoclaw.tools.register()"| MGR
    MGR -->|"registerTool()"| TR
    MGR -->|"inject"| EXT
    NAV -->|"PluginViewModel.load()"| API
    IFRAME -->|"postMessage"| NAV
```

Plugins declare contributions in `plugin.json`: tools, pages (iframe HTML), commands, skills, API routes, kernel overrides.

### Session Model

A Session is only a transcript boundary and execution evidence:

- each Work owns one primary MainAgent Session;
- every Task Run owns a Run Session with an immutable Agent actor snapshot;
- Run Sessions may name their parent Session so the UI can show a transparent
  conversation tree;
- Work, Mission, Task, Team, and Agent state never live in Session metadata.

Users normally type only in the Work's primary Session. Team conversations are
visible and auditable but are driven by durable coordination messages.

### Tool System

Built-in tools are registered in `registerAllTools()` via directory scan of
`builtin/`. Every tool extends the abstract `Tool` class (EventEmitter-based).
Additional tools are registered by plugins at runtime via
`anoclaw.tools.register()` (RPC → PluginToolProxy → ToolRegistry). Each Agent
has an `allowedTools` whitelist. Key categories are File I/O, shell/native
execution, Web, persistent Team membership, Mission/Task orchestration,
AgentMessage, Plan mode, Memory, Skills, MCP, and Gateway.

### Storage: JSONL Append-Only

- `data/v3/company/install-company/events.jsonl` — Company, Workspace, Team,
  TeamMembership, and Agent source of truth
- `data/v3/work/<id>/events.jsonl` — Work and orchestration source of truth
- `data/v3/transcript/<session-id>/events.jsonl` — Session transcript evidence
- `data/v3/**/projection.json` — rebuildable startup checkpoints, never the
  source of truth
- `memory/company/`, `memory/teams/`, `memory/agents/`, and Work/Mission memory
  scopes — durable knowledge

### Singleton Pattern

Most core services use `getInstance()` + `resetInstance()` (for testing):
`AgentRuntime`, `AgentRegistry`, `ToolRegistry`, `SessionManager`, `WsServer`, `ApiServer`, `SkillManager`, `MCPClientManager`, `LogManager`, `MemoryManager`

## Key Conventions

- **No Express**: All HTTP handled via raw `http` module. Use `handleRequest()` style functions.
- **ESM modules**: `"type": "module"` in package.json. Use `.js` extensions in imports (TypeScript compiles to ESM).
- **EventEmitter everywhere**: Services extend `EventEmitter`. Frontend ViewModels use EventEmitter for reactive updates.
- **WebSocket for real-time**: One persistent WS connection per session. Protocol defined in `src/shared/types/ws-protocol.ts`.
- **Generator-based agent loop**: `AgentLoop.run()` is an `AsyncGenerator<SSEEvent>`. `AgentRuntime.processMessage()` wraps it. This allows clean interrupt/stop via `AbortSignal`.
- **Path resolution**: `main.ts` sets `process.chdir(REPO_ROOT)` at startup. All file paths relative to repo root.
- **Frontend icons**: SVG only, no emoji. Icons in `src/public/icons/`.
- **Dark theme default**: CSS custom properties in `:root`, light theme via `[data-theme="light"]`.
- **Logging**: Uses `pino`. Logs to `logs/anochat.log`. `LogManager` singleton.
- **API Key encryption**: Agent configs store `apiKey` encrypted at rest (Web Crypto API).

## DeepSeek API Constraints (Important)

When working with DeepSeek-based LLM providers:
1. All messages in the API request MUST have a `role` field — this includes tool result messages.
2. `sanitizeOrphanedMessages()` in `AgentLoopLLM.ts` cleans orphaned tool messages before every LLM call. Always keep this in place.
3. DeepSeek does NOT support `image_url` message content type.
4. If `reasoning_content` is missing from the API response, save with empty string rather than omitting the field.

## Adding a New Built-in Tool

1. Create `src/server/core/tools/builtin/YourTool.ts` extending `Tool`
2. Implement `name()`, `description()`, `parametersSchema()`, `execute()`
3. Rebuild: `npm run build` (auto-registers via directory scan)

## Adding a New Plugin Tool (Zero Kernel Changes)

1. Edit the plugin's `extension.js` — call `anoclaw.tools.register({ name, description, parametersSchema, category })` in `activate()`
2. Export `executeTool(toolName, params)` to handle tool execution
3. Reload: `POST /api/v1/plugins/reload { name: "my-plugin" }` or restart
4. Tool appears in agent's tool list immediately. No kernel changes.

## Plugin System

VSCode-style extension architecture. Plugins live in `plugins/<name>/` with `plugin.json` + `extension.js`.

```
Plugins run in a Worker Thread, isolated from the main process.
Main ↔ Worker communication: bidirectional MessageChannel RPC.

Plugin Host lifecycle:
  1. PluginHostManager (main) spawns Worker (PluginHost)
  2. PluginHost scans plugins/, parses plugin.json, auto-activates onStartup plugins
  3. activate(anoclawAPI) → plugin registers tools/pages via RPC
  4. File watcher auto-reloads on directory changes
  5. Worker crash → auto-restart with exponential backoff

anoclaw API (what plugins see):
  - tools.register(def)       → RPC → PluginToolProxy → ToolRegistry
  - api.call(method, path)    → RPC → ApiServer.callInternal()
  - services are self-hosted by plugins — plugins register their own HTTP endpoints
  - log.{info,warn,error}(msg) → fire-and-forget log RPC
  - context.{pluginName, pluginPath, storagePath}

Kernel Extension Points (8 overridable hooks):
  promptAssembler, promptSections, memoryStore, sessionStore,
  settingsStore, llmProvider, toolExecutor, agentLoop
  Plugins declare overrides in plugin.json → handler loaded on activate.

Plugin API endpoints:
  GET    /api/v1/plugins             — list all plugins
  POST   /api/v1/plugins/reload      — reload a plugin
  DELETE /api/v1/plugins/:name       — uninstall (renames to .disabled)
  POST   /api/v1/plugins/install     — install from GitHub URL
  GET    /api/v1/plugins/market      — browse community registry
```

## LLM Provider Architecture

Two provider implementations in `src/server/infra/llm/`:
- `OpenAICompatibleProvider` — generic OpenAI-compatible API (url + apiKey + model). Used for DeepSeek, Anthropic via compatible endpoints, etc.
- `OllamaProvider` — local Ollama (url + model, no apiKey required)

Factory: `createLLMProvider(config)` in `provider-factory.ts` selects based on `provider` config field.
`APIScheduler` handles rate limiting (RPM/TPM) globally.

## Frontend (src/public/)

- Pure HTML/CSS/TypeScript SPA (no React/Vue framework at runtime — though `.tsx` files use JSX syntax compiled to vanilla JS)
- `index.html` → entry point
- `ts/viewmodel/` — ViewModel layer with EventEmitter
- `ts/components/` — UI components
- `ts/ws-client.ts` — WebSocket communication layer
- Navigation: 9-page PAGES menu — 5 kernel (Sessions, Agents, Skills, Memory, Settings) + divider + plugin pages (Plugins, MCP, Meeting, Gateway)
- Plugin pages loaded dynamically from plugin manifests via `PluginViewModel` → iframe sandbox + postMessage bridge
- Streaming: `StreamingMessageDelegate` renders tokens in real-time from WS events

## MCP Integration

`MCPClientManager` (singleton) manages connections to external MCP servers. Supports 4 transports: Stdio, SSE, WebSocket, Streamable HTTP. External MCP tools are dynamically proxied via `MCPToolProxy` and registered as `mcp_<server>_<tool>` in ToolRegistry. `MCPServer` class exposes AnoClaw itself as an MCP server.

## Skills System

Skills are markdown files with YAML frontmatter in `skills/` directory. Loaded by `SkillManager`, injected into system prompt via `SkillsSection` in PromptAssembler. Agents have per-agent `enabledSkills` whitelist. Built-in skills include: `anoclaw-tester`, `browser-automation`, `code-review`, `dispatching-parallel-agents`, `executing-plans`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `writing-plans`.

## Configuration

- `config/settings.yaml` — app settings (port, logging, agent defaults, compression, supervision)
- `config/mcp_servers.yaml` — MCP server definitions
- Agent configs: `data/agents/<id>.json`
- `.mcp.json` — MCP server config (for browser-use tool)
