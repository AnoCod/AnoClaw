# AnoClaw Plugin Development Guide

## Project Context

This is the **plugins directory** for AnoClaw, a multi-agent AI orchestration platform.
Each plugin runs in its own **Worker Thread** — fully isolated, crash-safe, hot-reloadable.

**Root workspace:** `F:\QoderSoft\AnoClaw\plugins`
**Core source:** `F:\QoderSoft\AnoClaw\dist\server\core\plugin-host\`
**Official docs:** `F:\QoderSoft\AnoClaw\docs\plugin-api.md` + `plugin-dev.md`

---

## Architecture — One Plugin, One Worker Thread

```
主线程                                    Worker 线程（每个插件一个）
─────────                                 ──────────────────────────────
ToolRegistry  ◄──── JSON-RPC ────►       ┌─ Worker: my-plugin ───────┐
  ├─ ToolPipeline                         │  onload()                 │
  └─ 32 builtin tools                     │  onToolExecute()          │
                                          │  anoclaw API 全能力       │
PromptAssembler                           └──────────────────────────┘
  └─ 21 prompt sections
                                          插件崩了 → 只有该插件重启
SessionManager     MemoryManager          其他插件 + 主线程 = 零影响
TypedEventBus      SettingsManager
WsServer           ApiServer
```

**Key invariants:**
- Plugins CANNOT access kernel singletons or `require` core modules
- All communication via JSON-RPC over MessageChannel
- Hot-reload: file change → 1s debounce → kill old Worker → spawn new Worker

---

## Plugin Structure

```
plugins/<name>/
├── plugin.json         # Manifest (required)
├── extension.js        # Backend entry (.js or .ts, required)
├── frontend/           # Frontend page (sandboxed iframe)
│   ├── index.html
│   ├── src/main.ts
│   └── bundle.js
├── adapters/           # Optional: platform adapters
├── skills/             # Optional: SKILL.md files
├── data/               # Runtime data (auto-created, read/write)
└── .compile-cache/     # TS compile cache (auto-generated)
```

---

## plugin.json — Complete Schema

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "version": "2.1.0",
  "description": "What this plugin does",
  "publisher": "anoclaw",
  "main": "extension.js",
  "activationEvents": ["onStartup"],
  "contributes": {
    "tools": [{ "name": "myTool" }],
    "pages": [
      { "id": "my-page", "title": "My Page", "html": "frontend/index.html", "order": 10 }
    ],
    "apiRoutes": [
      { "method": "GET", "path": "/api/v1/plugins/my-plugin/data" }
    ],
    "skills": [],
    "commands": [],
    "overrides": [],
    "configuration": {
      "title": "My Plugin Settings",
      "properties": {
        "apiKey": { "type": "string", "default": "", "description": "API key" }
      }
    }
  },
  "engines": { "anoclaw": ">=2.1.0" }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique ID, kebab-case |
| `displayName` | Yes | UI display name |
| `version` | Yes | SemVer |
| `main` | Yes | Entry file (.js or .ts) |
| `activationEvents` | Yes | `["onStartup"]` = auto-activate |
| `contributes.tools` | No | Tool names (hint for UI) |
| `contributes.pages` | No | Frontend pages (sandboxed iframe) |
| `contributes.apiRoutes` | No | HTTP routes |
| `contributes.configuration` | No | Config JSON Schema |

---

## Extension.js — PluginBase Pattern (Recommended)

```javascript
const { PluginBase } = globalThis;

export default class MyPlugin extends PluginBase {
  async onload() {
    this.api.log.info('activating');

    // Register AI agent tools
    await this.registerTool({
      name: 'myTool',
      description: 'What this tool does',
      parametersSchema: {
        type: 'object',
        properties: { input: { type: 'string', description: 'Input' } },
        required: ['input'],
      },
      category: 'Custom',
    });

    // Register HTTP routes
    await this.registerRoute('GET', '/api/v1/plugins/my-plugin/data', 'handleGetData');

    // Subscribe to kernel events (auto-unsubscribe on unload)
    this.onEvent('session:created', this._onSessionCreated);

    // Inject into agent system prompt
    await this.injectPrompt('my-rules', '## My Rules\n- Do X', 50);

    // Load persisted data
    const data = await this.loadData();
    this.api.log.info(`Boot count: ${data.bootCount || 0}`);
  }

