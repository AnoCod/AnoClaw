# AnoClaw Plugin API Reference

> 本文按当前源码校准：`src/server/core/plugin-host/PluginAPI.ts`、`PluginBase.ts`、`PluginRPC.ts`、`RpcDispatcher.ts`、`PluginHostManager.ts`。

## 运行边界

插件运行在 Worker Thread 中，不能直接访问主线程对象、内核 singleton 或其他插件内存。所有能力通过 `api` 对象走 MessageChannel RPC：

```text
extension.js / extension.ts
  -> PluginAPI.ts in Worker
  -> MessageChannel RPC
  -> RpcDispatcher.ts in main thread
  -> ToolRegistry / ApiServer / LLM / Memory / WsServer
```

关键限制：

- 激活超时：约 15 秒。
- 工具执行超时：约 30 秒。
- 主线程 RPC 超时：约 30 秒。
- 工具/LLM 输出截断：约 50,000 字符。
- `api.fs` 路径必须在 workspace 内。
- `docs/` 和 `skills/` 在发布包中解包，适合 agent 读取，但插件不要把运行时状态写到这些目录。

## AnoClawAPI

插件收到的 `api` 对象类型：

```typescript
interface AnoClawAPI {
  tools: {
    register(toolDef: PluginToolDefinition): Promise<void>;
    execute(name: string, params: Record<string, unknown>): Promise<string>;
  };
  api: {
    call(method: string, path: string, body?: Record<string, unknown>): Promise<ApiCallResult>;
  };
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  context: {
    pluginName: string;
    pluginPath: string;
    storagePath: string;
  };
  routes: {
    register(routes: PluginRouteDef[]): Promise<void>;
  };
  llm: {
    chat(messages: PluginLLMMessage[], options?: PluginLLMOptions): Promise<PluginLLMResponse>;
  };
  fs: {
    read(path: string, sessionId?: string): Promise<string>;
    write(path: string, content: string, sessionId?: string): Promise<void>;
    grep(pattern: string, glob?: string, sessionId?: string): Promise<PluginGrepMatch[]>;
    glob(pattern: string, sessionId?: string): Promise<string[]>;
  };
  memory: {
    search(query: string, options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]>;
    save(entry: PluginMemorySaveInput): Promise<Record<string, unknown> | null>;
    list(options?: PluginMemorySearchOptions): Promise<Record<string, unknown>[]>;
    delete(name: string, options?: PluginMemorySearchOptions): Promise<void>;
  };
  events: {
    on(event: string, handler: (data: unknown) => void): void;
    off(event: string, handler: (data: unknown) => void): void;
  };
  ws: {
    broadcast(message: Record<string, unknown>): Promise<void>;
  };
  prompt: {
    inject(name: string, content: string, priority?: number): Promise<void>;
  };
  ui: {
    mount(slot: string, htmlContent: string, opts?: UiMountOptions): Promise<void>;
    unmountAll(slot: string): Promise<void>;
  };
}
```

## PluginBase

类式插件继承 `PluginBase`：

```javascript
const { PluginBase } = globalThis;

export default class MyPlugin extends PluginBase {
  async onload() {}
  async onunload() {}
  async onToolExecute(toolName, params, ctx) {
    return 'result';
  }
}
```

可用属性：

| 属性 | 类型 | 说明 |
|---|---|---|
| `this.api` | `AnoClawAPI` | 原始 API 对象 |
| `this.name` | `string` | manifest 中的插件名 |
| `this.pluginPath` | `string` | 插件根目录绝对路径 |
| `this.storagePath` | `string` | `plugins/<name>/data` |

可用方法：

| 方法 | 说明 |
|---|---|
| `registerTool(def)` | 注册 agent 可调用工具 |
| `registerRoute(method, path, handler)` | 注册插件 HTTP 路由 |
| `onEvent(event, handler)` | 订阅事件，unload 时自动取消 |
| `injectPrompt(name, content, priority?)` | 注入动态 prompt section，unload 时自动清理 |
| `loadData()` | 从 memory 中读取插件 JSON 数据 |
| `saveData(data?)` | 保存插件 JSON 数据到 memory |
| `addPage(id, title, htmlPath?, order?)` | 轻量辅助方法；生产页面仍推荐通过 `plugin.json` 声明 |

`registerRoute()` 的 `handler` 当前必须是模块级导出函数名。类式插件的实例方法不会被路由分发器直接调用；如需访问实例状态，可在模块级变量中保存实例引用。

## Manifest

