# src/server/ — Backend

## Quick Task Routing

| User asks | Touch these files |
|------|------|
| "agent stuck/looping" | `core/agent/AgentLoop.ts`, `core/agent/StallDetector.ts`, `core/agent/AgentRuntime.ts` |
| "agent not responding" | `core/agent/AgentLoop.ts` (ReAct loop), `core/agent/AgentRuntime.ts` (processMessage) |
| "tool execution broken" | `core/tools/ToolRegistry.ts`, `core/tools/builtin/<ToolName>.ts` |
| "add new tool" | Create `core/tools/builtin/NewTool.ts` — auto-registers via directory scan |
| "add new plugin tool" | Create `plugins/<name>/extension.js` — use `anoclaw.tools.register()`, zero kernel changes |
| "plugin not loading/activating" | `core/plugin-host/PluginHost.ts`, `core/plugin-host/PluginLoader.ts`, `core/plugin-host/PluginHostManager.ts` |
| "plugin tool not working" | `core/plugin-host/PluginToolProxy.ts`, `core/plugin-host/PluginAPI.ts` |
| "kernel override not working" | `core/plugin-host/ExtensionPoints.ts` + the kernel consumer (PromptAssembler, MemoryManager, etc.) |
| "new WS message type" | Create `infra/network/handlers/XxxHandler.ts` → register in `registerAllHandlers.ts` |
| "new HTTP route" | Create `gateway/routes/XxxRoute.ts` → register in `registerAllRoutes.ts` |
| "new slash command" | Create `core/commands/builtin/XxxCommand.ts` — auto-registers via directory scan |
| "new prompt section" | Create `core/prompt/sections/XxxSection.ts` → add to `registerAllSections.ts` |
| "new subsystem / feature flag" | Implement `Extension` → register in `main.ts` |
| "prompt quality bad" | `core/prompt/PromptAssembler.ts`, `core/prompt/sections/*.ts` |
| "context too long / compression" | `core/context/ContextCompressor.ts`, `core/context/CompactionConstants.ts` |
| "session recovery broken" | `core/session/SessionStore.ts` (JSONL), `core/session/SessionManager.ts` |
| "memory not saving" | `core/memory/MemoryManager.ts`, `core/memory/MemoryStore.ts` |
| "skill not loading" | `core/skills/SkillManager.ts`, `core/skills/SkillParser.ts` |
| "API endpoint broken" | `gateway/routes/<Route>.ts` (declarative) or `gateway/ApiServer.ts` (legacy) |
| "API write returns 503" | `gateway/WsRequired.ts` — write endpoints require WebSocket; open frontend or check WS connection |
| "plugin API/service broken" | Plugin extension.js → use `anoclaw.api.call()` for HTTP endpoints; write ops require WS; services now self-hosted by plugins |
| "LLM API error" | `infra/llm/OpenAICompatibleProvider.ts`, `infra/llm/APIScheduler.ts` |
| "WebSocket disconnected" | `infra/network/WsServer.ts` |
| "WS message routing broken" | `infra/network/WsMessageRouter.ts`, `infra/network/handlers/` |
| "logging broken" | `infra/logging/LogManager.ts` |
| "interrupt/task stop broken" | `core/agent/supervision/InterruptController.ts` |
| "delegation/background task tracking" | `core/agent/supervision/BackgroundTaskManager.ts`, `core/agent/AgentDelegation.ts`, `tools/builtin/TaskListTool.ts` |
| "parallel task orchestration" | `core/agent/TaskDAG.ts`, `core/agent/ExecutionPlan.ts`, `core/agent/AgentRuntime.ts` (executeParallelPlan) |
| "JSONL storage corrupted" | `infra/storage/JsonlStore.ts` |
| "logger not working" | `core/logger.ts`, `infra/logging/LogManager.ts` |
| "event bus / typed events" | `core/events/TypedEventBus.ts` |
| "event subscription / topic pub/sub" | `core/events/EventSubscriptionManager.ts` |
| "tool pipeline / retry" | `core/tools/ToolPipeline.ts`, `core/tools/ToolRegistry.ts` |
| "context over-limit / compression broken" | `core/context/ContextCompressor.ts`, `core/context/TokenCounter.ts` |
| "multi-agent / delegation / channel" | `core/agent/TaskDAG.ts`, `core/agent/ExecutionPlan.ts`, `core/agent/AgentChannel.ts`, `core/agent/SharedContextStore.ts` |
| "evolution system" | `core/evolution/EvolutionManager.ts`, `core/evolution/EvolutionExtension.ts` |
| "quality scores / star rating" | `core/evolution/modules/QualityScoreManager.ts` |
| "session tags / auto-tagging" | `core/evolution/modules/SessionTagger.ts` |
| "pattern detection / skill gen" | `core/evolution/modules/PatternDetector.ts` |
| "usage stats / analytics" | `core/evolution/modules/StatsCollector.ts` |
| "evolution reports" | `core/evolution/modules/EvolutionEngine.ts` |
| "settings not persisting" | `infra/storage/SettingsManager.ts` |
| "extension/feature flag broken" | `core/extensible/ExtensionManager.ts` |
| "worker thread issues" | `infra/threading/WorkerHandle.ts`, `infra/threading/WorkerPool.ts` |
| "token batching / estimation" | `infra/llm/TokenBatcher.ts`, `core/context/TokenCounter.ts` |

