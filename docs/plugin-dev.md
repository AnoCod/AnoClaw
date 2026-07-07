# AnoClaw 插件开发指南

> 面向想扩展 AnoClaw 的用户、开发者和 agent。完整接口见 [plugin-api.md](plugin-api.md)，UI 规范见 [plugin-ui-guide.md](plugin-ui-guide.md)。

## 插件是什么

AnoClaw 插件是运行在独立 Worker Thread 中的扩展包。它可以给 agent 增加工具、页面、HTTP 路由、事件监听、提示词注入和内核扩展点。插件代码放在 `plugins/<name>/`，每个插件至少包含：

```text
plugins/<name>/
├── plugin.json
└── extension.js
```

常见可选目录：

```text
plugins/<name>/
├── frontend/index.html      # 插件页面，显示在左上 PAGES 导航里
├── skills/<skill>/SKILL.md  # 插件附带技能
└── data/                    # 插件运行时数据，由平台自动创建
```

## 当前运行模型

- 每个插件一个 Worker Thread，插件崩溃不会直接拖垮主线程或其他插件。
- `PluginHostManager` 启动时会扫描 `plugins/` 并为有效插件启动 Worker。
- 文件变化会触发 1 秒防抖热重载。
- `.ts` / `.tsx` 入口会通过 esbuild 编译到 `.compile-cache/` 后加载。
- 插件工具执行、插件路由处理和主线程 RPC 默认都有 30 秒级别的超时保护。
- 工具和 LLM 返回会在约 50,000 字符处截断，避免把 agent 上下文撑爆。

`activationEvents` 当前主要作为 manifest 元数据和兼容字段使用。推荐写 `["onStartup"]`，不要依赖 `[]` 阻止自动激活。

## 最小可用插件

创建 `plugins/hello-world/plugin.json`：

```json
{
  "name": "hello-world",
  "displayName": "Hello World",
  "version": "1.0.0",
  "description": "A tiny demo plugin",
  "publisher": "local",
  "main": "extension.js",
  "activationEvents": ["onStartup"],
  "contributes": {
    "tools": [{ "name": "helloWorld" }]
  },
  "engines": { "anoclaw": ">=2.0.0" }
}
```

创建 `plugins/hello-world/extension.js`：

```javascript
const { PluginBase } = globalThis;

export default class HelloWorldPlugin extends PluginBase {
  async onload() {
    await this.registerTool({
      name: 'helloWorld',
      description: 'Say hello to a named person.',
      parametersSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Person to greet' }
        },
        required: ['name']
      }
    });
  }

  async onToolExecute(toolName, params) {
    if (toolName !== 'helloWorld') {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return `Hello, ${params.name}!`;
  }
}
```

保存后等待 1 到 2 秒，查看插件状态：

```bash
curl http://127.0.0.1:3456/api/v1/plugins
```

在 agent 内部也可以用 `ApiCall`：

```json
{ "method": "GET", "path": "/api/v1/plugins" }
```

## 推荐：类式插件

类式插件继承 `PluginBase`，适合长期维护。

```javascript
const { PluginBase } = globalThis;

let pluginInstance = null;

export default class MyPlugin extends PluginBase {
  async onload() {
    pluginInstance = this;
    this.api.log.info('activating');

    await this.registerTool({
      name: 'myPluginSearch',
      description: 'Search my plugin data by keyword.',
      parametersSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keyword' },
          limit: { type: 'number', description: 'Maximum number of results' }
        },
        required: ['query']
      },
      category: 'Plugin'
    });

    await this.registerRoute('GET', '/api/v1/plugins/my-plugin/status', 'getStatus');
    this.onEvent('session:created', this._onSessionCreated.bind(this));
  }

  async onToolExecute(toolName, params, ctx) {
    if (toolName !== 'myPluginSearch') {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return JSON.stringify({
      query: params.query,
      workspace: ctx?.workspace || process.cwd(),
      results: []
    }, null, 2);
  }

  _onSessionCreated(payload) {
    this.api.log.info(`session created: ${JSON.stringify(payload)}`);
  }

  async onunload() {
    pluginInstance = null;
    this.api.log.info('deactivated');
  }
}

export async function getStatus() {
  return { status: 200, body: { ok: true, plugin: pluginInstance?.name || 'my-plugin' } };
}
```

关键规则：

- 必须使用 `const { PluginBase } = globalThis;`，不要从 `src/server/...` 直接 import。
- `onload()` 注册工具、路由、事件和提示词，保持快速返回。
- `onToolExecute()` 必须返回字符串；结构化结果用 `JSON.stringify(value, null, 2)`。
- `this.onEvent()` 和 `this.injectPrompt()` 会在 unload 时自动清理。
- `this.loadData()` / `this.saveData()` 使用 memory 系统保存简单 JSON 状态。