```typescript
interface PluginManifest {
  name: string;
  displayName: string;
  version: string;
  description?: string;
  publisher?: string;
  main: string;
  activationEvents: string[];
  contributes?: {
    tools?: Array<{ name?: string }>;
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
  engines?: { anoclaw: string };
}
```

Loader 当前强校验 `name`、`main` 和入口文件存在。其他字段用于 UI、诊断、兼容和未来能力，仍建议完整填写。

## api.tools

### register

```javascript
await api.tools.register({
  name: 'myTool',
  description: 'Short, specific description used by agents.',
  parametersSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input text' }
    },
    required: ['input']
  },
  category: 'Plugin'
});
```

`PluginToolDefinition`：

```typescript
interface PluginToolDefinition {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  category?: string;
}
```

注册后主线程创建 `PluginToolProxy`，工具进入 `ToolRegistry`。

### execute

```javascript
const result = await api.tools.execute('Grep', {
  pattern: 'PluginBase',
  path: 'src/server/core/plugin-host'
});
```

返回字符串。底层会使用 `ToolRegistry.execute()`，上下文为：

```typescript
{
  sessionId: `plugin:${pluginName}`,
  agentId: `plugin:${pluginName}`,
  workspace: process.cwd()
}
```

## api.api

调用 AnoClaw 内部 REST API：

```javascript
const { statusCode, body } = await api.api.call('GET', '/api/v1/plugins');
```

`ApiCallResult`：

```typescript
interface ApiCallResult {
  statusCode: number;
  body: Record<string, unknown>;
}
```

常用端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/plugins` | 插件列表 |
| `GET` | `/api/v1/plugins/:name` | 插件详情 |
| `POST` | `/api/v1/plugins/reload` | `activate` / `deactivate` / `reload` |
| `GET` | `/api/v1/plugins/status` | PluginHost 状态 |
| `GET` | `/api/v1/plugins/extensions` | 已注册扩展点覆盖 |
| `GET` | `/api/v1/plugins/:name/config` | 插件配置 |
| `PUT` | `/api/v1/plugins/:name/config` | 写插件配置 |
| `GET` | `/api/v1/plugins/:name/storage` | 存储 key 列表 |
| `GET` | `/api/v1/plugins/:name/storage/:key` | 读存储 |
| `PUT` | `/api/v1/plugins/:name/storage/:key` | 写存储 |
| `GET` | `/api/v1/tools` | 已注册工具 |
| `POST` | `/api/v1/agents/execute` | 提交完整 agent 任务 |
| `GET` | `/api/v1/skills` | 技能列表 |
| `GET` | `/api/v1/memory/search?q=...` | 搜索记忆 |

## api.routes

```javascript
await api.routes.register([
  { method: 'GET', path: '/api/v1/plugins/my-plugin/status', handler: 'getStatus' },
  { method: 'POST', path: '/api/v1/plugins/my-plugin/run', handler: 'run' }
]);

export async function getStatus(req) {
  return { status: 200, body: { ok: true } };
}

export async function run(req) {
  return { status: 200, body: { received: req.body, query: req.query } };
}
```

`PluginRouteDef`：

```typescript
interface PluginRouteDef {
  method: string;
  path: string;
  handler: string;
}
```

handler 接收：

```typescript
{
  body: unknown;
  params: Record<string, string>;
  query: string;
}
```

handler 必须返回：

```typescript
{ status: number; body: object }
```

## api.llm

```javascript
const resp = await api.llm.chat([
  { role: 'system', content: 'You are concise.' },
  { role: 'user', content: 'Summarize this file.' }
], {
  model: 'deepseek-chat',
  temperature: 0.2,
  maxTokens: 1200
});
```

类型：

```typescript
interface PluginLLMMessage {
  role: string;
  content: string;
}

interface PluginLLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

interface PluginLLMResponse {
  content: string;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}
```

实现细节：

- `system` 消息会被合并成 system prompt。
- 非 `system` 消息作为对话消息传给 provider。
- 默认模型、API URL、key、temperature、maxTokens 来自 `SettingsManager`。
- 经过 `APIScheduler` 进行额度/并发调度。

## api.fs

```javascript
const text = await api.fs.read('README.md');
await api.fs.write('tmp/output.txt', text);
const matches = await api.fs.grep('TODO', 'src/**/*.ts');
const files = await api.fs.glob('plugins/**/*.json');
```

规则：

- 默认相对 `process.cwd()`，即 AnoClaw app root。
- 传入 `sessionId` 时，会优先解析到该 session 的 workspace。
- 解析后的路径必须仍在 workspace/root 内，否则抛错。
- `grep()` 返回 `{ file, line, content }[]`。
- `glob()` 返回字符串数组。

路径安全示例：

```javascript
await api.fs.read('../outside.txt'); // rejected
```

## api.memory

```javascript
await api.memory.save({
  name: 'my-plugin:cache',
  type: 'reference',
  description: 'Plugin cache metadata',
  content: JSON.stringify({ version: 1 }),
  scope: 'team'
});