## Adding a New Built-in Tool

1. Create `src/server/core/tools/builtin/YourTool.ts`:
   ```ts
   import { Tool } from '../Tool.js';
   export class YourTool extends Tool {
     static category = 'File & Code';  // Category for automatic grouping
     static toolDescription = 'What this tool does.';
     name() { return 'YourTool'; }
     description() { return 'What this tool does.'; }
     parametersSchema() { return { /* JSON Schema */ }; }
     async execute(params, ctx) { /* implementation */ }
   }
   ```
2. Rebuild: `npm run build`
   (The tool auto-registers via directory scan — no manual import/registration needed.)

## Adding a New Plugin Tool (Zero Kernel Changes)

1. Edit the plugin's `extension.js`:
   ```js
   export async function activate(anoclaw) {
     await anoclaw.tools.register({
       name: 'MyTool',
       description: 'What it does',
       parametersSchema: { type: 'object', properties: {}, required: [] },
       category: 'Plugin',
     });
   }

   export async function executeTool(toolName, params) {
     if (toolName === 'MyTool') return `result for ${params.input}`;
     throw new Error(`Unknown: ${toolName}`);
   }
   ```
2. Reload: `POST /api/v1/plugins/reload { name: "my-plugin" }` or restart
3. Tool appears in agent's tool list immediately. Zero kernel changes.

## Adding a New Plugin (Complete)

1. Create `plugins/<name>/plugin.json` + `extension.js`
2. `plugin.json`: `{ name, displayName, version, main: "extension.js", activationEvents: ["onStartup"] }`
3. `extension.js`: export `activate(anoclaw)` + optional `executeTool(name, params)`
4. Tools register via `anoclaw.tools.register()`, HTTP routes via `anoclaw.routes.register()`, pages via manifest `contributes.pages`
5. Kernel APIs: `anoclaw.api.call()` (all REST endpoints), `anoclaw.routes.register()` (self-host HTTP endpoints)
6. Plugin directory auto-scanned at startup. File watcher auto-reloads on changes.

## Adding a New WebSocket Message Type

1. Create `src/server/infra/network/handlers/YourHandler.ts`:
   ```ts
   import type { WsMessageHandler } from '../WsMessageRouter.js';
   export const yourHandler: WsMessageHandler = async (ctx) => {
     // ctx.sessionId, ctx.data, ctx.ws
   };
   ```
2. Register in `src/server/infra/network/handlers/registerAllHandlers.ts`
3. On the frontend: create handler in `src/public/ts/handlers/` and register in `app.ts`
4. Rebuild: `npm run build:all`

## Adding a New Subsystem (Extension)

