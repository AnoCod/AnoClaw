# AnoClaw

A desktop multi-agent orchestration platform. Build and manage teams of AI agents through a visual org chart, with a built-in talent pool of 40+ expert agent templates.

![Electron](https://img.shields.io/badge/Electron-42-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue) ![License](https://img.shields.io/badge/License-MIT-green)

> **Disclaimer**: This is a personal hobby project, built out of interest in multi-agent systems. It is not a commercial product with dedicated maintenance. Updates come at irregular intervals, features are driven by personal curiosity rather than roadmap commitments, and some corners may be rougher than a production product. It is shared as-is in the hope that it is useful or interesting to others working on similar ideas. Contributions, forks, and experiments are welcome.

## Highlights

### Hierarchical Multi-Agent Architecture

Agents are organized as a tree: a MainAgent (CEO) delegates tasks to Managers, who coordinate Members. Each delegation creates a persistent **sub-session** — the parent-child conversation history is preserved in full JSONL detail. You can inspect every level of delegation, trace how a high-level instruction was broken down into tool calls, and audit the reasoning chain end to end. Unlike stateless agent chains, sub-sessions maintain their own independent context windows and can be resumed or reviewed at any time.

### Visual Agent Management

The org chart renders your agent hierarchy as an interactive force-directed graph. Drag to reposition, scroll to zoom, right-click for context actions. Add new agents via ghost nodes, edit configuration in the floating panel, or hire from the built-in talent pool — all without leaving the page. Node positions persist per session.

### Talent Pool with 40+ Expert Templates

A library of reusable agent templates organized by domain. Each template includes a curated system prompt, recommended model, tool whitelist, and tags. Hire a template into your org with hierarchy validation (CEO can only have Managers, Members are leaf nodes, etc.). Save your own agents back to the pool for reuse.

### Plugin System for Unlimited Extensibility

Plugins run in isolated Worker Threads — a crash in plugin code does not affect the main process. The plugin API allows registering new tools, serving plugin frontends as iframed pages, injecting prompt sections, overriding kernel behaviors, and calling internal REST endpoints. Everything from new LLM providers to custom MCP transports can be added as a plugin without modifying kernel code.

### Multi-Agent Meeting Orchestration (Demo Plugin)

The Meeting plugin orchestrates real-time discussions among multiple AI agents. Participants in a meeting are agents from your org chart. The plugin supports three speaking modes:

- **Round-robin**: Each participant speaks in turn, collecting the next speaker's response through the LLM before advancing.
- **Moderator**: A designated moderator agent controls the flow, deciding who speaks next based on the discussion state.
- **Auto**: Agents speak freely as the LLM determines relevant contributions.

Each meeting produces a full transcript with per-speaker attribution, auto-extracted action items with status tracking (pending / in-progress / done), an LLM-generated summary, and speaker analytics (turn count, average response length). Meetings are persisted as JSON files in `data/meetings/` and can be exported, searched, and compared. Templates are available for common formats: daily standup, sprint planning, bug triage, retrospective, design review, and incident postmortem.

See `plugins/anoclaw-meeting/` for the full implementation.

### Built-In Workspace IDE

The Workspace page provides a file manager and code editor for the bound working directory. It combines three panels:

- **File tree** (left sidebar): Lazy-loads directory contents on expand. Supports right-click context menu (new file/folder, rename, delete), drag-and-drop move, and keyboard shortcuts (Delete, F2). Polls every 5 seconds for external changes.
- **Tab container**: Opens files in Monaco Editor with syntax highlighting, status bar, and Ctrl+S save.
- **Split view**: Drag a tab into a second pane for side-by-side editing.

### Built-In Browser (WebContentsView)

Each tab in the workspace can be a full browser tab backed by Electron's WebContentsView — a real Chromium renderer embedded directly into the desktop window, not a sandboxed iframe.

Browsers are created when an agent calls `wvCreate` via `executeJavaScript`. The workspace automatically navigates to the Workspace page and opens a new tab with a complete browser toolbar:

- **Navigation controls**: URL bar, back/forward/reload buttons
- **DevTools**: Toggle DevTools for the browser tab
- **Console capture**: Captures console output from the page for agent consumption
- **Screenshot**: Takes full-page screenshots on demand
- **JS execution**: Agents can run `executeJavaScript` in the browser context to inspect DOM, fill forms, click buttons, and read page state — all visible to the user in real time

Multiple browser tabs can be open simultaneously, each with its own WebContentsView instance. The workspace caches tab state per session, so switching between sessions preserves open tabs.

### Persistence Without a Database

Conversation history is stored as append-only JSONL shards — no database setup, no schema migrations, no connection pooling. Each shard is capped at 10K lines or 10MB, with automatic rotation and 30-day archiving. Agent configurations are plain JSON files. The entire data directory is portable and human-readable.

### Context Compression

LLM context windows are finite. When a conversation exceeds 70% of the configured window, the ContextCompressor steps in. It uses a content-aware strategy rather than a simple FIFO drop: earlier exchanges are summarized by the LLM into condensed representations, tool results are truncated to head/tail (configurable, default 500 chars each), and the resulting compacted messages replace the original content. The most recent messages are always preserved intact so the agent can continue the current task without losing context. Compression is triggered per-turn and runs asynchronously so it does not block message delivery. The compaction constants (trigger ratio, summary max tokens, head/tail sizes) are configured in `CompactionConstants.ts`.

### Memory System

The memory system provides persistent knowledge storage for agents. It uses a hybrid architecture:

- **SQLite** for structured metadata (document IDs, timestamps, agent attribution, tags)
- **Vector embeddings** (all-MiniLM-L6-v2, 384 dimensions) for semantic similarity search
- **BM25** for keyword/lexical search, weighted at 30% in hybrid queries

On write, content is embedded, indexed in both the vector store and BM25 index, and metadata is recorded in SQLite. On query, a hybrid search combines vector similarity and BM25 scores with configurable weights, returning the top-K results (default 10, max 100). Results below a minimum score threshold (0.1) are discarded.

Memory is scoped by agent and team — agents can query team-level shared memory or their own private store. The Memory extension (`MemoryExtension.ts`) registers memory operations as part of the system prompt so agents are aware they can store and retrieve information across sessions. The SQLite database is stored at `data/memory.db`.

### Skill System

Skills are reusable capability definitions stored as markdown files with YAML frontmatter. Each skill has a name, description, and content body. When an agent has a skill enabled, its content is injected into the agent's system prompt as a dedicated section during prompt assembly.

Skills are loaded from the `skills/` directory by `SkillManager`, which also supports user-level skills from `~/.anoclaw/skills/`. An agent's `enabledSkills` whitelist determines which skills are active per agent. The Skills page in the UI allows creating, editing, importing, and toggling skills.

Skills differ from tools in that they modify the agent's behavior through prompt instructions rather than adding executable functions. A skill might define a coding style guide, a conversation protocol, or domain-specific rules that the agent should follow.

### Evolution System

The evolution system tracks agent performance over time and identifies improvement opportunities. It consists of several modules:

- **QualityScoreManager**: Collects user star ratings (1-5) on individual messages and computes aggregate quality scores per agent, per session, and over time.
- **SessionTagger**: Automatically tags sessions with labels based on content analysis (e.g., "bug-fix", "feature-planning", "code-review"). Tags are persisted in session metadata and searchable.
- **PatternDetector**: Analyzes conversation patterns to identify recurring workflows and suggests skill generation. Detects patterns like repeated tool sequences, common error recovery paths, and frequent task types.
- **StatsCollector**: Aggregates usage statistics — messages per session, tool invocation frequency, token consumption, session duration, error rates.
- **EvolutionEngine**: Generates periodic evolution reports that correlate user feedback with session tags and patterns to recommend improvements — which skills to create, which tools to enable, and which agents need prompt tuning.

Evolution data is stored in `data/evolution/` as JSON files. All modules are optional and run on a scheduled interval without blocking the agent loop.

### Technology Choices

The frontend is pure TypeScript with native DOM APIs — no React, no Vue, no framework churn. The backend uses Node's built-in `http` module — no Express, no NestJS, no heavy abstractions. The desktop layer is standard Electron. This means the dependency footprint is small, the code is directly debuggable, and there are no framework-specific conventions to learn before contributing.

## Quick Start

```bash
npm install
npm run build:all
npx electron-builder --win
```

Double-click `release9/win-unpacked/AnoClaw.exe`. The first launch opens a setup wizard where you configure your LLM provider (API key, model, API URL).

**Build caveat**: `npm run dev` and `npm start` use a Windows batch file (`start-electron.bat`) and will not work in Git Bash or WSL. Always build with `npm run build:all` and package with `electron-builder`.

## Project Structure

```
├── src/
│   ├── server/          # Backend (251 .ts files)
│   │   ├── main.ts              # Entry point — HTTP server + WebSocket
│   │   ├── core/                # Business logic
│   │   │   ├── agent/           # Agent runtime, registry, delegation
│   │   │   ├── tools/           # Tool system (33+ built-in tools)
│   │   │   ├── session/         # Session lifecycle, JSONL persistence
│   │   │   ├── prompt/          # Prompt assembly (extensible sections)
│   │   │   ├── context/         # Context compression, token counting
│   │   │   ├── memory/          # Memory management (SQLite + embeddings)
│   │   │   ├── events/          # Typed event bus, pub/sub
│   │   │   ├── commands/        # Slash commands
│   │   │   ├── evolution/       # Quality scoring, pattern detection
│   │   │   ├── skills/          # Skills system (markdown with YAML frontmatter)
│   │   │   ├── plugin-host/     # Worker thread isolation for plugins
│   │   │   ├── extensible/      # Extension points
│   │   │   └── talent-pool/     # Agent template library (hiring system)
│   │   ├── gateway/             # REST API server
│   │   │   ├── ApiServer.ts              # REST server (:15730)
│   │   │   ├── routes/                   # 30+ declarative route handlers
│   │   │   └── handlers/                 # Legacy handler functions
│   │   └── infra/               # Infrastructure
│   │       ├── llm/             # LLM providers (OpenAI-compatible, Ollama)
│   │       ├── storage/         # JSONL append-only storage
│   │       ├── logging/         # Pino logger
│   │       ├── network/         # WebSocket server + handlers
│   │       └── stream/          # Stream persistence
│   ├── public/           # Frontend SPA (100 .ts/.tsx files)
│   │   ├── index.html           # SPA entry point
│   │   ├── css/                 # 20+ CSS files (dark theme via CSS vars)
│   │   ├── ts/                  # TypeScript source
│   │   │   ├── app.ts           # App bootstrap, page registration
│   │   │   ├── viewmodel/       # EventEmitter-based ViewModels
│   │   │   ├── components/      # UI components
│   │   │   │   ├── pages/       # Page components (AgentsPage, SkillsPage, etc.)
│   │   │   │   ├── ui/          # Shared UI kit (Button, Dialog, Badge, etc.)
│   │   │   │   └── conversation/# Chat message rendering delegates
│   │   │   └── handlers/        # WS event handlers
│   │   └── icons/               # SVG icons
│   └── shared/           # Type contracts (22 files)
│       └── types/               # Shared types (agent, session, tool, ws-protocol, etc.)
├── plugins/              # Demo plugins (5 reference implementations)
│   ├── anoclaw-comfyui/  # ComfyUI image generation integration
│   ├── anoclaw-gateway/  # Telegram/WeChat/Feishu messaging gateway
│   ├── anoclaw-mcp/      # Model Context Protocol server manager
│   ├── anoclaw-meeting/  # Multi-agent meeting orchestration
│   └── anoclaw-workflow/ # Visual workflow editor and engine
├── scripts/              # Build scripts (bundle-css, copy-monaco, build-icons, etc.)
├── data/                 # Runtime data (auto-created)
│   ├── agents/           # Agent configuration files
│   ├── sessions/         # Conversation history (JSONL shards)
│   └── talent-pool/      # Agent template library
└── config/               # Configuration (auto-created by setup wizard)
```

## Architecture

### Two HTTP Servers (same Node.js process)

| Server | Port | Purpose |
|--------|------|---------|
| `main.ts` (HTTP + WS) | 3456 | Serves frontend static files, WebSocket for real-time chat, REST API passthrough |
| `ApiServer` (REST) | 15730 | External AI agent control API, token-authenticated (localhost only) |

All `/api/*` routes are handled by the Gateway system. Routes are declared via `RouteHandler` interface and registered in `registerAllRoutes.ts`.

### Four-Layer Design

```
Presentation (src/public/)         HTML/CSS/TS SPA
    │ WebSocket (ws://127.0.0.1:3456/ws)
ViewModel (src/public/ts/viewmodel/)  EventEmitter-based state management
    │ HTTP REST
Service (src/server/core/)         AgentRuntime, ToolRegistry, SessionManager, PromptAssembler...
    │
Infrastructure (src/server/infra/)  LLM providers, MCP transports, JSONL storage, WorkerPool
```

### Core Execution Flow

1. User sends message via WebSocket (`send_message`)
2. `main.ts` handler loads session, appends user message to JSONL
3. Calls `AgentRuntime.processMessage()` → creates `AgentLoop` (ReAct async generator)
4. `AgentLoop` builds prompt via `PromptAssembler`, calls LLM via `LLMProvider`, executes tools via `ToolRegistry`
5. Each event (think/text/tool_call/tool_result) yields as SSE-like objects → pushed to client via WebSocket
6. Assistant response appended to JSONL on completion

### Agent Hierarchy

| Level | Role | Purpose |
|-------|------|---------|
| 0 | MainAgent (CEO) | Always exists. Decomposes tasks, delegates to Managers. |
| 1 | Manager | Manages a team of Members. Can have other Managers as peers. |
| 2 | Member | Leaf workers. Execute tasks, cannot manage others. |
| — | SubAgent | Temporary, spawned at runtime, destroyed when done. |

**Key**: Agents are NOT single-threaded — one agent can serve multiple sessions simultaneously because LLM API calls are stateless. Each session has independent context and its own `AgentLoop` instance.

### Hierarchy Validation

The system enforces these rules when creating or hiring agents:
- Member (level 2) is a leaf node — cannot have subordinates
- CEO (level 0) can only have Manager (level 1) subordinates
- Only one CEO allowed per instance
- CEO cannot be a subordinate of any agent

## Agent Management

### Visual Org Chart

The Agents page renders a d3-force simulation graph:
- **CEO**: Red circle (r=22), top-center
- **Managers**: Purple circles (r=16), middle row
- **Members**: Blue circles (r=12), below their manager
- **Ghost nodes**: Dashed circles with "+" button to add new agents

**Interactions**:
- **Drag** nodes to reposition (positions saved to sessionStorage)
- **Scroll wheel** to zoom in/out (centered on cursor position)
- **Drag background** to pan
- **Click node** → edit panel (right side)
- **Right-click node** → context menu (Edit, Add Manager/Member, Save to Talent Pool, Delete)
- **Click ghost "+"** → opens edit panel pre-filled with parent and role

### Talent Pool (Built-in)

The talent pool (right drawer) contains 40+ expert agent templates across 10 domains. Access via the "Talent Pool" button in the top-right of the Agents page.

**Actions**:
- Browse by domain group (expandable/collapsible tree)
- Right-click template → "Hire Template" → select role and parent → confirm → agent created
- Right-click template → "Preview Prompt" → see full system prompt and tool list
- Right-click existing agent node → "Save to Talent Pool" → save as reusable template
- Right-click domain group → rename/delete
- "New Domain" button at top to create custom groups
- Search bar to filter templates by name, description, or tags

## Plugin System

> The open-source version includes the full plugin host runtime and 5 demo plugins. These are working reference implementations you can study, modify, and learn from. See `plugins/` directory.

### Architecture

```
┌─────────────────────────────────┐
│         Main Thread             │
│  ┌───────────┐ ┌─────────────┐  │
│  │ToolRegistry│ │ExtensionPts │  │
│  └─────┬─────┘ └──────┬──────┘  │
│        │              │         │
│  ┌─────┴──────────────┴──────┐  │
│  │   PluginHostManager       │  │
│  │   spawn / restart / RPC   │  │
│  └────────────┬──────────────┘  │
└───────────────┼─────────────────┘
                │ MessageChannel
┌───────────────┼─────────────────┐
│  Worker Thread │                │
│  ┌────────────┴──────────────┐  │
│  │       PluginHost          │  │
│  │  scan plugins/ → parse    │  │
│  │  plugin.json → activate() │  │
│  └────┬──────────┬───────────┘  │
│  ┌────┴────┐ ┌───┴────┐        │
│  │Plugin A │ │Plugin B│        │
│  │tool reg │ │page reg│        │
│  └─────────┘ └────────┘        │
└─────────────────────────────────┘
```

Plugins execute in a **Worker Thread**, fully isolated from the main process. Communication happens exclusively through **MessageChannel RPC** — no shared memory, no direct function calls, no `eval`. If a plugin crashes:
- The Worker is terminated automatically
- PluginHostManager detects the exit and restarts with exponential backoff (100ms → 200ms → 400ms → ... → 30s max)
- The main process continues unaffected
- Registered tools from the crashed plugin are removed from ToolRegistry until the worker recovers

### Directory Structure

```
plugins/<name>/
├── plugin.json          # Manifest — name, version, contributions (required)
└── extension.js         # Extension entry point (required)
    └── frontend/        # Optional: iframe-based UI pages
        └── index.html
```

### plugin.json

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "version": "1.0.0",
  "description": "Does something useful",
  "publisher": "your-name",
  "onStartup": true,
  "contributes": {
    "tools": ["my-tool"],
    "pages": ["my-page"],
    "commands": ["my-command"],
    "skills": ["my-skill"]
  },
  "kernelOverrides": {
    "llmProvider": true,
    "promptSections": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier. Used for directory name and RPC routing. |
| `displayName` | string | Human-readable name shown in UI. |
| `version` | string | Semver version. |
| `onStartup` | boolean | If true, plugin activates when the app starts. Otherwise activated on demand. |
| `contributes.tools` | string[] | Tool names this plugin registers. Declaration only — actual registration happens in `extension.js`. |
| `contributes.pages` | string[] | Page IDs for frontend contributions. |
| `kernelOverrides` | object | Declares which kernel extension points this plugin replaces (see below). |

### extension.js

The entry point that the plugin host imports. It must export an `activate` function and may export a `deactivate` function.

```js
// Called when the plugin is loaded
export async function activate(anoclaw) {
  // anoclaw is the PluginAPI object — see full API below

  // Register a tool
  await anoclaw.tools.register({
    name: 'WeatherTool',
    displayName: 'Weather',
    description: 'Get current weather for a city',
    parametersSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    },
    category: 'Plugin',
  });

  // Register a slash command
  await anoclaw.commands.register({
    name: 'weather',
    displayName: '/weather',
    description: 'Check the weather',
  });

  // Log (fire-and-forget)
  anoclaw.log.info('WeatherPlugin activated');
}

// Optional: called when the plugin is unloaded or reloaded
export async function deactivate(anoclaw) {
  // Cleanup — close connections, release resources
}
```

### Plugin API Reference

The `anoclaw` object passed to `activate()` provides these capabilities:

#### Tools

```js
// Register a tool — immediately available to all agents with matching allowedTools
await anoclaw.tools.register({
  name: 'MyTool',                    // Unique tool name
  displayName: 'My Tool',            // UI label
  description: 'What it does',       // Shown to the LLM
  parametersSchema: {                // JSON Schema for parameters
    type: 'object',
    properties: {
      param1: { type: 'string', description: '...' },
    },
    required: ['param1'],
  },
  category: 'Plugin',               // Grouping in the edit panel
});
```

If the tool requires execution logic, the plugin's `extension.js` can handle it by listening for tool execution calls via the RPC bridge. The tool's execution handler runs on the main thread via `ToolRegistry`, which forwards execution requests to the plugin worker.

#### Frontend Pages

Plugins can contribute full HTML pages that appear in the app's navigation dock:

```js
await anoclaw.pages.register({
  id: 'my-dashboard',
  title: 'Dashboard',
  htmlPath: 'frontend/index.html',   // Relative to plugin directory
  order: 10,                         // Position in navigation
});
```

The page is rendered in an **iframe sandbox** with a `postMessage` bridge. The page communicates with the main app via the `window.anoclaw` API:

```html
<!-- frontend/index.html -->
<script>
  // Call internal API from the page
  const agents = await window.anoclaw.api.call('GET', '/api/v1/agents');

  // Listen for events
  window.anoclaw.on('agent_registered', (data) => {
    console.log('Agent registered:', data.agentId);
  });
</script>
```

#### REST API Endpoints

Plugins can register their own HTTP endpoints:

```js
await anoclaw.api.registerRoute({
  method: 'GET',
  path: '/api/v1/my-plugin/data',
  handler: async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  },
});
```

#### Kernel Extension Points (8 Hooks)

Plugins can override core system behaviors by declaring `kernelOverrides` in `plugin.json` and implementing the hook:

| Hook | Purpose | Signature |
|------|---------|-----------|
| `promptAssembler` | Replace the prompt assembly logic | `(messages, context) → string` |
| `promptSections` | Inject custom sections into system prompt | `() → PromptSection[]` |
| `memoryStore` | Replace memory storage backend | `implements IMemoryStore` |
| `sessionStore` | Replace session persistence | `implements ISessionRepository` |
| `settingsStore` | Replace settings persistence | `implements ISettingsStore` |
| `llmProvider` | Replace the LLM provider | `implements ILLMProvider` |
| `toolExecutor` | Intercept tool execution | `(name, args, ctx) → ToolResult` |
| `agentLoop` | Replace the agent ReAct loop | `(config) → AsyncGenerator<SSEEvent>` |

Example — override the LLM provider to add a custom model:

```js
// plugin.json
{
  "kernelOverrides": { "llmProvider": true }
}

// extension.js
export async function activate(anoclaw) {
  await anoclaw.kernel.override('llmProvider', {
    chat: async (messages, options) => {
      // Your custom LLM call
      return { content: '...', role: 'assistant' };
    },
    chatStream: async function* (messages, options) {
      // Custom streaming implementation
    },
  });
}
```

#### Commands (Slash Commands)

```js
await anoclaw.commands.register({
  name: 'my-command',
  displayName: '/my-command',
  description: 'What the command does',
  args: [
    { name: 'query', description: 'Search term', required: true, type: 'string' },
  ],
});
```

#### Skills

Plugins can contribute markdown skills that are injected into the agent's system prompt:

```js
await anoclaw.skills.register({
  name: 'my-skill',
  description: 'A reusable skill',
  content: '# My Skill\n\nInstructions...',
});
```

### Plugin Lifecycle

```
PluginHostManager.start()
    │
    ▼
Worker Thread spawned
    │
    ▼
PluginHost reads plugins/ directory
    │
    ▼
For each plugin with onStartup=true:
    │
    ├── Parse plugin.json (validate schema)
    ├── import(extension.js)
    ├── Call activate(anoclaw)
    │     └── Plugin registers tools/pages via RPC
    └── Plugin is now active
    │
    ▼
File watcher monitors plugins/ directory
    │
    ├── New directory detected → activate plugin
    └── Directory removed → deactivate plugin
```

### Plugin Management via REST API

```
GET    /api/v1/plugins             — List all plugins with status
POST   /api/v1/plugins/reload      — Reload a specific plugin
DELETE /api/v1/plugins/:name       — Uninstall (renames to .disabled)
POST   /api/v1/plugins/install     — Install from a GitHub URL
```

Plugins can also be toggled on/off from the Plugins page in the UI without restarting the app.

### Plugin Frontend Communication Model

```
┌──────────────────────────────────────────────────┐
│                  Main App                        │
│  ┌─────────────┐    ┌─────────────────────────┐  │
│  │  Page Area   │    │  Navigation Dock        │  │
│  │  ┌─────────┐│    │  KERNEL | plugins       │  │
│  │  │ iframe  ││    │  ├── Sessions            │  │
│  │  │ sandbox ││    │  ├── Agents              │  │
│  │  │         ││    │  ├── ...                 │  │
│  │  │postMesg ││    │  └── My Plugin Page ◄── │  │
│  │  └─────────┘│    └─────────────────────────┘  │
│  └─────────────┘                                  │
└──────────────────────────────────────────────────┘
         │ postMessage bridge
┌────────┴──────────────────────────────────────────┐
│  iframe (isolated origin)                         │
│  window.anoclaw.api.call()                        │
│  window.anoclaw.on()                              │
└───────────────────────────────────────────────────┘
```

The iframe is sandboxed (`allow-scripts allow-same-origin`) and communicates with the main page through a structured `postMessage` protocol. This means plugin frontends cannot access the main page's DOM, but they can call any internal API endpoint and receive events.

### Development Workflow

1. Create `plugins/my-plugin/plugin.json` and `extension.js`
2. Restart the app, or call `POST /api/v1/plugins/reload { "name": "my-plugin" }`
3. Check the plugin status: `GET /api/v1/plugins`
4. If the plugin fails, check the logs — the error message is shown in the Plugins page UI
5. Iterate: edit → reload → verify

No kernel rebuild needed. No TypeScript compilation required for plugin code (plain JavaScript, ESM format).

### When Plugin Host Fails

Plugin startup is wrapped in try-catch at every level:
- If a single plugin fails to load, other plugins still activate
- If the entire Worker crashes, it restarts automatically
- If the Worker repeatedly crashes, the app continues with a warning logged
- The app functions normally with zero plugins installed

## Build & Test

### Two TypeScript Compilations

```
Root tsconfig.json          → dist/       (server: src/server + src/shared)
src/public/tsconfig.json    → src/public/js/  (frontend: src/public/ts)
```

Always run `npm run build:all` if both layers changed.

### Full Build Pipeline

```bash
# 1. Compile server
npx tsc --project tsconfig.json

# 2. Copy Electron bridge files (CJS compatibility)
node -e "require('fs').cpSync('src/electron/bridge.js','dist/electron/bridge.cjs'); require('fs').cpSync('src/electron/preload.cjs','dist/electron/preload.cjs');"

# 3. Vendor assets (Monaco editor, d3-force)
node scripts/copy-monaco.js
node scripts/copy-vendor.js

# 4. Compile frontend
cd src/public && npx tsc -p tsconfig.json && cd ../..

# 5. Bundle CSS + icons
node scripts/bundle-css.js
node scripts/build-icons.js

# 6. Package
npx electron-builder --win
```

### Testing

```bash
npm test                          # Full suite (~704 tests)
npm run test:watch                # Watch mode
npx vitest run src/server/core/<module>/__tests__/  # Targeted
```

Tests are colocated: `src/server/core/*/__tests__/*.test.ts`.

## Configuration

Created by the setup wizard on first launch:

```
config/settings.yaml
```

| Field | Description |
|-------|-------------|
| `port` | HTTP server port (default: 3456) |
| `apiPort` | REST API port (default: 15730) |
| `provider` | LLM provider (`cloud_api` or `ollama`) |
| `apiUrl` | LLM API endpoint URL |
| `apiKey` | LLM API key (encrypted at rest) |
| `model` | Model identifier (e.g., `deepseek-chat`, `claude-sonnet-4-6`) |

Agent-specific overrides are in `config/settings.yaml` under `agents` and can also be set per-agent in `data/agents/<id>.json`.

### LLM Provider Options

| Provider | Type | Config |
|----------|------|--------|
| DeepSeek | OpenAI-compatible | `provider: cloud_api`, `url: https://api.deepseek.com` |
| Anthropic (Claude) | Via compatible endpoint | Use any proxy that translates Anthropic → OpenAI format |
| Ollama | Local | `provider: ollama`, no API key needed |

## Storage

No database. All data is flat files:

```
data/
├── agents/<id>.json             # Agent config (model, tools, prompt, apiKey encrypted)
├── sessions/<id>/
│   ├── shard_NNNNNN.jsonl       # Conversation history (10K lines / 10MB per shard)
│   └── meta.json                # Session metadata
└── talent-pool/
    ├── groups.json              # Domain group definitions
    └── templates/<id>.json      # Agent templates (system prompt, model, tools)
```

## Data Flow

### Message Lifecycle

1. **Client → Server**: WebSocket `send_message { sessionId, agentId, message }`
2. **Server → LLM**: `AgentRuntime.processMessage()` → `AgentLoop.run()` → `LLMProvider.chat()`
3. **AgentLoop** executes ReAct loop:
   - Build system prompt (via `PromptAssembler` — combines agent identity, skills, tools, memory, etc.)
   - Call LLM, stream response (text/think/tool_use events)
   - For each tool call: `ToolRegistry.execute()` → append result → continue loop
   - Stall detection: if no tool calls for N turns, or consecutive failures → abort
   - Context compression: if >70% of context window used → compact
4. **Server → Client**: SSE-like events pushed via WebSocket (text_delta, think_delta, tool_call, tool_result, done)
5. **Persistence**: Both user and assistant messages appended to JSONL on completion

### Tool Execution

33 built-in tools in `src/server/core/tools/builtin/`, auto-registered via directory scan. Each tool extends `Tool` (EventEmitter). Tools are whitelisted per-agent via `allowedTools`.

### Context Compression

When conversation reaches 70% of context window, `ContextCompressor`:
1. Summarizes earlier exchanges
2. Replaces raw content with summaries, preserving the latest messages intact
3. Keeps tool results in compressed form (head/tail)

## Known Issues & Limitations

### Layout

- **d3-force simulation restarts** when agents are added/deleted. The simulation uses saved positions to recover, but there's a brief visual settle animation.
- **Node positions** are stored in `sessionStorage` (not persisted across browser sessions). Close/reopen may reset positions.
- **Manager columns** are computed from agent creation order, not configurable.

### Build

- **`npm run dev` fails in bash** — `start-electron.bat` is a Windows batch file. Always use the build+package workflow described above.
- **Frontend has no path aliases** — unlike server code (`@shared/*`, `@server/*`), the frontend uses only relative imports.
- **Plugin frontend builds** will fail if the `plugins/` directory is missing — but the server itself handles this gracefully (warns and continues).

### Frontend

- **No React/Vue** — the frontend uses pure TypeScript with native DOM APIs. All state management is through EventEmitter-based ViewModels.
- **CSS uses custom properties** in `:root` for dark theme. Light theme via `[data-theme="light"]` overrides. No CSS framework.
- **Icons are SVG only** — no emoji in UI (per project convention).

### LLM Provider

- **DeepSeek-specific**: All API messages MUST have a `role` field (including tool results). The `sanitizeOrphanedMessages()` in `AgentLoopLLM.ts` handles this — never remove it.
- **DeepSeek does not support** `image_url` content type.
- **Rate limiting**: `APIScheduler` handles RPM/TPM globally. Configured in `AgentConfig`.

### Plugin System

- **5 demo plugins included** in `plugins/` — ComfyUI, Gateway, MCP, Meeting, Workflow. These are functional reference implementations you can study, modify, and learn from.
- **Plugin system is present and functional** — includes the complete Worker Thread plugin host runtime.
- **Module boundary check** is available via `node scripts/check-module-boundaries.cjs` to verify plugin isolation rules.

### Events

- One test in `EventSubscriptionManager.test.ts` is **flakey** (one-shot subscription timing). ~704/705 tests pass reliably.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js, ESM (`"type": "module"`) |
| Desktop shell | Electron 42 |
| Frontend | Pure TypeScript + DOM (no framework) |
| HTTP | Raw `http` module (no Express) |
| WebSocket | `ws` library |
| Storage | JSONL append-only (no database) |
| LLM API | OpenAI-compatible format |
| Testing | Vitest |
| Build | TypeScript compiler (no bundler for server) |
| Icons | Inline SVG |

## Common Tasks

### Add a New Built-in Tool

1. Create `src/server/core/tools/builtin/YourTool.ts` extending `Tool`
2. Implement `name()`, `description()`, `parametersSchema()`, `execute()`
3. Rebuild (`npm run build`) — auto-registers via directory scan

### Add a New WebSocket Message Handler

1. Create `src/server/infra/network/handlers/YourHandler.ts`
2. Register in `registerAllHandlers.ts`
3. Client sends `{ type: "your_message", ...payload }`

### Add a New HTTP Route

1. Create `src/server/gateway/routes/YourRoute.ts` implementing `RouteHandler`
2. Register in `src/server/gateway/routes/registerAllRoutes.ts`

### Add a New Slash Command

1. Create `src/server/core/commands/builtin/YourCommand.ts` extending `Command`
2. Auto-registers via directory scan

## Built-in Agent Templates (40+)

| Domain | Templates (all with full system prompts) |
|--------|------------------------------------------|
| **Software Engineering** | Senior Frontend Engineer, Backend Architect, Full-Stack Developer, DevOps Engineer, Code Reviewer, Mobile Developer, Database Administrator, Security Engineer |
| **Data Science** | Data Scientist, Data Analyst, Machine Learning Engineer, AI Researcher |
| **Marketing** | Content Marketing Specialist, SEO Expert, Social Media Manager, Brand Strategist |
| **Business & Strategy** | Product Manager, Business Analyst, Project Manager, Startup Advisor |
| **Finance** | Financial Analyst, Accounting & Audit, Quantitative Trader |
| **Legal** | Legal Counsel, Contract Review Specialist, IP Advisor |
| **Education** | Subject Tutor, Academic Writing Consultant, Language Teacher, Course Designer |
| **Creative Design** | UI/UX Designer, Creative Copywriter, Video Producer, Graphic Designer |
| **Human Resources** | Recruitment Specialist, Performance Management, Organization Development Consultant |
| **Customer Success** | Customer Success Manager, Technical Support Engineer, Customer Experience Designer |

## License

MIT