const entries = await api.memory.search('cache', { scope: 'team', limit: 5 });
const all = await api.memory.list({ scope: 'team', limit: 20 });
await api.memory.delete('my-plugin:cache', { scope: 'team' });
```

类型：

```typescript
interface PluginMemorySaveInput {
  name: string;
  type: string;
  description: string;
  content: string;
  scope: string;
  sessionId?: string;
  subScope?: 'team' | 'personal';
}

interface PluginMemorySearchOptions {
  scope?: string;
  agentId?: string;
  sessionId?: string;
  subScope?: 'team' | 'personal';
  limit?: number;
  fuzzy?: boolean;
}
```

建议：

- 插件私有运行状态优先用插件 storage/config。
- 需要 agent 未来检索的长期事实才写 memory。
- 不要把临时缓存或大块数据写入 memory。

## api.events

```javascript
const handler = payload => {
  api.log.info(JSON.stringify(payload));
};

api.events.on('session:created', handler);
api.events.off('session:created', handler);
```

事件来自 `TypedEventBus.onAny()` 转发。常用事件：

| 事件 | Payload 摘要 |
|---|---|
| `session:created` | `{ sessionId, agentId, parentSessionId? }` |
| `session:message_appended` | `{ sessionId, messageId, role }` |
| `session:workspace_changed` | `{ sessionId, workspace }` |
| `tool:execution_started` | `{ sessionId, agentId, toolName }` |
| `tool:execution_completed` | `{ sessionId, agentId, toolName, success, durationMs, tokensUsed }` |
| `loop:completed` | `{ sessionId, agentId, turnCount, totalTokens }` |
| `loop:compaction_triggered` | `{ sessionId, beforeTokens, afterTokens }` |
| `llm:token_usage` | `{ sessionId, inputTokens, outputTokens, totalTokens }` |
| `memory:changed` | `{ action, name, scope }` |
| `skill:changed` | `{ action, name }` |
| `delegation:started` | `{ parentSessionId, subSessionId, subAgentId, taskSummary }` |
| `delegation:completed` | `{ parentSessionId, subSessionId, subAgentId, taskSummary, turnCount, elapsedMs }` |
| `agent:registered` | `{ agentId, role, name }` |
| `agent:config_updated` | `{ agentId, role, name }` |
| `task:completed` | `{ taskId, parentSessionId, parentAgentId, summary, content }` |
| `plugin:load_failed` | `{ pluginName, error }` |

完整类型见 `src/shared/types/events.ts`。

## api.ws

```javascript
await api.ws.broadcast({
  type: 'my-plugin:update',
  payload: { status: 'ready' }
});
```

所有已连接 WebSocket 客户端都会收到消息。面向插件页面时，建议使用带插件名前缀的 `type`，避免和内核消息冲突。

## api.prompt

```javascript
await api.prompt.inject(
  'routing',
  '# My Plugin Routing\n- Use myPluginSearch for local plugin data.',
  50
);
```

主线程实际 section 名称为：

```text
plugin:<pluginName>:<name>
```

注意：

- 注入内容会进入 agent 系统提示词。
- 类式 `this.injectPrompt()` 会在 unload 时注入空字符串进行清理。
- 只注入稳定、短、必要的规则。大篇知识应放入 `docs/`，需要流程能力时放入 `skills/`。

## api.ui

从 Worker 往前端命名插槽挂载 HTML：

```javascript
await api.ui.mount(
  'settings-bottom',
  '<section class="my-plugin-panel">Ready</section>',
  { position: 'append', id: 'my-plugin-status', priority: 50 }
);