1. Create an Extension wrapper in the subsystem's directory:
   ```ts
   import type { Extension } from '../extensible/Extension.js';
   export class MyExtension implements Extension {
     readonly id = 'my-system';
     readonly name = 'My System';
     readonly dependencies: string[] = [];
     private _running = false;
     async start(): Promise<void> { /* init */ this._running = true; }
     async stop(): Promise<void> { this._running = false; }
     isRunning(): boolean { return this._running; }
   }
   ```
2. Register in `src/server/main.ts` → `extMgr.register(new MyExtension())`
3. Toggle via config: add to `extensions.disabled` in settings.yaml to disable
4. Rebuild: `npm run build`

## Adding a New Declarative HTTP Route

1. Create `src/server/gateway/routes/YourRoute.ts` implementing `RouteHandler`
2. Register in `src/server/gateway/routes/registerAllRoutes.ts`
3. Rebuild: `npm run build`

## File Map

```
src/server/
├── main.ts                              # Entry point — HTTP, WS, routes, extension reg
├── bootstrap/
│   ├── ToolRegistrar.ts                  # Auto-scans builtin/ for Tool subclasses
│   └── CommandRegistrar.ts               # Registers slash commands
├── core/
│   ├── logger.ts                         # Core-level console-first logger with LogManager bridge
│   ├── agent/
│   │   ├── AgentLoop.ts                 # ★ ReAct loop engine (~504 lines) — the core
│   │   ├── AgentLoopCompaction.ts       # Shared compaction + message-rebuild logic
│   │   ├── AgentLoopLLM.ts              # LLM API call with retry + streaming
│   │   ├── AgentRuntime.ts              # Message handling, sub-session management
│   │   ├── AgentDelegation.ts           # Sub-Agent spawning + task delegation
│   │   ├── AgentChannel.ts              # Real-time typed messaging between agents via TypedEventBus
│   │   ├── SharedContextStore.ts        # Bidirectional key-value shared state per team/session
│   │   ├── TaskDAG.ts                    # Dependency-graph for parallel task orchestration
│   │   ├── ExecutionPlan.ts              # Batch-parallel execution of TaskDAG plans
│   │   ├── Agent.ts                     # Agent entity — identity, role, state
│   │   ├── AgentRegistry.ts             # Agent singleton registry + org tree
│   │   ├── AgentConfig.ts               # Agent config loading (YAML/JSON)
│   │   ├── StallDetector.ts             # Stall detection + self-recovery
│   │   ├── AgentLoopHelpers.ts          # Compress, sleep, token estimate
│   │   ├── StatusMessages.ts            # Status message formatting
│   │   └── supervision/
│   │       ├── InterruptController.ts   # Agent interrupt control (migrated from infra/supervision)
│   │       ├── SupervisionManager.ts    # Heartbeat tracking + timeout detection for sub-agents
│   │       └── BackgroundTaskManager.ts # Background task tracking + progress injection
│   ├── events/
│   │   ├── TypedEventBus.ts              # Centralized publish/subscribe typed event bus
│   │   └── EventSubscriptionManager.ts   # Topic-based pub/sub for agent event delivery
│   ├── evolution/
│   │   ├── EvolutionManager.ts           # ★ Singleton orchestrator for all 6 modules
│   │   ├── EvolutionExtension.ts         # Extension wrapper — wires all modules via TypedEventBus
│   │   ├── storage/
│   │   │   └── EvolutionStore.ts         # Evolution data persistence (scores, patterns, stats)
│   │   └── modules/
│   │       ├── EvolutionEngine.ts        # M6: Analysis + report generation
│   │       ├── PatternDetector.ts        # M1: Repetition detection → auto SKILL.md generation
│   │       ├── KeywordExtractor.ts       # M2: Periodic keyword extraction
│   │       ├── StatsCollector.ts         # M3: Usage statistics collection
│   │       ├── SessionTagger.ts          # M4: Auto-tag sessions on loop completion
│   │       └── QualityScoreManager.ts    # M5: Human quality scores (1-5) with index
│   ├── interfaces/
│   │   └── ILogger.ts                    # Logger interface for core → infra decoupling
│   ├── session/
│   │   ├── SessionManager.ts            # Session lifecycle, concurrency lock
│   │   ├── Session.ts                   # Session entity — messages, metadata, serialization
│   │   ├── SessionStore.ts              # JSONL persistence, recovery, archiving
│   │   ├── ISessionRepository.ts        # Persistence interface (implemented by infra/storage/)
│   │   ├── FileHistoryTracker.ts        # Tracks files read/modified per session
│   │   └── MessageWithdrawalManager.ts  # Message retraction + history cleanup
│   ├── tools/
│   │   ├── Tool.ts                      # Abstract base — static category/toolDescription
│   │   ├── ToolRegistry.ts              # Tool registration + execution proxy
│   │   ├── ToolPipeline.ts              # 5-stage execution pipeline (validate→security→execute→retry→normalize)
│   │   ├── ToolResult.ts                # Result helpers
│   │   └── builtin/                     # 33 built-in tools — drop in, auto-registers
│   ├── plugin-host/                     # ★ Plugin system (VSCode-style extensions)
│   │   ├── PluginHostManager.ts         # Main-side: spawn/restart Worker, RPC dispatch, injects ExtensionPoints
│   │   ├── PluginHost.ts                # Worker entry: load manifests, activate/deactivate, esbuild TS compile
│   │   ├── PluginLoader.ts             # Scan plugins/ dir, parse plugin.json, validate manifests
│   │   ├── PluginAPI.ts                 # anoclaw API — tools.register, api.call, services.*, log
│   │   ├── PluginToolProxy.ts           # Tool subclass proxies execution to plugin Worker via RPC
│   │   ├── PluginRPC.ts                 # RPC protocol types + PluginManifest/PluginState interfaces
│   │   └── ExtensionPoints.ts           # 8 kernel override hooks (prompt/memory/session/settings/LLM/tool/loop)
│   ├── prompt/
│   │   ├── PromptAssembler.ts           # System prompt — sections via registerAllSections()
│   │   ├── PromptCache.ts               # Prompt cache + invalidation
│   │   ├── PromptSection.ts             # Section interface + sectionMeta type
│   │   └── sections/                    # 20 Section factories — each exports sectionMeta
│   │       └── registerAllSections.ts   # Centralized section registration
│   ├── memory/
│   │   ├── MemoryManager.ts             # Memory manager (auto-extract, search, save)
│   │   ├── MemoryExtension.ts           # Extension wrapper (feature-flag gated)
│   │   ├── MemoryStore.ts               # Memory filesystem read/write
│   │   ├── MemoryEntry.ts               # Memory type definitions
│   │   ├── MemorySearchScorer.ts        # Fuzzy/semantic search scoring (fuse.js)
│   │   └── MemorySynonyms.ts            # Cross-language synonym expansion map
│   ├── context/
│   │   ├── ContextCompressor.ts         # Context compression
│   │   ├── CompressionStrategy.ts       # Strategy definitions
│   │   ├── TokenCounter.ts              # Token counting
│   │   └── CompactionConstants.ts       # Compaction constants
│   ├── skills/
│   │   ├── Skill.ts                     # Skill base class + metadata
│   │   ├── SkillManager.ts              # Skill loading + execution
│   │   ├── SkillParser.ts               # Skill YAML parsing
│   │   ├── SkillFromTools.ts            # Tool-to-skill auto-generation
│   │   └── SkillsExtension.ts           # Extension wrapper (feature-flag gated)
│   ├── extensible/
│   │   ├── Extension.ts                 # Extension interface (id, start, stop, isRunning)
│   │   └── ExtensionManager.ts          # Topo-sort startup, feature-flag gating
│   └── commands/...
│       ├── Command.ts                    # Abstract base — static category/commandDescription
│       ├── CommandRegistry.ts            # Command registration + execution
│       ├── CommandResult.ts              # Result helpers
│       └── builtin/                      # 4 built-in slash commands — drop in, auto-registers
│           ├── ClearCommand.ts
│           ├── CompactCommand.ts
│           ├── HelpCommand.ts
│           └── InitCommand.ts
├── gateway/
│   ├── ApiServer.ts                     # REST API (legacy if-else + RouteHandler dispatch + plugin route dispatch)
│   ├── RouteHandler.ts                  # Declarative route interface + matchRoute()
│   ├── RouteHelpers.ts                  # sendJson/readBody for route handlers
│   ├── ApiAuth.ts                       # API authentication + key management
│   ├── GatewayRouter.ts                 # WS↔Gateway bridge (platform adapters defined by plugins)
│   ├── handlers/
│   │   ├── SessionHandlers.ts           # Session CRUD + overview + search
│   │   ├── AgentHandlers.ts             # Agent CRUD + status
│   │   ├── WorkspaceHandlers.ts         # Workspace browse/read/create + get workspace
│   │   ├── ToolHandlers.ts              # Tool list, direct execution, command list
│   │   └── SystemHandlers.ts            # Health, stats, logs, open-file
│   └── routes/
│       ├── registerAllRoutes.ts         # Centralized route registration
│       ├── HealthRoute.ts              # GET /api/v1/health
│       ├── ToolsRoute.ts               # GET /api/v1/tools, /api/v1/commands
│       ├── SystemRoutes.ts             # POST /api/v1/system/open-file
│       ├── MemoryRoutes.ts             # Memory CRUD
│       └── SettingsRoutes.ts           # Settings GET/PUT
└── infra/
    ├── llm/
    │   ├── OpenAICompatibleProvider.ts   # LLM provider (DeepSeek API)
    │   ├── OllamaProvider.ts             # Local Ollama provider
    │   ├── LLMProvider.ts                # Provider interface
    │   ├── TokenBatcher.ts               # Token batching + estimation
    │   ├── provider-factory.ts           # Provider factory (config→provider)
    │   └── APIScheduler.ts              # Rate limiting
    ├── storage/
    │   ├── JsonlStore.ts                # JSONL append + sharding
    │   ├── JsonlSessionRepository.ts    # ISessionRepository impl backed by SessionStore
    │   └── SettingsManager.ts           # Settings persistence
    ├── network/
    │   ├── WsServer.ts                  # WebSocket server
    │   ├── WsMessageRouter.ts           # Pluggable WS message dispatch
    │   ├── WsForwardSubscriber.ts       # Bridges TypedEventBus events to WebSocket clients
    │   ├── WebFetchHelper.ts            # WebFetch tool HTTP helper
    │   ├── HttpClient.ts                # HTTP client
    │   └── handlers/
    │       ├── registerAllHandlers.ts   # WS handler registration
    │       ├── SendMessageHandler.ts    # 'send_message' message handler
    │       ├── StopHandler.ts           # 'stop' message handler
    │       ├── PingHandler.ts           # 'ping' message handler
    │       └── RunCommandHandler.ts     # 'run_command' message handler
    ├── logging/
    │   └── LogManager.ts                # pino logging
    ├── supervision/
    │   └── ToolProfiler.ts              # Tool performance profiling
    ├── threading/                       # Threading/concurrency
    │   ├── WorkerHandle.ts              # Worker thread wrapper
    │   ├── WorkerPool.ts                # Thread pool management
    │   └── session-worker.ts            # Session worker thread entry
    ├── StaticFiles.ts                   # Static file serving (index.html, JS, CSS)
    └── StreamPersister.ts              # Streaming response persistence
```