  async onToolExecute(toolName, params, ctx) {
    // ctx = { sessionId, agentId, workspace } | null
    // MUST return string. 30s timeout.
    if (toolName === 'myTool') {
      return JSON.stringify({ success: true, result: params.input });
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // HTTP route handlers — must return { status, body }
  async handleGetData(req) {
    // req.body, req.params, req.query
    return { status: 200, body: { ok: true, data: [] } };
  }

  _onSessionCreated(data) {
    this.api.log.info(`New session: ${data.sessionId}`);
  }

  async onunload() {
    this.api.log.info('deactivated');
  }
}
```

---

## AnoClaw API Quick Reference

### Tools
```javascript
await this.registerTool({ name, description, parametersSchema, category? })
// onToolExecute must return Promise<string>
// 30s timeout, 50K char result truncation
```

### HTTP Routes
```javascript
await this.registerRoute('GET', '/api/v1/plugins/my-plugin/x', 'handlerName')
// Handler: async handlerName(req) => { status: 200, body: {...} }
// req.body, req.params, req.query
```

### LLM (unlimited, no rate limit)
```javascript
const resp = await this.api.llm.chat(messages, { model, temperature, maxTokens })
// Returns: { content, finishReason, usage }
```

### Internal HTTP API (no network overhead)
```javascript
const result = await this.api.api.call('GET', '/api/v1/agents')
// result.statusCode, result.body
```

### File System (workspace-scoped)
```javascript
await this.api.fs.read(path)
await this.api.fs.write(path, content)
await this.api.fs.grep(pattern, glob?)
await this.api.fs.glob(pattern)
```

### Persistent Storage
```javascript
await this.loadData()    // => Record<string, unknown>
await this.saveData(data)
// Or via api.memory:
await this.api.memory.save({ name, type, description, content, scope })
await this.api.memory.search(query, { scope, limit })
```

### Kernel Events (24 available)
```javascript
this.onEvent('session:created', handler)   // auto-unsubscribe on unload
this.onEvent('tool:execution_completed', handler)
this.onEvent('delegation:completed', handler)
// See docs/plugin-api.md for full list
```

### Prompt Injection
```javascript
await this.injectPrompt('my-rules', '## Rules\n- Do X', 50)
// priority: 0-100, higher = earlier in system prompt
```

### WebSocket Broadcast
```javascript
await this.api.ws.broadcast({ type: 'my-plugin:update', data: {...} })
```

### UI Slots (8 available)
```javascript
await this.api.ui.mount('settings-bottom', '<div>...</div>', { position: 'append' })
// Slots: titlebar-left, titlebar-right, sessions-sidebar-top/bottom,
//        sessions-overfly, settings-bottom, agents-toolbar
```

---

## Platform Protections (Invisible Armor)

| Protection | Description |
|------------|-------------|
| Thread isolation | One Worker per plugin. Crash = only that plugin restarts |
| Activation timeout | 15s max for `onload()` |
| Tool timeout | 30s max for `onToolExecute()` |
| Result truncation | 50K char cap, prevents OOM |
| Crash auto-restart | Exponential backoff (0.5s→1s→2s→...→30s cap) |
| Path traversal guard | `api.fs` enforces workspace scope |
| Error visibility | Plugin failures auto-inject into all active sessions |

---

## Frontend Pages (Sandboxed iframe)

Auto-injected:
1. `tokens.css` — all CSS design variables
2. `anoclaw-ui.js` — 25 reusable components on `window.anoclaw.ui`

### UI Components (25 total)

**Basic (16):** Button, Dialog, Toggle, Card, FormField, Input, Select, Textarea, Badge, Tooltip, Toast, Tabs, Progress, EmptyState, Spinner, ContextMenu

**Tool Cards (5):** ToolCard, ToolCardResult, ToolCardDiff, ToolCardProgress, ToolCardError

**Special Cards (4):** TodoCard, StatusCard, SystemCard, AskUserCard

```javascript
// Button
const btn = new anoclaw.ui.Button({ label: 'Save', variant: 'primary', onClick: () => {} });

// Card
new anoclaw.ui.Card({ content: element, interactive: true });

// Toast
new anoclaw.ui.Toast({ text: 'Saved!', type: 'success' });
```

Theme sync via postMessage:
```javascript
window.addEventListener('message', (e) => {
  if (e.data.type === 'anoclaw:theme') {
    document.documentElement.setAttribute('data-theme', e.data.theme);
  }
});
```

---

## Existing Plugins

| Plugin | Purpose | Key Patterns |
|--------|---------|--------------|
| `anoclaw-mcp` | MCP protocol | JSON-RPC engine, multi-transport (stdio/SSE/HTTP), auto-reconnect, health monitoring |
| `anoclaw-gateway` | Messaging gateway | Multi-adapter (Telegram, Feishu, WeChat), WebSocket |
| `anoclaw-meeting` | Multi-agent meetings | Round-robin discussion, summaries, action plans |

---

## Development Rules

1. **Plugin isolation** — Never modify core files. Plugins communicate via events/routes/tools.
2. **PluginBase import** — Use `const { PluginBase } = globalThis`, never import the base class file directly.
3. **onload() ≤ 15s** — Must return within 15 seconds or platform kills it.
4. **onToolExecute() ≤ 30s** — Must return string within 30 seconds.
5. **Result ≤ 50K chars** — Truncated otherwise.
6. **Handler return format** — HTTP handlers must return `{ status: number, body: object }`.
7. **Event auto-cleanup** — `this.onEvent()` auto-unsubscribes on unload.
8. **Hot reload** — Save file → 1s debounce → auto-reload. No restart needed.
9. **No core edits** — Plugins live in their own directory.
10. **Persist via loadData/saveData** — Don't roll your own storage.

---

## Design Standards (User Preferences)

- **极重颜值/交互/一致性** — UI must be polished, consistent across plugins
- **借鉴成功开源项目** — Borrow patterns from successful OSS, don't reinvent
- **后台操作须前端可视化** — All backend ops must have frontend visibility
- **暗箱操作不可接受** — No invisible/mysterious operations
- **先汇报再修** —发现问题先汇报，确认后再修
- **真实浏览器测试** — 不用API shortcut替代

---

## Build & Debug

```bash
# Check plugin status
curl http://127.0.0.1:3456/api/v1/plugins

# View logs
tail -30 logs/anochat.plugins.log

# Clear compile cache
rm -rf plugins/<name>/.compile-cache/

# Manual reload
curl -X POST http://127.0.0.1:3456/api/v1/plugins/reload \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-plugin"}'
```

---

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Plugin shows "error" | extension.js syntax error | Check logs |
| Agent can't find tool | Name conflict or not in onload() | Check tool name uniqueness |
| HTTP route 500 | Handler not exported or wrong return format | Return `{ status, body }` |
| Frontend blank | Missing sandbox permissions or JS error | Check iframe attributes |
| Hot reload not working | Stale compile cache | Delete `.compile-cache/` |
| Tool timeout | onToolExecute() > 30s | Optimize or split task |