await api.ui.unmountAll('settings-bottom');
```

`UiMountOptions`：

```typescript
interface UiMountOptions {
  position?: 'append' | 'prepend';
  replace?: boolean;
  id?: string;
  priority?: number;
}
```

常用插槽：

| 插槽 | 场景 |
|---|---|
| `titlebar-left` | 页面名旁边的小状态 |
| `titlebar-right` | 窗口控制按钮前的轻量控件 |
| `sessions-sidebar-top` | Session 列表上方过滤/操作 |
| `sessions-sidebar-bottom` | Session 列表底部补充操作 |
| `sessions-overfly` | Sessions 右侧弹层 |
| `settings-bottom` | 设置页附加配置 |
| `agents-toolbar` | Agents 页面工具栏 |

## 前端 iframe API

插件页面由 `PluginPageContainer` 加载，iframe sandbox：

```text
allow-scripts allow-forms allow-same-origin
```

注入资源：

- `css/tokens.css`
- `css/plugin-raycast.css`
- `anoclaw-ui.js`
- `plugin-raycast.js`

主题同步：

```javascript
window.addEventListener('message', event => {
  if (event.data?.type === 'anoclaw:theme') {
    document.documentElement.setAttribute('data-theme', event.data.theme);
    document.documentElement.setAttribute('data-accent', event.data.accent);
  }
});
```

ConfirmDialog：

```javascript
const id = crypto.randomUUID();
window.parent.postMessage({
  type: 'anoclaw:dialog:confirm',
  id,
  title: 'Confirm',
  message: 'Run action?'
}, '*');

window.addEventListener('message', event => {
  if (event.data?.type === 'anoclaw:dialog:result' && event.data.id === id) {
    console.log(event.data.result);
  }
});
```

Session handoff：

```javascript
window.parent.postMessage({
  type: 'anoclaw:session:handoff',
  id: crypto.randomUUID(),
  sessionId,
  prompt: 'Continue this task with the selected context.'
}, '*');
```

## anoclaw-ui.js

iframe 中可用：

```javascript
window.anoclaw.ui
```

当前独立 bundle 暴露组件：

| 类别 | 组件 |
|---|---|
| 基础 | `Button`, `Dialog`, `Toggle`, `Card`, `FormField`, `Input`, `Select`, `Textarea`, `Badge`, `Tooltip`, `Toast`, `Tabs`, `Progress`, `EmptyState`, `Spinner`, `ContextMenu` |
| 工具卡片 | `ToolCard`, `ToolCardResult`, `ToolCardDiff`, `ToolCardProgress`, `ToolCardError` |
| 特殊卡片 | `TodoCard`, `StatusCard`, `SystemCard` |

示例：

```javascript
const input = new anoclaw.ui.Input({ placeholder: 'Search' });
const button = new anoclaw.ui.Button({
  label: 'Run',
  variant: 'primary',
  onClick: () => console.log(input.value)
});

document.body.append(input.element, button.element);
```

## 内核扩展点

Manifest 中可声明：

```json
{
  "contributes": {
    "overrides": {
      "promptAssembler": "overrides/prompt.js",
      "memoryStore": null
    }
  }
}
```

有效扩展点来自 `ExtensionPoints.ts`：

- `promptAssembler`
- `memoryStore`
- `sessionStore`
- `settingsStore`
- `llmProvider`
- `toolExecutor`
- `agentLoop`

覆盖是全局能力，最后注册者优先生效。只有在明确需要替换内核行为时使用。

## 插件管理 API

```bash
curl http://127.0.0.1:3456/api/v1/plugins
curl http://127.0.0.1:3456/api/v1/plugins/status
curl http://127.0.0.1:3456/api/v1/plugins/extensions
curl http://127.0.0.1:3456/api/v1/plugins/my-plugin
```

重载：

```bash
curl -X POST http://127.0.0.1:3456/api/v1/plugins/reload \
  -H "Content-Type: application/json" \
  -d '{"name":"my-plugin","action":"reload"}'
```

卸载会把目录重命名为 `.disabled`：

```bash
curl -X DELETE http://127.0.0.1:3456/api/v1/plugins/my-plugin
```

## 故障排查速查

| 问题 | 检查 |
|---|---|
| `NO_ACTIVATE` | 函数式插件未导出 `activate`，类式插件未 default export `PluginBase` 子类 |
| `COMPILE_ERROR` | `.ts` / `.tsx` 入口 esbuild 编译失败 |
| `IMPORT_ERROR` | 入口文件 import 报错，常见于依赖缺失或路径错误 |
| `ACTIVATE_ERROR` | `onload()` / `activate()` 抛错或超时 |
| `EXECUTION_ERROR` | `onToolExecute()` / `executeTool()` 抛错 |
| `NO_HANDLER` | 路由 handler 未导出或名称不匹配 |
| 工具调用无响应 | 工具超时、插件 Worker 不 ready、插件已被重载 |
| `Path outside workspace` | `api.fs` 访问了 workspace 外路径 |

## 版本兼容建议

- 文档以 AnoClaw v2.x 当前源码为准。
- 插件应保守使用内核扩展点，优先使用公开 `api.*`。
- Manifest 多写元数据，未来 UI 和市场页可以直接消费。
- 所有用户可见文案保持简短，错误信息保留可定位的文件名、路由、工具名。