## Systems

### Agent Hierarchy
```
MainAgent (CEO, 0) → Manager (1) → Member (2) → SubAgent (temp)
```
One Agent serves multiple Sessions. Sub-Sessions inherit parent context.

### Tool Permissions
- Manager(1)+ : `HireEmployee`, `UpdateOrg`, `TaskAssign`
- Member(2)+ : `SubAgentSpawn`
- SubAgent(3)+ : everything else
- Delegation timeout: 10 min → `InterruptController.requestInterrupt()`

### Plugin System
Worker Thread isolation, VSCode-style extension API. Plugins in `plugins/` consist of `plugin.json` + `extension.js`.
- Loaded: PluginHostManager spawns Worker → PluginHost scans `plugins/` → activates matching `activationEvents`
- `anoclaw` API: `tools.register()` (RPC→ToolRegistry), `api.call()` (RPC→ApiServer.callInternal, write ops require WS), `routes.register()` (RPC→ApiServer), `log.{info,warn,error}`. Services (MCP, Meeting, Gateway, Workflow) are self-hosted by plugins — each plugin registers its own HTTP routes and agent tools.
- Kernel overrides: 8 ExtensionPoints (`promptAssembler`, `memoryStore`, `sessionStore`, `settingsStore`, `llmProvider`, `toolExecutor`, `agentLoop`). Plugins declare `contributes.overrides` → handler auto-registered on activate.
- Deployment: delete plugin directory → tools + pages gone. Add directory → auto-detected. File watcher auto-reloads on changes.
- API: `GET /api/v1/plugins` (list), `POST /api/v1/plugins/reload` (reload), `DELETE /api/v1/plugins/:name` (uninstall), `POST /api/v1/plugins/install` (from URL), `GET /api/v1/plugins/market` (registry)