## 仍支持：函数式插件

函数式插件适合最小 demo 或迁移旧插件。

```javascript
export async function activate(anoclaw) {
  await anoclaw.tools.register({
    name: 'legacyEcho',
    description: 'Echo input text.',
    parametersSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  });

  return [{
    dispose() {
      anoclaw.log.info('legacy plugin disposed');
    }
  }];
}

export async function executeTool(toolName, params) {
  if (toolName !== 'legacyEcho') throw new Error(`Unknown tool: ${toolName}`);
  return String(params.text || '');
}

export async function deactivate() {}
```

## manifest 字段

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "publisher": "your-name",
  "main": "extension.js",
  "activationEvents": ["onStartup"],
  "contributes": {
    "tools": [{ "name": "myPluginSearch" }],
    "pages": [
      { "id": "my-plugin", "title": "My Plugin", "html": "frontend/index.html", "order": 20 }
    ],
    "skills": [],
    "commands": [],
    "configuration": {
      "title": "My Plugin",
      "properties": {
        "apiKey": { "type": "string", "default": "", "description": "Optional API key" }
      }
    },
    "apiRoutes": [
      { "method": "GET", "path": "/api/v1/plugins/my-plugin/status" }
    ],
    "overrides": {}
  },
  "engines": { "anoclaw": ">=2.0.0" }
}
```

| 字段 | 建议 | 说明 |
|---|---|---|
| `name` | 必填 | 插件目录名与唯一标识，使用 kebab-case |
| `displayName` | 推荐 | UI 中显示的名称 |
| `version` | 推荐 | 语义化版本 |
| `main` | 必填 | 入口文件，相对插件根目录，可为 `.js` / `.ts` |
| `activationEvents` | 推荐 | 当前推荐 `["onStartup"]` |
| `contributes.tools` | 推荐 | 给 UI/诊断看的声明；真正注册仍在代码中完成 |
| `contributes.pages` | 可选 | 插件页面，渲染在沙盒 iframe |
| `contributes.configuration` | 可选 | 插件配置 schema |
| `contributes.apiRoutes` | 可选 | 插件自有 HTTP 路由声明 |
| `contributes.overrides` | 高级 | 内核扩展点覆盖，谨慎使用 |

## 注册工具

工具描述会进入 agent 的工具列表。描述越具体，agent 越容易在正确时机调用。

```javascript
await this.registerTool({
  name: 'extractInvoice',
  description: 'Extract invoice fields from a text file and return normalized JSON.',
  parametersSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Invoice text file path inside workspace' }
    },
    required: ['filePath']
  },
  category: 'Documents'
});
```

工具实现建议：

- 校验入参，不要让模糊输入静默失败。
- 返回短而结构化的结果，长结果保存到文件后返回路径。
- 出错时抛 `Error`，让 agent 看见真实原因。
- 工具名全局唯一；推荐加业务前缀，例如 `invoiceExtract`。

## 注册 HTTP 路由

类式插件也必须把路由 handler 作为模块级导出。`PluginHost` 当前按导出函数名查找 handler，不会调用 class 实例方法。

```javascript
const { PluginBase } = globalThis;
let pluginInstance = null;

export default class MyPlugin extends PluginBase {
  async onload() {
    pluginInstance = this;
    await this.registerRoute('POST', '/api/v1/plugins/my-plugin/run', 'run');
  }

  async onunload() {
    pluginInstance = null;
  }
}

export async function run(req) {
  return {
    status: 200,
    body: {
      ok: true,
      plugin: pluginInstance?.name || 'my-plugin',
      input: req.body
    }
  };
}
```

函数式：

```javascript
export async function activate(api) {
  await api.routes.register([
    { method: 'GET', path: '/api/v1/plugins/my-plugin/status', handler: 'getStatus' }
  ]);
}

export async function getStatus(req) {
  return { status: 200, body: { ok: true, query: req.query } };
}
```

路由处理函数返回 `{ status, body }`。路径建议放在 `/api/v1/plugins/<plugin-name>/...` 下，避免和内核 API 冲突。

## 插件页面

在 `plugin.json` 声明页面：

```json
{
  "contributes": {
    "pages": [
      { "id": "my-plugin", "title": "My Plugin", "html": "frontend/index.html", "order": 20 }
    ]
  }
}
```

页面运行在 iframe 沙盒中，平台会注入：

- `css/tokens.css`
- `css/plugin-raycast.css`
- `anoclaw-ui.js`
- `plugin-raycast.js`
- 主题同步消息：`anoclaw:theme`
- ConfirmDialog 桥接：`anoclaw:dialog:confirm`
- Session handoff 桥接：`anoclaw:session:handoff`

最小页面：

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>My Plugin</title>
</head>
<body>
  <main class="plugin-page">
    <h1>My Plugin</h1>
    <div id="app"></div>
  </main>
  <script>
    const btn = new anoclaw.ui.Button({
      label: 'Refresh',
      variant: 'primary',
      onClick: () => console.log('refresh')
    });
    document.getElementById('app').appendChild(btn.element);

    window.addEventListener('message', event => {
      if (event.data?.type === 'anoclaw:theme') {
        document.documentElement.setAttribute('data-theme', event.data.theme);
        document.documentElement.setAttribute('data-accent', event.data.accent);
      }
    });
  </script>
</body>
</html>
```

