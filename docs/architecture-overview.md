# AnoClaw 架构总览

> 面向需要理解系统结构、调试问题或开发插件/内核功能的用户和 agent。

## 总体结构

AnoClaw 是 Electron 打包的本地 Node.js 应用：

- 前端：`src/public/`，浏览器 SPA，无 React/Vue 运行时。
- 后端：`src/server/`，Node.js `http` + WebSocket。
- 桌面壳：`src/electron/`。
- 数据：JSONL append-only、JSON 配置、文件系统目录。
- 插件：`plugins/<name>/`，每个插件一个 Worker Thread。

## 四层模型

```text
Presentation
  src/public/ HTML/CSS/TS, plugin iframe pages
  ↓ HTTP + WebSocket
ViewModel
  src/public/ts/viewmodel/*
  ↓
Service
  AgentRuntime, AgentLoop, SessionManager, PromptAssembler, ToolRegistry
  ↓
Infrastructure
  LLMProvider, APIScheduler, JSONL storage, MCP, logging, WebSocket
```

## 两个 HTTP 服务

| 服务 | 端口 | 用途 |
|---|---|---|
| main server | `3456` | 静态文件、WebSocket、插件页面、部分 API |
| ApiServer | `15730` | 外部 agent 控制 API，localhost token 认证 |

`main.ts` 会处理插件管理、静态资源和 `/ws`。其他 `/api/*` 通常委托给 `ApiServer`。

## Agent 执行流

```text
用户发送消息
  -> WebSocket send_message
  -> SessionManager 读取/追加会话 JSONL
  -> AgentRuntime.processMessage()
  -> AgentLoop.run()
  -> PromptAssembler 组装系统提示词
  -> LLMProvider 流式返回文本/工具调用
  -> ToolRegistry 执行工具
  -> 事件经 WebSocket 推送到前端
  -> 助手回复写回 JSONL
```

`AgentLoop.run()` 是 `AsyncGenerator`，便于流式输出、工具调用和中断。

## Prompt 结构

Prompt 由多个 section 组成：

- 静态区：系统规则、docs 指引、插件开发简表等。
- agent 定义：MainAgent / Manager / Member 默认角色提示 + 自定义 agentPrompt。
- 可缓存动态区：工具列表、技能列表等。
- volatile 区：当前 session、权限模式、环境、memory、active task 等。

`DocsSection` 会告诉 agent 如何检索 `docs/`。`SkillsSection` 和 `MemorySection` 分别注入技能与记忆。

## ToolRegistry

内置工具从 `src/server/core/tools/builtin/*.ts` 扫描注册。插件工具通过 `PluginToolProxy` 注册。

执行链：

```text
AgentLoop
  -> ToolRegistry.execute()
  -> ToolPipeline.run()
  -> 参数校验 / 风险检查 / 执行 / 重试 / 输出规范化
```

工具按 agent 角色和 `allowedTools` 控制可用性。

## 插件系统

```text
PluginHostManager (main thread)
  -> spawn Worker for each plugin
  -> PluginHost loads plugin.json + extension.js/.ts
  -> plugin calls api.tools/register/routes/events/ui
  -> RpcDispatcher maps RPC to kernel services
```

插件隔离规则：

- 插件无法直接访问主线程内存。
- 插件通过 JSON-RPC over MessageChannel 通信。
- 插件崩溃会清理工具/事件订阅，并指数退避重启。
- 文件变化会触发热重载。

## 存储

| 路径 | 内容 | 注意 |
|---|---|---|
| `data/sessions/<id>/` | JSONL 会话 shard + meta | append-only，不手动改 shard |
| `data/agents/<id>.json` | agent 配置 | API key 加密保存 |
| `memory/` | team/agent memory | 长期事实与偏好 |
| `plugins/<name>/data/` | 插件数据 | 插件可读写 |
| `config/settings.yaml` | 应用设置 | 端口、模型、日志等 |
| `docs/` | agent-readable 知识库 | 通用参考，不存私人数据 |
| `skills/` | agent skills | 流程能力 |

## 打包后的路径

AnoClaw 使用 `app.asar`。运行时可写/需动态访问的目录会解包：

- `dist/`
- `node_modules/`
- `docs/`
- `plugins/`
- `skills/`

代码里使用 `writablePath(...)` 处理开发模式和打包模式差异。

## 常见调试入口

| 问题 | 入口 |
|---|---|
| prompt 中缺资料 | `src/server/core/prompt/sections/*` |
| agent 工具不可用 | `ToolRegistry`、agent `allowedTools`、工具 category/risk |
| 插件不加载 | `PluginLoader`、`PluginHost`、`PluginHostManager`、`logs/anochat.plugins.log` |
| API 路由不通 | `src/server/gateway/routes/*`、`main.ts` 委托逻辑 |
| WebSocket 没事件 | `WsServer`、`WsForwardSubscriber`、`TypedEventBus` |
| 会话历史异常 | `SessionManager`、`JsonlSessionRepository`、`data/sessions/` |