### DeepSeek API Constraints ★

1. All messages MUST have `role` — including tool results
2. `sanitizeHistory()` must synchronously clean orphaned tool messages
3. DeepSeek does NOT support `image_url` content type
4. Missing `reasoning_content` → save as empty string, don't omit

## Conventions
- **ESM**: `.js` extensions. Path aliases: `@shared/*`, `@server/*`, `@public/*`
- **Singleton**: `getInstance()` + `resetInstance()`. EventEmitter on all services.
- **JSONL**: `data/sessions/<id>/shard_NNNNNN.jsonl`, 10K lines / 10MB / 30 day sharding
- **Logging**: `LogManager.getLogger('module')`, never `console.log`
- **Zod**: validate all external input
- **Comments/identifiers in English**

## Reference Sources
`F:/QoderSoft/reference/` — consult for difficult problems:
| Directory | Reference |
|------|------|
| `Claude code 源码/` | CLI architecture, tool system, Agent orchestration |
| `hermes-agent/` | Multi-Agent, task delegation, ACP protocol |
| `crewAI/` | Multi-Agent collaboration, Role-Based Agent |
| `autogen/` | Multi-Agent dialogue, code generation |
| `codex/` | Sandbox execution, fully automated Agent |
| `comfyui-backend/` | Node graph / workflow engine |