## 数据保存

轻量插件状态可以用 `PluginBase`：

```javascript
const data = await this.loadData();
data.lastRunAt = new Date().toISOString();
await this.saveData(data);
```

需要由前端或外部调用读写的配置，使用插件配置/存储 API：

```bash
curl http://127.0.0.1:3456/api/v1/plugins/my-plugin/config
curl -X PUT http://127.0.0.1:3456/api/v1/plugins/my-plugin/storage/cache \
  -H "Content-Type: application/json" \
  -d '{"value":{"items":[]}}'
```

## 事件监听

插件可以订阅 `TypedEventBus` 事件：

```javascript
this.onEvent('tool:execution_completed', payload => {
  this.api.log.info(`tool completed: ${JSON.stringify(payload)}`);
});
```

高价值事件：

- `session:created`
- `session:message_appended`
- `session:workspace_changed`
- `tool:execution_started`
- `tool:execution_completed`
- `loop:completed`
- `llm:token_usage`
- `memory:changed`
- `skill:changed`
- `delegation:started`
- `delegation:completed`
- `plugin:load_failed`

完整事件类型见源码 `src/shared/types/events.ts`。

## 调用内核能力

插件内通过 `this.api` 或函数式 `api` 调用平台能力：

```javascript
const tools = await this.api.api.call('GET', '/api/v1/tools');
const answer = await this.api.llm.chat([
  { role: 'system', content: 'Be concise.' },
  { role: 'user', content: 'Summarize this.' }
]);
const files = await this.api.fs.glob('src/**/*.ts');
const memories = await this.api.memory.search('plugin notes', { scope: 'team', limit: 5 });
```

注意：

- `api.fs` 会把路径解析到 workspace 内，拒绝路径穿越。
- 不要在插件中直接 import 内核 singleton；使用 `api.*`。
- `api.tools.execute()` 可以执行已注册工具，但执行上下文是 `plugin:<name>`。

## 调试流程

1. 保存插件文件，等待热重载。
2. 查看插件状态：

```bash
curl http://127.0.0.1:3456/api/v1/plugins
curl http://127.0.0.1:3456/api/v1/plugins/my-plugin
```

3. 查看日志：

```bash
tail -80 logs/anochat.plugins.log
```

4. 手动重载：

```bash
curl -X POST http://127.0.0.1:3456/api/v1/plugins/reload \
  -H "Content-Type: application/json" \
  -d '{"name":"my-plugin","action":"reload"}'
```

`action` 支持 `activate`、`deactivate`、`reload`。省略时默认 reload。

5. `.ts` 入口异常时删除编译缓存：

```bash
rm -rf plugins/my-plugin/.compile-cache/
```

## 常见问题

| 现象 | 优先检查 |
|---|---|
| 插件不出现在列表 | `plugin.json` 是否存在，`name` 和 `main` 是否正确 |
| 状态为 `error` | `/api/v1/plugins` 的 `errorMessage`，以及 `logs/anochat.plugins.log` |
| 工具不出现 | 是否在 `onload()` 中调用 `registerTool()`，工具名是否冲突 |
| 工具调用超时 | `onToolExecute()` 是否超过 30 秒，是否在等待不可达服务 |
| 页面空白 | iframe 控制台、相对路径是否被正确解析、JS 是否报错 |
| UI 样式不一致 | 是否使用 `tokens.css` 变量，是否手写了和主题冲突的颜色 |
| 热重载没有发生 | 文件是否在 `plugins/<name>/` 下，是否以 `.` 开头或 `.disabled` 结尾 |
| 路由 500 | handler 是否导出，返回格式是否是 `{ status, body }` |

## 交付清单

完成插件前检查：

- `plugin.json` 合法，插件名唯一。
- 工具名唯一，描述清楚，schema 能约束参数。
- 工具返回可读字符串，长内容有截断或文件输出策略。
- 页面在深色/浅色主题下都可读。
- 插件错误能在日志中定位。
- 没有把密钥、token、用户隐私写入仓库文档或日志。
- 文档需要给 agent 使用时，同步更新 `docs/README.md` 或 `docs/manifest.json`。