## Additions since File Map (not yet in map)

- `gateway/routes/` — 25+ route files beyond the 6 listed in File Map (ToolExecuteRoute, WorkspaceRoute, SessionControlRoutes, AgentExecuteRoute, SkillExecuteRoute, EvolutionRoute, SkillsRoutes, PluginStorageRoutes, PluginConfigRoutes, PluginDetailRoute, PluginDiagnosticRoutes, LogRoutes, BackgroundTaskRoute, PromptRoutes, WsRoutes, AgentControlRoutes, AgentOrgTreeRoute, SettingsFullRoute, SessionTreeRoutes, MemorySearchRoute, MemoryExtractRoute, SystemInfoRoute, ToolsDetailRoute, ToolsGroupRoute, SessionMessageRoute, etc.)
- `core/agent/AgentLoopCompaction.ts` — compaction + message-rebuild logic
- `core/agent/AgentLoopLLM.ts` — LLM API call with retry + sanitizeOrphanedMessages
- `core/agent/TaskNotification.ts` — task notification XML builder
- `core/session/SessionLeaseManager.ts` — session lease management
- `core/context/ContentAwareCompressor.ts` — content-aware tool output compression
- `core/plugin-host/PluginStorage.ts` — plugin key-value file storage
- `core/prompt/sections/ToolPromptSection.ts`, `UserAwarenessSection.ts` — additional sections
- `infra/network/Transport.ts` — transport layer
- `infra/stream/StreamConsumer.ts` — stream consumer
